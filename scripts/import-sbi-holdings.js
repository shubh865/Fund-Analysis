const path = require('node:path');
const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'SBI Mutual Fund';
const DEFAULT_SOURCE_URL = 'https://www.sbimf.com/portfolios';
const [inputFile, ...args] = process.argv.slice(2);
if (!inputFile || inputFile.startsWith('--')) {
  console.error('Usage: node scripts/import-sbi-holdings.js <all-schemes-workbook.xlsx> [--source-url URL]');
  process.exit(1);
}
const sourceUrlIndex = args.indexOf('--source-url');
const sourceUrl = sourceUrlIndex >= 0 ? args[sourceUrlIndex + 1] : DEFAULT_SOURCE_URL;

function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== 'number') return null;
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return null;
  return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
}
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets)/i.test(value); }
function isSection(value) { return /^(equity|debt|money market|others|derivatives|cash)/i.test(value); }

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios (amc, source_fund_code, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings (portfolio_id, as_of_date, position_order, asset_class, holding_group, instrument_name, isin, industry_or_rating, quantity, market_value_lakh, weight, yield, yield_to_call) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports (amc, as_of_date, source_file, source_url) VALUES (?, ?, ?, ?) ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET source_url = excluded.source_url, imported_at = CURRENT_TIMESTAMP`);

function portfolioIndex(workbook) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Index, { header: 1, defval: null, raw: true });
  return new Map(rows.slice(3).map((row) => [text(row[1]), { sourceFundCode: text(row[0]), name: text(row[2]) }]).filter(([sheet, details]) => sheet && details.name));
}

function parseSheet(workbook, sheetName, index) {
  const details = index.get(sheetName);
  if (!details) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const dateRow = rows.find((row) => text(row[2]).startsWith('PORTFOLIO STATEMENT AS ON'));
  const date = excelDate(dateRow?.[3]);
  const headerIndex = rows.findIndex((row) => /name of the instrument/i.test(text(row[2])) && /%\s*to\s*aum/i.test(text(row[7])));
  if (!date || headerIndex < 0) return null;

  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[2]);
    const isin = text(row[3]);
    const industryOrRating = text(row[4]);
    const quantity = number(row[5]);
    const marketValueLakh = number(row[6]);
    const publishedWeight = number(row[7]);
    if (!instrumentName) continue;
    if (isTotal(instrumentName)) continue;
    if (isSection(instrumentName) && quantity == null && marketValueLakh == null && publishedWeight == null) {
      assetClass = instrumentName;
      holdingGroup = null;
      continue;
    }
    if (quantity == null && marketValueLakh == null && publishedWeight == null) {
      holdingGroup = instrumentName;
      continue;
    }
    holdings.push({
      assetClass,
      holdingGroup,
      instrumentName,
      isin: isin || null,
      industryOrRating: industryOrRating || null,
      quantity,
      marketValueLakh,
      // SBI publishes 8.72 for 8.72%; raw storage is always a decimal fraction.
      weight: publishedWeight == null ? null : publishedWeight / 100,
      yield: number(row[8]),
      yieldToCall: number(row[9]),
    });
  }
  const normalizedHoldings = normalizeHoldings(holdings, details.name);
  const cashGross = normalizedHoldings
    .filter((holding) => !/derivative/i.test(holding.assetClass || ''))
    .reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  if (cashGross >= 0.005 && cashGross <= 0.05) {
    for (const holding of normalizedHoldings) {
      if (!/derivative/i.test(holding.assetClass || '') && holding.weight != null) holding.weight *= 100;
    }
  }
  return { ...details, date, holdings: normalizedHoldings };
}

const workbook = XLSX.readFile(path.resolve(inputFile), { cellDates: false });
if (!workbook.Sheets.Index) throw new Error('The SBI all-schemes workbook must contain an Index worksheet.');
const index = portfolioIndex(workbook);
const result = db.transaction(() => {
  let disclosureDate = null;
  let portfolioCount = 0;
  let holdingCount = 0;
  for (const sheetName of workbook.SheetNames.filter((name) => name !== 'Index')) {
    const portfolio = parseSheet(workbook, sheetName, index);
    if (!portfolio || !portfolio.holdings.length) continue;
    if (!disclosureDate) disclosureDate = portfolio.date;
    if (disclosureDate !== portfolio.date) throw new Error(`Mixed disclosure dates found: ${disclosureDate} and ${portfolio.date}.`);
    portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'SBI monthly portfolio disclosure');
    const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
    deletePositions.run(portfolioId, portfolio.date);
    portfolio.holdings.forEach((holding, position) => positionInsert.run(portfolioId, portfolio.date, position + 1, holding.assetClass, holding.holdingGroup, holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall));
    portfolioCount += 1;
    holdingCount += portfolio.holdings.length;
  }
  if (!disclosureDate) throw new Error('No SBI portfolio sheets with recognised holdings were found.');
  importUpsert.run(AMC, disclosureDate, path.basename(inputFile), sourceUrl);
  return { disclosureDate, portfolioCount, holdingCount };
})();
console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} SBI portfolios as of ${result.disclosureDate}.`);
