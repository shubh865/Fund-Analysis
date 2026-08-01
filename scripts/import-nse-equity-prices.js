const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const db = require('../server/db');
const { parseCsv } = require('./lib/csv');

const rawDirectory = path.join(__dirname, '..', 'raw', 'nse');

function requestedDate() {
  const value = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Pass an NSE trading date: npm run import:nse-equity-prices -- YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Date must be a valid YYYY-MM-DD value.');
  return value;
}

function sourceFor(date) {
  const compact = date.replaceAll('-', '');
  return `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${compact}_F_0000.csv.zip`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const date = requestedDate();
  const sourceUrl = sourceFor(date);
  const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'MutualFundAnalytics/0.1 (local)' } });
  if (!response.ok) throw new Error(`NSE bhavcopy returned HTTP ${response.status} for ${date}. It may be a non-trading day or not published yet.`);
  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntries().find((candidate) => /\.csv$/i.test(candidate.entryName));
  if (!entry) throw new Error('NSE bhavcopy zip did not contain a CSV file.');
  const source = zip.readAsText(entry);
  const records = parseCsv(source).filter((row) => row.Sgmt === 'CM'
    && row.FinInstrmTp === 'STK'
    && row.ISIN
    && number(row.ClsPric) > 0);
  if (!records.length) throw new Error('NSE bhavcopy contained no usable capital-market stock prices; source format may have changed.');
  fs.mkdirSync(rawDirectory, { recursive: true });
  fs.writeFileSync(path.join(rawDirectory, `bhavcopy-${date}.zip`), zipBuffer);
  const upsertSecurity = db.prepare(`
    INSERT INTO nse_equity_securities (isin, symbol, company_name, series, source_url)
    VALUES (@isin, @symbol, @symbol, @series, @sourceUrl)
    ON CONFLICT(isin) DO UPDATE SET symbol = excluded.symbol, series = excluded.series, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP
  `);
  const upsertPrice = db.prepare(`
    INSERT INTO nse_equity_price_daily (
      isin, date, symbol, series, open_price, high_price, low_price,
      close_price, previous_close_price, volume, source_url
    ) VALUES (
      @isin, @date, @symbol, @series, @openPrice, @highPrice, @lowPrice,
      @closePrice, @previousClosePrice, @volume, @sourceUrl
    ) ON CONFLICT(isin, date) DO UPDATE SET
      symbol = excluded.symbol, series = excluded.series, open_price = excluded.open_price,
      high_price = excluded.high_price, low_price = excluded.low_price, close_price = excluded.close_price,
      previous_close_price = excluded.previous_close_price, volume = excluded.volume, source_url = excluded.source_url
  `);
  const rows = records.map((row) => ({
    isin: row.ISIN.toUpperCase(), date, symbol: row.TckrSymb, series: row.SctySrs || null,
    openPrice: number(row.OpnPric), highPrice: number(row.HghPric), lowPrice: number(row.LwPric),
    closePrice: number(row.ClsPric), previousClosePrice: number(row.PrvsClsgPric), volume: number(row.TtlTradgVol), sourceUrl,
  }));
  db.transaction((items) => items.forEach((row) => { upsertSecurity.run(row); upsertPrice.run(row); }))(rows);
  console.log(`Imported ${rows.length.toLocaleString('en-IN')} NSE end-of-day stock prices for ${date}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
