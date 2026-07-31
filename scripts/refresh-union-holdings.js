const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Union Mutual Fund';
const SOURCE_PAGE = 'https://www.unionmf.com/about-us/downloads';
const API_URL = 'https://www.unionmf.com/api/downloads/documents?$filter=FolderId%20eq%204e8d856a-158b-43a0-bc2f-6e46547ab475&$orderby=Yearfilter%20desc';
const SITE_URL = 'https://www.unionmf.com';

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = typeof value === 'number'
    ? value
    : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function family(value) {
  return text(value)
    .toUpperCase()
    .split('(')[0]
    .replace(/\b(UNION|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|net assets)/i.test(value)
    || /^total for/i.test(value);
}

const portfolioUpsert = db.prepare(`
  INSERT INTO holding_portfolios(amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, source_fund_code)
  DO UPDATE SET name = excluded.name, description = excluded.description
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
  ON CONFLICT(scheme_code)
  DO UPDATE SET portfolio_id = excluded.portfolio_id,
                mapping_status = excluded.mapping_status,
                source_url = excluded.source_url,
                updated_at = CURRENT_TIMESTAMP
`);

function parseWorkbook(bytes, item, sourceUrl) {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: null,
    raw: true,
  });
  const headerIndex = rows.findIndex((row) => row.some((cell) => /name of the instrument/i.test(text(cell))));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex].map((cell) => text(cell).toLowerCase());
  const instrumentColumn = header.findIndex((cell) => /name of the instrument/.test(cell));
  const isinColumn = header.findIndex((cell) => /isin/.test(cell));
  const ratingColumn = header.findIndex((cell) => /rating|industry/.test(cell));
  const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
  const marketValueColumn = header.findIndex((cell) => /market value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*nav/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const name = text(item.Title)
    .replace(/^Monthly Portfolio Report\s+/i, '')
    .replace(/\s+\d{2}-\d{2}-\d{4}$/i, '');
  const dateMatch = text(item.Title).match(/(\d{2})-(\d{2})-(\d{4})$/);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[instrumentColumn]);
    const isin = isinColumn >= 0 ? text(row[isinColumn]) : '';
    const industryOrRating = ratingColumn >= 0 ? text(row[ratingColumn]) : '';
    const quantity = quantityColumn >= 0 ? number(row[quantityColumn]) : null;
    const marketValueLakh = number(row[marketValueColumn]);
    const publishedWeight = number(row[weightColumn]);
    const publishedYield = yieldColumn >= 0 ? number(row[yieldColumn]) : null;
    if (!instrumentName || /^nil$/i.test(instrumentName) || isTotal(instrumentName)) continue;
    if (quantity == null && marketValueLakh == null && publishedWeight == null) {
      if (/^(equity|debt|money market|derivatives|foreign securities|government securities|units of|mutual fund units|cash)/i.test(instrumentName)) {
        assetClass = instrumentName;
        holdingGroup = null;
      } else {
        holdingGroup = instrumentName;
      }
      continue;
    }
    holdings.push({
      assetClass,
      holdingGroup,
      instrumentName,
      isin: isin && !/^(nil|na|-)$/i.test(isin) ? isin : null,
      industryOrRating: industryOrRating && !/^(nil|na|-)$/i.test(industryOrRating) ? industryOrRating : null,
      quantity,
      marketValueLakh,
      weight: publishedWeight == null ? null : publishedWeight / 100,
      yield: publishedYield,
      yieldToCall: null,
    });
  }
  return holdings.length && name && date ? {
    sourceFundCode: item.Id,
    name,
    date,
    holdings,
    sourceUrl,
  } : null;
}

async function fetchPortfolios() {
  const indexResponse = await fetch(API_URL);
  if (!indexResponse.ok) throw new Error(`Union portfolio API returned ${indexResponse.status}.`);
  const items = (await indexResponse.json()).value.filter((item) => item.Extension === '.xlsx' && item.Url);
  if (!items.length) throw new Error('Union has not published usable monthly portfolio workbooks.');
  const portfolios = [];
  for (let index = 0; index < items.length; index += 6) {
    const parsed = await Promise.all(items.slice(index, index + 6).map(async (item) => {
      const sourceUrl = new URL(item.Url, SITE_URL).href;
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Union portfolio workbook returned ${response.status}: ${sourceUrl}`);
      try {
        return parseWorkbook(Buffer.from(await response.arrayBuffer()), item, sourceUrl);
      } catch (error) {
        console.warn(`Skipping ${item.Title}: ${error.message}`);
        return null;
      }
    }));
    portfolios.push(...parsed.filter(Boolean));
  }
  return portfolios;
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error('Union returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Union monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, index) => {
        positionInsert.run(
          portfolioId, asOfDate, index + 1, holding.assetClass, holding.holdingGroup,
          holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
          holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
        );
      });
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, asOfDate, `union-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);
    const byFamily = new Map(
      db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?')
        .all(AMC)
        .map((portfolio) => [family(portfolio.name), portfolio]),
    );
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
  console.log('Fetching Union monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Union portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
