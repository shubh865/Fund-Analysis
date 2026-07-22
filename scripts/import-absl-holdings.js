const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const db = require('../server/db');

const [inputPath, ...args] = process.argv.slice(2);
if (!inputPath || inputPath.startsWith('--')) {
  console.error('Usage: node scripts/import-absl-holdings.js <monthly-disclosure.xlsx> [--source-url URL]');
  process.exit(1);
}

const sourceUrlIndex = args.indexOf('--source-url');
const sourceUrl = sourceUrlIndex >= 0 ? args[sourceUrlIndex + 1] : null;
if (sourceUrlIndex >= 0 && !sourceUrl) {
  console.error('--source-url needs a URL.');
  process.exit(1);
}

const resolvedInput = path.resolve(inputPath);
if (!fs.existsSync(resolvedInput)) {
  console.error(`File not found: ${resolvedInput}`);
  process.exit(1);
}

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOfDate(value) {
  const match = text(value).match(/as on ([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function isSubtotal(name) {
  return /^(sub\s*total|total|grand\s*total|net receivables|net payable)/i.test(name);
}

function isSection(name) {
  return /^(equity|debt instruments|others|derivative|money market|gold|silver|international mutual fund units)/i.test(name);
}

function isGroup(name) {
  return /^\([a-z]\)|^(listed|unlisted|government securities|exchange traded funds|treps|reverse repo|cash and cash equivalents)/i.test(name);
}

const workbook = XLSX.readFile(resolvedInput, { cellDates: false });
const portfolioUpsert = db.prepare(`
  INSERT INTO holding_portfolios (amc, source_fund_code, name, description)
  VALUES ('Aditya Birla Sun Life Mutual Fund', @fundCode, @name, @description)
  ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description
`);
const portfolioFind = db.prepare(`
  SELECT portfolio_id FROM holding_portfolios
  WHERE amc = 'Aditya Birla Sun Life Mutual Fund' AND source_fund_code = ?
`);
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`
  INSERT INTO portfolio_holdings (
    portfolio_id, as_of_date, position_order, asset_class, holding_group,
    instrument_name, isin, industry_or_rating, quantity, market_value_lakh,
    weight, yield, yield_to_call
  ) VALUES (
    @portfolioId, @asOfDate, @positionOrder, @assetClass, @holdingGroup,
    @instrumentName, @isin, @industryOrRating, @quantity, @marketValueLakh,
    @weight, @yield, @yieldToCall
  )
`);
const importUpsert = db.prepare(`
  INSERT INTO holding_imports (amc, as_of_date, source_file, source_url)
  VALUES ('Aditya Birla Sun Life Mutual Fund', ?, ?, ?)
  ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET
    source_url = excluded.source_url,
    imported_at = CURRENT_TIMESTAMP
`);

const importWorkbook = db.transaction(() => {
  let portfolioCount = 0;
  let holdingCount = 0;
  let disclosureDate = null;

  for (const sheetName of workbook.SheetNames) {
    if (sheetName === 'Index') continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const fundCode = text(rows[0]?.[0]);
    const name = text(rows[0]?.[1]);
    const description = text(rows[1]?.[1]);
    const date = asOfDate(rows[2]?.[1]);
    if (!fundCode || !name || !date) continue;
    if (!disclosureDate) disclosureDate = date;
    if (disclosureDate !== date) throw new Error(`Mixed disclosure dates found: ${disclosureDate} and ${date}.`);

    portfolioUpsert.run({ fundCode, name, description: description || null });
    const portfolioId = portfolioFind.get(fundCode).portfolio_id;
    deletePositions.run(portfolioId, date);
    portfolioCount += 1;

    let assetClass = null;
    let holdingGroup = null;
    let positionOrder = 0;
    for (const row of rows.slice(4)) {
      // Column A is deliberately blank in ABSL's disclosure sheets; holdings
      // begin in column B, while the fund code itself lives in cell A1.
      const instrumentName = text(row[1]);
      if (!instrumentName) continue;
      if (isSection(instrumentName)) {
        assetClass = instrumentName;
        holdingGroup = null;
        continue;
      }
      if (isGroup(instrumentName)) {
        holdingGroup = instrumentName;
        continue;
      }
      if (isSubtotal(instrumentName)) continue;

      const quantity = number(row[4]);
      const marketValueLakh = number(row[5]);
      const weight = number(row[6]);
      if (quantity == null && marketValueLakh == null && weight == null) continue;

      positionOrder += 1;
      positionInsert.run({
        portfolioId,
        asOfDate: date,
        positionOrder,
        assetClass,
        holdingGroup,
        instrumentName,
        isin: text(row[2]) || null,
        industryOrRating: text(row[3]) || null,
        quantity,
        marketValueLakh,
        weight,
        yield: number(row[7]),
        yieldToCall: number(row[8]),
      });
      holdingCount += 1;
    }
  }

  if (!disclosureDate) throw new Error('No portfolio worksheets with a recognised disclosure date were found.');
  importUpsert.run(disclosureDate, path.basename(resolvedInput), sourceUrl);
  return { disclosureDate, portfolioCount, holdingCount };
});

const result = importWorkbook();
console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} ABSL portfolios as of ${result.disclosureDate}.`);
