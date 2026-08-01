const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const { parseCsv } = require('./lib/csv');

const SOURCE_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const rawDirectory = path.join(__dirname, '..', 'raw', 'nse');

async function main() {
  const response = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'MutualFundAnalytics/0.1 (local)' } });
  if (!response.ok) throw new Error(`NSE security list returned HTTP ${response.status}`);
  const source = await response.text();
  const records = parseCsv(source).filter((row) => /^INE[A-Z0-9]{9}$/i.test(row['ISIN NUMBER'] || '') && row.SYMBOL);
  if (!records.length) throw new Error('NSE security list contained no usable ISIN/symbol pairs; source format may have changed.');
  fs.mkdirSync(rawDirectory, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(rawDirectory, `equity-securities-${date}.csv`), source);
  const upsert = db.prepare(`
    INSERT INTO nse_equity_securities (isin, symbol, company_name, series, source_url)
    VALUES (@isin, @symbol, @companyName, @series, @sourceUrl)
    ON CONFLICT(isin) DO UPDATE SET
      symbol = excluded.symbol, company_name = excluded.company_name,
      series = excluded.series, source_url = excluded.source_url,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction((rows) => rows.forEach((row) => upsert.run(row)))(records.map((row) => ({
    isin: row['ISIN NUMBER'].toUpperCase(), symbol: row.SYMBOL,
    companyName: row['NAME OF COMPANY'] || null, series: row.SERIES || null, sourceUrl: SOURCE_URL,
  })));
  console.log(`Imported ${records.length.toLocaleString('en-IN')} NSE equity ISIN-to-symbol mappings.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
