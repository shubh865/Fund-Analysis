const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'UTI Mutual Fund';
const SOURCE_PAGE = 'https://www.utimf.com/downloads/consolidate-all-portfolio-disclosure';
const API_BASE = 'https://www.utimf.com/api';
const CATEGORIES = ['Debt', 'Equity', 'Hybrid', 'FOF', 'Liquid', 'Solution Oriented', 'ETF', 'Index Fund'];

function previousMonth() {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return { year: date.getFullYear(), month: date.toLocaleString('en-US', { month: 'long' }) };
}

function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function dateFromDisclosure(value) {
  const match = text(value).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets)/i.test(value); }
function isAssetClass(value) { return /^(debt|equity|money market|derivatives|units of|foreign securities|others|cash)/i.test(value); }
function family(name) {
  return text(name).toUpperCase()
    .replace(/\bUTI\b/g, ' ')
    .replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g, ' ')
    .replace(/\(ERSTWHILE[^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios (amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings
  (portfolio_id, as_of_date, position_order, asset_class, holding_group, instrument_name, isin, industry_or_rating, quantity, market_value_lakh, weight, yield, yield_to_call)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports (amc, as_of_date, source_file, source_url)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET source_url = excluded.source_url, imported_at = CURRENT_TIMESTAMP`);
const mappingUpsert = db.prepare(`INSERT INTO scheme_portfolio_mappings (scheme_code, portfolio_id, mapping_status, source_url)
  VALUES (?, ?, 'provisional', ?)
  ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id = excluded.portfolio_id, mapping_status = excluded.mapping_status,
    source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP`);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function parseWorkbook(bytes, sourceFundCode, sourceName) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const date = dateFromDisclosure(rows[2]?.[0]);
  const headerIndex = rows.findIndex((row) => /name of the instrument/i.test(text(row[0])) && /%\s*to\s*(nav|aum)/i.test(text(row[4])));
  if (!date || headerIndex < 0) return null;

  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[0]);
    const industryOrRating = text(row[1]);
    const quantity = number(row[2]);
    const marketValueLakh = number(row[3]);
    const publishedWeight = number(row[4]);
    const isin = text(row[7]);
    if (!instrumentName || isTotal(instrumentName)) continue;
    if (isAssetClass(instrumentName) && quantity == null && marketValueLakh == null && publishedWeight == null) {
      assetClass = instrumentName;
      holdingGroup = null;
      continue;
    }
    if (quantity == null && marketValueLakh == null && publishedWeight == null) {
      holdingGroup = instrumentName;
      continue;
    }
    holdings.push({ assetClass, holdingGroup, instrumentName, industryOrRating: industryOrRating || null, isin: isin || null,
      quantity, marketValueLakh, weight: publishedWeight == null ? null : publishedWeight / 100,
      yield: number(row[9]), yieldToCall: number(row[8]) });
  }
  const normalizedHoldings = normalizeHoldings(holdings, sourceName);
  return normalizedHoldings.length ? { sourceFundCode, name: sourceName, date, holdings: normalizedHoldings } : null;
}

async function fetchPortfolios(target) {
  const funds = new Map();
  for (const category of CATEGORIES) {
    const data = await getJson(`${API_BASE}/get-schemes-from-cat?fund_category=${encodeURIComponent(category)}`);
    for (const fund of data.rows || []) funds.set(String(fund.field_dofa_schcode), fund.field_fund_name);
  }
  const portfolios = [];
  for (const [sourceFundCode, name] of funds) {
    const details = await getJson(`${API_BASE}/get-scheme-portfolio-disclosure?dofa_scheme_code=${encodeURIComponent(sourceFundCode)}&year=${target.year}&month=${encodeURIComponent(target.month)}`);
    const url = details.rows?.[0]?.url;
    if (!url) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`UTI portfolio workbook for ${name} returned ${response.status}`);
    const portfolio = parseWorkbook(Buffer.from(await response.arrayBuffer()), sourceFundCode, text(name));
    if (portfolio) portfolios.push(portfolio);
  }
  return portfolios;
}

function savePortfolios(portfolios, target) {
  const disclosureDate = portfolios[0]?.date;
  if (!disclosureDate) throw new Error(`UTI has not published usable portfolio files for ${target.month} ${target.year}.`);
  if (portfolios.some((portfolio) => portfolio.date !== disclosureDate)) throw new Error('UTI returned mixed disclosure dates; no data was written.');
  const result = db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'UTI monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, portfolio.date);
      portfolio.holdings.forEach((holding, index) => {
        positionInsert.run(portfolioId, portfolio.date, index + 1, holding.assetClass, holding.holdingGroup, holding.instrumentName,
          holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall);
      });
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, disclosureDate, `uti-portfolio-disclosures-${disclosureDate}.xlsx`, SOURCE_PAGE);
    const portfoliosInDb = db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?').all(AMC);
    const byFamily = new Map(portfoliosInDb.map((portfolio) => [family(portfolio.name), portfolio]));
    const schemes = db.prepare("SELECT scheme_code, name FROM schemes WHERE amc = ? AND LOWER(name) LIKE '%growth%'").all(AMC);
    let mappedCount = 0;
    for (const scheme of schemes) {
      const portfolio = byFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { disclosureDate, portfolioCount: portfolios.length, holdingCount, mappedCount };
  })();
  return result;
}

async function main() {
  const target = previousMonth();
  console.log(`Fetching UTI portfolio disclosures for ${target.month} ${target.year}...`);
  const portfolios = await fetchPortfolios(target);
  const result = savePortfolios(portfolios, target);
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} UTI portfolios as of ${result.disclosureDate}; mapped ${result.mappedCount} Growth plans.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
