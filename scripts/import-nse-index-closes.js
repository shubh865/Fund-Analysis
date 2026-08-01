const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const { parseCsv } = require('./lib/csv');

const selectedIndices = new Set([
  'nifty auto', 'nifty bank', 'nifty financial services', 'nifty fmcg',
  'nifty it', 'nifty media', 'nifty metal', 'nifty pharma', 'nifty realty',
  'nifty oil & gas', 'nifty healthcare index', 'nifty consumer durables',
  'nifty capital goods', 'nifty power', 'nifty chemicals', 'nifty cement',
  'nifty telecommunications', 'nifty services sector',
]);

function requestedDate() {
  const value = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Pass an NSE trading date: npm run import:nse-index-closes -- YYYY-MM-DD');
  return value;
}

function sourceFor(date) {
  const [year, month, day] = date.split('-');
  return `https://nsearchives.nseindia.com/content/indices/ind_close_all_${day}${month}${year}.csv`;
}

function numeric(value) {
  const result = Number(String(value || '').replaceAll(',', '').trim());
  return Number.isFinite(result) ? result : null;
}

async function main() {
  const date = requestedDate();
  const sourceUrl = sourceFor(date);
  const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'MutualFundAnalytics/0.1 (local)' } });
  if (!response.ok) throw new Error(`NSE index-close report returned HTTP ${response.status} for ${date}. It may be a non-trading day or not published yet.`);
  const csv = await response.text();
  const rows = parseCsv(csv).filter((row) => selectedIndices.has(String(row['Index Name'] || '').trim().toLowerCase()) && numeric(row['Closing Index Value']) !== null);
  if (!rows.length) throw new Error('NSE index-close report contained no selected sector indices; source format may have changed.');
  const rawDirectory = path.join(__dirname, '..', 'raw', 'nse');
  fs.mkdirSync(rawDirectory, { recursive: true });
  fs.writeFileSync(path.join(rawDirectory, `index-close-${date}.csv`), csv);
  const upsert = db.prepare(`
    INSERT INTO nse_index_close_daily (index_name, date, close_value, points_change, percent_change, source_url)
    VALUES (@indexName, @date, @closeValue, @pointsChange, @percentChange, @sourceUrl)
    ON CONFLICT(index_name, date) DO UPDATE SET close_value = excluded.close_value, points_change = excluded.points_change,
      percent_change = excluded.percent_change, source_url = excluded.source_url
  `);
  const sourceRows = rows.map((row) => ({ indexName: row['Index Name'].trim(), date, closeValue: numeric(row['Closing Index Value']), pointsChange: numeric(row['Points Change']), percentChange: numeric(row['Change(%)']), sourceUrl }));
  db.transaction((items) => items.forEach((row) => upsert.run(row)))(sourceRows);
  console.log(`Imported ${sourceRows.length} NSE sector-index closes for ${date}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
