const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'NJ Mutual Fund';
const SOURCE_PAGE = 'https://downloads.njmutualfund.com/njmf_download.php?nme=127';
const SITE_URL = 'https://downloads.njmutualfund.com/';

const text = (value) => value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const number = (value) => {
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const family = (value) => text(value).toUpperCase().split('(')[0]
  .replace(/\b(NJ|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT|SCHEME)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const isTotal = (value) => /^(sub\s*total|total|grand\s*total|net current assets|net assets)/i.test(value)
  || /^total for/i.test(value);

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios(amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?) ON CONFLICT(amc, source_fund_code) DO UPDATE SET name=excluded.name, description=excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`INSERT INTO portfolio_holdings(
  portfolio_id, as_of_date, position_order, asset_class, holding_group, instrument_name, isin,
  industry_or_rating, quantity, market_value_lakh, weight, yield, yield_to_call
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importUpsert = db.prepare(`INSERT INTO holding_imports(amc, as_of_date, source_file, source_url)
  VALUES (?, ?, ?, ?) ON CONFLICT(amc, as_of_date, source_file)
  DO UPDATE SET source_url=excluded.source_url, imported_at=CURRENT_TIMESTAMP`);
const mappingUpsert = db.prepare(`INSERT INTO scheme_portfolio_mappings(scheme_code, portfolio_id, mapping_status, source_url)
  VALUES (?, ?, 'provisional', ?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id=excluded.portfolio_id,
  mapping_status=excluded.mapping_status, source_url=excluded.source_url, updated_at=CURRENT_TIMESTAMP`);

function parseWorkbook(bytes, sourceUrl, date) {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const headerIndex = rows.findIndex((row) => row.some((cell) => /name of the instrument/i.test(text(cell))));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex].map((cell) => text(cell).toLowerCase());
  const instrumentColumn = header.findIndex((cell) => /name of the instrument/.test(cell));
  const isinColumn = header.findIndex((cell) => /isin/.test(cell));
  const ratingColumn = header.findIndex((cell) => /rating|industry/.test(cell));
  const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
  const marketValueColumn = header.findIndex((cell) => /market.*value|fair value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*net assets/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  const callColumn = header.findIndex((cell) => /^ytc/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;
  const name = text(rows[1]?.find((cell) => text(cell))) || sheetName;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[instrumentColumn]);
    const quantity = quantityColumn >= 0 ? number(row[quantityColumn]) : null;
    const marketValueLakh = number(row[marketValueColumn]);
    const weight = number(row[weightColumn]);
    if (!instrumentName || /^nil$/i.test(instrumentName) || isTotal(instrumentName)) continue;
    if (quantity == null && marketValueLakh == null && weight == null) {
      if (/^(equity|debt|money market|derivatives|government securities|units of|cash|foreign)/i.test(instrumentName)) {
        assetClass = instrumentName;
        holdingGroup = null;
      } else {
        holdingGroup = instrumentName;
      }
      continue;
    }
    const isin = isinColumn >= 0 ? text(row[isinColumn]) : '';
    const rating = ratingColumn >= 0 ? text(row[ratingColumn]) : '';
    holdings.push({
      assetClass, holdingGroup, instrumentName,
      isin: isin && !/^(nil|na|-)$/i.test(isin) ? isin : null,
      industryOrRating: rating && !/^(nil|na|-)$/i.test(rating) ? rating : null,
      quantity, marketValueLakh, weight,
      yield: yieldColumn >= 0 ? number(row[yieldColumn]) : null,
      yieldToCall: callColumn >= 0 ? number(row[callColumn]) : null,
    });
  }
  return holdings.length ? { sourceFundCode: sheetName, name, date, holdings, sourceUrl } : null;
}

async function fetchPortfolios() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`NJ disclosure page returned ${response.status}.`);
  const html = await response.text();
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const candidates = [...html.matchAll(/href="(viewfile\.php\?file=NJ-MF-Monthly-Portfolio-[^"]+-(January|February|March|April|May|June|July|August|September|October|November|December)-(\d{4})-[^"]+\.xlsx)"/gi)]
    .map((match) => ({
      path: match[1],
      date: new Date(Date.UTC(Number(match[3]), months[match[2].toLowerCase()], 0)).toISOString().slice(0, 10),
    }));
  const latestDate = candidates.map((item) => item.date).sort().at(-1);
  const latest = candidates.filter((item) => item.date === latestDate);
  if (!latest.length) throw new Error('NJ has not published monthly portfolio workbooks.');
  return (await Promise.all(latest.map(async (item) => {
    const sourceUrl = new URL(item.path, SITE_URL).href;
    const workbookResponse = await fetch(sourceUrl);
    if (!workbookResponse.ok) throw new Error(`NJ portfolio workbook returned ${workbookResponse.status}: ${sourceUrl}`);
    return parseWorkbook(Buffer.from(await workbookResponse.arrayBuffer()), sourceUrl, item.date);
  }))).filter(Boolean);
}

function savePortfolios(portfolios) {
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'NJ monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, portfolio.date);
      portfolio.holdings.forEach((holding, index) => positionInsert.run(
        portfolioId, portfolio.date, index + 1, holding.assetClass, holding.holdingGroup,
        holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
        holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
      ));
      holdingCount += portfolio.holdings.length;
    }
    const asOfDate = portfolios[0].date;
    importUpsert.run(AMC, asOfDate, `nj-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);
    const byFamily = new Map(db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?')
      .all(AMC).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
      const portfolio = byFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { asOfDate, holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

async function main() {
  console.log('Fetching NJ monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} NJ portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
