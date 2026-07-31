const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Motilal Oswal Mutual Fund';
const ORIGIN = 'https://www.motilaloswalmf.com';
const SITEMAP = `${ORIGIN}/sitemap.xml`;

function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) { const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, '')); return Number.isFinite(parsed) ? parsed : null; }
function disclosureDate(value) {
  const match = text(value).match(/(?:as on )?([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function family(name) {
  return text(name).toUpperCase().split('(')[0]
    .replace(/\b(MOTILAL|OSWAL|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(value); }
function isSection(value) { return /^(equity|debt|money market|derivatives|units of|cash|other current assets|foreign securities|arbitrage)/i.test(value); }

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios (amc, source_fund_code, name, description) VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, source_fund_code) DO UPDATE SET name=excluded.name, description=excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings (portfolio_id,as_of_date,position_order,asset_class,holding_group,instrument_name,isin,industry_or_rating,quantity,market_value_lakh,weight,yield,yield_to_call) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports (amc,as_of_date,source_file,source_url) VALUES (?,?,?,?) ON CONFLICT(amc,as_of_date,source_file) DO UPDATE SET source_url=excluded.source_url, imported_at=CURRENT_TIMESTAMP`);
const mappingUpsert = db.prepare(`INSERT INTO scheme_portfolio_mappings (scheme_code,portfolio_id,mapping_status,source_url) VALUES (?,?,'provisional',?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id=excluded.portfolio_id,mapping_status=excluded.mapping_status,source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP`);

async function fetchText(url) { const response = await fetch(url); if (!response.ok) throw new Error(`${url} returned ${response.status}`); return response.text(); }

function parseWorkbook(bytes, sourceFundCode) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null, raw: true });
  const name = text(rows[0]?.[1]);
  const date = disclosureDate(rows[1]?.[1]);
  const headerIndex = rows.findIndex((row) => /name of instrument/i.test(text(row[1])) && /%\s*to\s*net asset/i.test(text(row[7])));
  if (!name || !date || headerIndex < 0) return null;
  const holdings = [];
  let assetClass = null; let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[1]); const isin = text(row[3]); const industryOrRating = text(row[4]);
    const quantity = number(row[5]); const marketValueLakh = number(row[6]); const weight = number(row[7]);
    if (!instrumentName || isTotal(instrumentName)) continue;
    if (isSection(instrumentName) && quantity == null && marketValueLakh == null && weight == null) { assetClass = instrumentName; holdingGroup = null; continue; }
    if (quantity == null && marketValueLakh == null && weight == null) { holdingGroup = instrumentName; continue; }
    holdings.push({ assetClass, holdingGroup, instrumentName, isin: isin || null, industryOrRating: industryOrRating || null, quantity, marketValueLakh, weight, yield: null, yieldToCall: null });
  }
  return holdings.length ? { sourceFundCode, name, date, holdings } : null;
}

async function fetchPortfolios() {
  const sitemap = await fetchText(SITEMAP);
  const urls = [...sitemap.matchAll(/<loc>(https:\/\/www\.motilaloswalmf\.com\/mutual-funds\/[^<]+)<\/loc>/g)].map((match) => match[1]);
  const portfolioUrls = new Map();
  for (const url of urls) {
    const page = await fetchText(url);
    const match = page.match(/portfolioUrl:<\/strong>\s*([^<\s]+Month_End_Portfolio_[^<\s]+\/([A-Z]{2}\d+)\.xlsx)/i);
    if (match) portfolioUrls.set(match[2], new URL(match[1], ORIGIN).href);
  }
  const portfolios = [];
  for (const [sourceFundCode, url] of portfolioUrls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Motilal portfolio ${sourceFundCode} returned ${response.status}`);
    const portfolio = parseWorkbook(Buffer.from(await response.arrayBuffer()), sourceFundCode);
    if (portfolio) portfolios.push(portfolio);
  }
  return portfolios;
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) throw new Error('Motilal returned mixed or unreadable disclosure dates.');
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Motilal Oswal monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, index) => positionInsert.run(portfolioId, asOfDate, index + 1, holding.assetClass, holding.holdingGroup, holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall));
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, asOfDate, `motilal-oswal-portfolios-${asOfDate}.xlsx`, SITEMAP);
    const byFamily = new Map(db.prepare('SELECT portfolio_id,name FROM holding_portfolios WHERE amc=?').all(AMC).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare("SELECT scheme_code,name FROM schemes WHERE amc=? AND LOWER(name) LIKE '%growth%'").all(AMC)) {
      const portfolio = byFamily.get(family(scheme.name)); if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, ORIGIN); mappedCount += 1;
    }
    return { asOfDate, holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

async function main() {
  console.log('Fetching Motilal Oswal monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Motilal Oswal portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} Growth plans.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
