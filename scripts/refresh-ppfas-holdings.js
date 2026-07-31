const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'PPFAS Mutual Fund';
const SOURCE_PAGE = 'https://amc.ppfas.com/downloads/portfolio-disclosure/';

function previousMonthEnd() {
  const date = new Date();
  date.setDate(0);
  return date;
}

function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function disclosureDate(value) {
  const match = text(value).match(/(?:as on )?([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(value); }
function isSection(value) {
  return /^(equity|debt instruments|money market|derivatives|units of mutual funds|foreign securities|cash|other current assets|arbitrage)/i.test(value);
}
function family(name) {
  return text(name).split('(')[0].toUpperCase()
    .replace(/\b(PARAG|PARIKH|PPFAS|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios (amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?) ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings
  (portfolio_id, as_of_date, position_order, asset_class, holding_group, instrument_name, isin, industry_or_rating, quantity, market_value_lakh, weight, yield, yield_to_call)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports (amc, as_of_date, source_file, source_url)
  VALUES (?, ?, ?, ?) ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET source_url = excluded.source_url, imported_at = CURRENT_TIMESTAMP`);
const mappingUpsert = db.prepare(`INSERT INTO scheme_portfolio_mappings (scheme_code, portfolio_id, mapping_status, source_url)
  VALUES (?, ?, 'provisional', ?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id = excluded.portfolio_id, mapping_status = excluded.mapping_status, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP`);

async function fetchWorkbook(target) {
  const page = await fetch(SOURCE_PAGE);
  if (!page.ok) throw new Error(`PPFAS disclosure page returned ${page.status}`);
  const html = await page.text();
  const month = target.toLocaleString('en-US', { month: 'long' });
  const year = target.getFullYear();
  const day = target.getDate();
  const pattern = new RegExp('href=["\']([^"\']*PPFAS_Monthly_Portfolio_Report_' + month + '_' + day + '_' + year + '\\.(?:xls|xlsx)[^"\']*)', 'i');
  const match = html.match(pattern);
  if (!match) throw new Error(`PPFAS has not published a consolidated portfolio workbook for ${month} ${year}.`);
  const url = new URL(match[1].replace(/&amp;/g, '&'), SOURCE_PAGE).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PPFAS portfolio workbook returned ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), url };
}

function parseWorkbook(bytes) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const portfolios = [];
  for (const sourceFundCode of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sourceFundCode], { header: 1, defval: null, raw: true });
    const name = text(rows[0]?.[1]);
    const date = disclosureDate(rows[2]?.[1]);
    const headerIndex = rows.findIndex((row) => /name of the instrument/i.test(text(row[1])) && /%\s*to\s*(net\s*)?assets/i.test(text(row[6])));
    if (!name || !date || headerIndex < 0) continue;
    const holdings = [];
    let assetClass = null;
    let holdingGroup = null;
    for (const row of rows.slice(headerIndex + 1)) {
      const instrumentName = text(row[1]);
      if (/^notes?(?:\s*&\s*symbols)?\s*:/i.test(instrumentName)) break;
      const isin = text(row[2]);
      const industryOrRating = text(row[3]);
      const quantity = number(row[4]);
      const marketValueLakh = number(row[5]);
      const weight = number(row[6]);
      if (!instrumentName || isTotal(instrumentName)) continue;
      if (isSection(instrumentName) && quantity == null && marketValueLakh == null && weight == null) {
        assetClass = instrumentName; holdingGroup = null; continue;
      }
      if (quantity == null && marketValueLakh == null && weight == null) { holdingGroup = instrumentName; continue; }
      holdings.push({ assetClass, holdingGroup, instrumentName, isin: isin || null, industryOrRating: industryOrRating || null,
        quantity, marketValueLakh, weight, yield: number(row[7]), yieldToCall: number(row[8]) });
    }
    const normalizedHoldings = normalizeHoldings(holdings, name);
    if (normalizedHoldings.length) portfolios.push({ sourceFundCode, name, date, holdings: normalizedHoldings });
  }
  return portfolios;
}

function savePortfolios(portfolios, sourceUrl) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) throw new Error('PPFAS returned mixed or unreadable disclosure dates.');
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'PPFAS monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, index) => positionInsert.run(portfolioId, asOfDate, index + 1, holding.assetClass, holding.holdingGroup,
        holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall));
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, asOfDate, `ppfas-portfolio-disclosure-${asOfDate}.xls`, sourceUrl);
    const portfoliosInDb = db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?').all(AMC);
    const byFamily = new Map(portfoliosInDb.map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare("SELECT scheme_code, name FROM schemes WHERE amc = ? AND LOWER(name) LIKE '%growth%'").all(AMC)) {
      const portfolio = byFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { asOfDate, holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

async function main() {
  const target = previousMonthEnd();
  console.log('Fetching PPFAS monthly portfolio disclosure...');
  const source = await fetchWorkbook(target);
  const result = savePortfolios(parseWorkbook(source.bytes), source.url);
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} PPFAS portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} Growth plans.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
