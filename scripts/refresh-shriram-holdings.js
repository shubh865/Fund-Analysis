const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Shriram Mutual Fund';
const SOURCE_PAGE = 'https://www.shriramamc.in/investor-statutory-disclosures';
let sourceUrl = null;
let asOfDate = null;

const text = (value) => value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const number = (value) => {
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const family = (value) => text(value).toUpperCase().split('(')[0]
  .replace(/\b(SHRIRAM|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const isTotal = (value) => /^(sub\s*total|total|grand\s*total|net current assets|net assets)/i.test(value)
  || /^total for/i.test(value);

const portfolioUpsert = db.prepare(`
  INSERT INTO holding_portfolios(amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, source_fund_code) DO UPDATE SET name = excluded.name, description = excluded.description
`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`
  INSERT INTO portfolio_holdings(
    portfolio_id, as_of_date, position_order, asset_class, holding_group,
    instrument_name, isin, industry_or_rating, quantity, market_value_lakh,
    weight, yield, yield_to_call
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const importUpsert = db.prepare(`
  INSERT INTO holding_imports(amc, as_of_date, source_file, source_url)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, as_of_date, source_file)
  DO UPDATE SET source_url = excluded.source_url, imported_at = CURRENT_TIMESTAMP
`);
const mappingUpsert = db.prepare(`
  INSERT INTO scheme_portfolio_mappings(scheme_code, portfolio_id, mapping_status, source_url)
  VALUES (?, ?, 'provisional', ?)
  ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id = excluded.portfolio_id,
    mapping_status = excluded.mapping_status, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP
`);

function parseSheet(workbook, sheetName) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const headerIndex = rows.findIndex((row) => row.some((cell) => /name of.*instrument/i.test(text(cell))));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex].map((cell) => text(cell).toLowerCase());
  const instrumentColumn = header.findIndex((cell) => /name of.*instrument/.test(cell));
  const isinColumn = header.findIndex((cell) => /isin/.test(cell));
  const ratingColumn = header.findIndex((cell) => /rating|industry/.test(cell));
  const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
  const marketValueColumn = header.findIndex((cell) => /market.*value|fair value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*net assets/.test(cell));
  const yieldColumn = header.findIndex((cell) => /yield|ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;
  const name = text(rows[0]?.find((cell) => text(cell))) || sheetName;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[instrumentColumn]);
    const quantity = quantityColumn >= 0 ? number(row[quantityColumn]) : null;
    const marketValueLakh = number(row[marketValueColumn]);
    const publishedWeight = number(row[weightColumn]);
    if (!instrumentName || /^nil$/i.test(instrumentName) || isTotal(instrumentName)) continue;
    if (quantity == null && marketValueLakh == null && publishedWeight == null) {
      if (/^(equity|debt|money market|derivatives|government securities|units of|cash|foreign)/i.test(instrumentName)) {
        assetClass = instrumentName;
        holdingGroup = null;
      } else {
        holdingGroup = instrumentName;
      }
      continue;
    }
    const isin = isinColumn >= 0 ? text(row[isinColumn]) : '';
    const industryOrRating = ratingColumn >= 0 ? text(row[ratingColumn]) : '';
    holdings.push({
      assetClass, holdingGroup, instrumentName,
      isin: isin && !/^(nil|na|-)$/i.test(isin) ? isin : null,
      industryOrRating: industryOrRating && !/^(nil|na|-)$/i.test(industryOrRating) ? industryOrRating : null,
      quantity, marketValueLakh,
      weight: publishedWeight == null ? null : publishedWeight / 100,
      yield: yieldColumn >= 0 ? number(row[yieldColumn]) : null,
      yieldToCall: null,
    });
  }
  return holdings.length ? { sourceFundCode: sheetName, name, date: asOfDate, holdings, sourceUrl } : null;
}

async function discoverLatestSource() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Shriram disclosure page returned ${response.status}.`);
  const html = (await response.text()).replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  const candidates = [...html.matchAll(/https?:[^"'<>\s]+Monthly-Portfolio-Shriram-Mutual-Fund-([A-Za-z]+)-(\d{4})\.xls/gi)]
    .map((match) => {
      const month = new Date(`${match[1]} 1, ${match[2]} UTC`).getUTCMonth();
      if (!Number.isInteger(month) || month < 0) return null;
      const year = Number(match[2]);
      const day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return {
        url: match[0],
        date: `${year}-${String(month + 1).padStart(2, '0')}-${day}`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.date.localeCompare(left.date));
  if (!candidates.length) throw new Error('Shriram monthly portfolio workbook link was not found.');
  sourceUrl = candidates[0].url;
  asOfDate = candidates[0].date;
}

async function fetchPortfolios() {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Shriram monthly portfolio workbook returned ${response.status}.`);
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  return workbook.SheetNames.map((sheetName) => parseSheet(workbook, sheetName)).filter(Boolean);
}

function savePortfolios(portfolios) {
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Shriram monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, index) => positionInsert.run(
        portfolioId, asOfDate, index + 1, holding.assetClass, holding.holdingGroup,
        holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
        holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
      ));
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, asOfDate, `shriram-portfolios-${asOfDate}.xls`, SOURCE_PAGE);
    const byFamily = new Map(db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?')
      .all(AMC).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
      const portfolio = byFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

async function main() {
  console.log('Fetching Shriram monthly portfolio disclosure...');
  await discoverLatestSource();
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Shriram portfolios as of ${asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
