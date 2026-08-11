const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const [inputPath, ...args] = process.argv.slice(2);
if (!inputPath || inputPath.startsWith('--')) {
  console.error('Usage: node scripts/import-absl-holdings.js <monthly-disclosure.xls|xlsx> [--source-url URL]');
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

function firstText(row) {
  return (row || []).map(text).find(Boolean) || '';
}

function columnIndex(header, matcher, fallback) {
  const found = header.findIndex((value) => matcher.test(text(value)));
  return found >= 0 ? found : fallback;
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
    // ABSL moved the scheme detail columns one position to the right in its
    // July 2026 legacy .xls workbook. Find them instead of assuming a layout.
    const name = text(rows[0]?.slice(1).find((value) => text(value))) || '';
    const description = firstText(rows[1]);
    const date = rows.slice(0, 5).flatMap((row) => row || []).map(asOfDate).find(Boolean);
    const headerIndex = rows.findIndex((row) => (row || []).some((value) => /name of (?:the )?instrument/i.test(text(value))));
    if (!fundCode || !name || !date) continue;
    if (!disclosureDate) disclosureDate = date;
    if (disclosureDate !== date) throw new Error(`Mixed disclosure dates found: ${disclosureDate} and ${date}.`);

    if (headerIndex < 0) continue;
    const header = rows[headerIndex] || [];
    const instrumentColumn = columnIndex(header, /name of (?:the )?instrument/i, 1);
    const isinColumn = columnIndex(header, /^isin$/i, 2);
    const ratingColumn = columnIndex(header, /industry.*rating|rating/i, 3);
    const quantityColumn = columnIndex(header, /^quantity$/i, 4);
    const marketValueColumn = columnIndex(header, /market\s*value/i, 5);
    const weightColumn = columnIndex(header, /%\s*to\s*aum|%.*aum/i, 6);
    const yieldColumn = columnIndex(header, /^ytm/i, 7);
    const yieldToCallColumn = columnIndex(header, /^ytc/i, 8);

    const holdings = [];
    let assetClass = null;
    let holdingGroup = null;
    for (const row of rows.slice(headerIndex + 1)) {
      const instrumentName = text(row[instrumentColumn]);
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

      const quantity = number(row[quantityColumn]);
      const marketValueLakh = number(row[marketValueColumn]);
      const weight = number(row[weightColumn]);
      if (quantity == null && marketValueLakh == null && weight == null) continue;

      holdings.push({
        instrumentName,
        isin: text(row[isinColumn]) || null,
        industryOrRating: text(row[ratingColumn]) || null,
        quantity,
        marketValueLakh,
        weight,
        yield: number(row[yieldColumn]),
        yieldToCall: number(row[yieldToCallColumn]),
        assetClass,
        holdingGroup,
      });
    }

    const normalizedHoldings = normalizeHoldings(holdings, name);
    if (!normalizedHoldings.length) continue;
    portfolioUpsert.run({ fundCode, name, description: description || null });
    const portfolioId = portfolioFind.get(fundCode).portfolio_id;
    deletePositions.run(portfolioId, date);
    portfolioCount += 1;
    normalizedHoldings.forEach((holding, index) => {
      positionInsert.run({
        portfolioId,
        asOfDate: date,
        positionOrder: index + 1,
        ...holding,
      });
      holdingCount += 1;
    });
  }

  if (!disclosureDate) throw new Error('No portfolio worksheets with a recognised disclosure date were found.');
  importUpsert.run(disclosureDate, path.basename(resolvedInput), sourceUrl);
  return { disclosureDate, portfolioCount, holdingCount };
});

const result = importWorkbook();
console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} ABSL portfolios as of ${result.disclosureDate}.`);
