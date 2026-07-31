const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'Nippon India Mutual Fund';
const SOURCE_PAGE = 'https://mf.nipponindiaim.com/investor-service/downloads/factsheet-portfolio-and-other-disclosures';

function previousMonthEnd() {
  const date = new Date();
  date.setDate(0);
  return {
    year: date.getFullYear(),
    day: date.getDate(),
    monthShort: date.toLocaleString('en-US', { month: 'short' }),
  };
}
function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function dateFromDisclosure(value) {
  const match = text(value).match(/as on\s+(.+)/i);
  if (!match) return null;
  const parts = match[1].match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (!parts) return null;
  const month = new Date(`${parts[1]} 1, 2000`).getMonth() + 1;
  return month ? `${parts[3]}-${String(month).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}` : null;
}
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets)/i.test(value); }
function isAssetClass(value) { return /^(equity|debt|money market|derivatives|units of|foreign securities|others|cash)/i.test(value); }
function family(name) {
  return text(name).toUpperCase()
    .replace(/\bNIPPON INDIA\b/g, ' ')
    .replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g, ' ')
    .replace(/\(ERSTWHILE[^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  VALUES (?, ?, 'provisional', ?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id = excluded.portfolio_id,
  mapping_status = excluded.mapping_status, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP`);

function parseSheet(workbook, sheetName, index) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const details = index.get(sheetName);
  const date = dateFromDisclosure(rows[1]?.[1]);
  const headerIndex = rows.findIndex((row) => /name of the instrument/i.test(text(row[2])) && /%\s*to\s*nav/i.test(text(row[6])));
  if (!details || !date || headerIndex < 0) return null;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[2]);
    const isin = text(row[1]);
    const industryOrRating = text(row[3]);
    const quantity = number(row[4]);
    const marketValueLakh = number(row[5]);
    const publishedWeight = number(row[6]);
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
    holdings.push({ assetClass, holdingGroup, instrumentName, isin: isin || null, industryOrRating: industryOrRating || null,
      quantity, marketValueLakh, weight: publishedWeight == null ? null : publishedWeight / 100, yield: number(row[7]), yieldToCall: null });
  }
  const normalizedHoldings = normalizeHoldings(holdings, details.name);
  return normalizedHoldings.length ? { ...details, date, holdings: normalizedHoldings } : null;
}

async function main() {
  const target = previousMonthEnd();
  const yearShort = String(target.year).slice(-2);
  const fileName = `NIMF-MONTHLY-PORTFOLIO-${target.day}-${target.monthShort}-${yearShort}.xls`;
  const sourceUrl = `https://mf.nipponindiaim.com/InvestorServices/FactsheetsDocuments/${fileName}`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Nippon India has not published ${fileName} (${response.status}).`);
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer', cellDates: false });
  const indexRows = XLSX.utils.sheet_to_json(workbook.Sheets.Index, { header: 1, defval: null, raw: true });
  const index = new Map(indexRows.slice(1).map((row) => [text(row[0]), { sourceFundCode: text(row[0]), name: text(row[1]).replace(/\s*\([^)]*\)\s*/g, ' ').trim() }]).filter(([sheet, details]) => sheet && details.name));
  const portfolios = workbook.SheetNames.filter((sheet) => sheet !== 'Index').map((sheet) => parseSheet(workbook, sheet, index)).filter(Boolean);
  const result = db.transaction(() => {
    const disclosureDate = portfolios[0]?.date;
    if (!disclosureDate || portfolios.some((portfolio) => portfolio.date !== disclosureDate)) throw new Error('Nippon workbook contains no consistent portfolio disclosure date.');
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Nippon India monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, portfolio.date);
      portfolio.holdings.forEach((holding, position) => positionInsert.run(portfolioId, portfolio.date, position + 1, holding.assetClass, holding.holdingGroup, holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity, holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall));
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, disclosureDate, fileName, SOURCE_PAGE);
    const portfolioByFamily = new Map(db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?').all(AMC).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare("SELECT scheme_code, name FROM schemes WHERE amc = ? AND LOWER(name) LIKE '%growth%'").all(AMC)) {
      const portfolio = portfolioByFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { disclosureDate, portfolioCount: portfolios.length, holdingCount, mappedCount };
  })();
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Nippon India portfolios as of ${result.disclosureDate}; mapped ${result.mappedCount} Growth plans.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
