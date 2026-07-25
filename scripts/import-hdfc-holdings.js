const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'HDFC Mutual Fund';
const DEFAULT_SOURCE_URL = 'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio';
const [inputDirectory, ...args] = process.argv.slice(2);
if (!inputDirectory || inputDirectory.startsWith('--')) {
  console.error('Usage: node scripts/import-hdfc-holdings.js <monthly-disclosure-directory> [--source-url URL]');
  process.exit(1);
}
const sourceUrlIndex = args.indexOf('--source-url');
const sourceUrl = sourceUrlIndex >= 0 ? args[sourceUrlIndex + 1] : DEFAULT_SOURCE_URL;
const resolvedInput = path.resolve(inputDirectory);
if (!fs.existsSync(resolvedInput) || !fs.statSync(resolvedInput).isDirectory()) {
  console.error(`Directory not found: ${resolvedInput}`);
  process.exit(1);
}

function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function asOfDate(value) {
  const match = text(value).match(/portfolio as on\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function sourceFundCode(name) { return text(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function isSubtotal(name) { return /^(sub\s*total|total|grand\s*total|net current assets)/i.test(name); }
function isSection(name) { return /^(equity|debt instruments|money market instruments|others$)/i.test(name); }
function isGroup(name) { return /^(\([a-z]\)|equity$|government securities|treps|cash and cash equivalents)/i.test(name); }

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios (amc, source_fund_code, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings (portfolio_id, as_of_date, position_order, asset_class, holding_group, instrument_name, isin, industry_or_rating, quantity, market_value_lakh, weight, yield, yield_to_call) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports (amc, as_of_date, source_file, source_url) VALUES (?, ?, ?, ?) ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET source_url = excluded.source_url, imported_at = CURRENT_TIMESTAMP`);

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const fundName = text(rows[0]?.[0]).replace(/\s*\(.+$/, '');
  const date = asOfDate(rows[1]?.[0]);
  if (!fundName || !date) return null;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(5)) {
    const groupLabel = text(row[1]);
    const instrumentName = text(row[3]);
    if (/^portfolio classification|^notes\s*:/i.test(groupLabel)) break;
    if (isSection(groupLabel)) { assetClass = groupLabel; holdingGroup = null; continue; }
    if (isGroup(groupLabel)) { holdingGroup = groupLabel; continue; }
    if (isSubtotal(groupLabel) || isSubtotal(instrumentName)) continue;
    const quantity = number(row[5]);
    const marketValueLakh = number(row[6]);
    // HDFC publishes portfolio weights as percentages (for example 9.18).
    // Store all AMC weights as decimal fractions (0.0918) so the browser can
    // use a single display and aggregation convention.
    const publishedWeight = number(row[7]);
    const weight = publishedWeight == null ? null : publishedWeight / 100;
    if (!instrumentName || (quantity == null && marketValueLakh == null && weight == null)) continue;
    holdings.push({ assetClass, holdingGroup, instrumentName, isin: groupLabel || null, industryOrRating: text(row[4]) || null, quantity, marketValueLakh, weight, yield: number(row[8]), yieldToCall: number(row[9]) });
  }
  return { fundName, date, holdings };
}

const workbooks = fs.readdirSync(resolvedInput).filter((name) => /\.xlsx$/i.test(name)).map((name) => path.join(resolvedInput, name));
if (!workbooks.length) throw new Error('No HDFC Excel portfolio files found.');
const result = db.transaction(() => {
  let disclosureDate = null;
  let portfolioCount = 0;
  let holdingCount = 0;
  for (const workbookPath of workbooks) {
    const portfolio = parseWorkbook(workbookPath);
    if (!portfolio) continue;
    if (!disclosureDate) disclosureDate = portfolio.date;
    if (disclosureDate !== portfolio.date) throw new Error(`Mixed disclosure dates found: ${disclosureDate} and ${portfolio.date}.`);
    const code = sourceFundCode(portfolio.fundName);
    portfolioUpsert.run(AMC, code, portfolio.fundName, 'HDFC monthly portfolio disclosure');
    const { portfolio_id: portfolioId } = portfolioFind.get(AMC, code);
    deletePositions.run(portfolioId, portfolio.date);
    portfolio.holdings.forEach((holding, index) => positionInsert.run(portfolioId, portfolio.date, index + 1, holding.assetClass, holding.holdingGroup, holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall));
    portfolioCount += 1;
    holdingCount += portfolio.holdings.length;
  }
  if (!disclosureDate) throw new Error('No HDFC portfolio workbooks with a recognised disclosure date were found.');
  importUpsert.run(AMC, disclosureDate, path.basename(resolvedInput), sourceUrl);
  return { disclosureDate, portfolioCount, holdingCount };
})();
console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} HDFC portfolios as of ${result.disclosureDate}.`);
