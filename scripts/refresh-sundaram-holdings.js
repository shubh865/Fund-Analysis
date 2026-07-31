const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'Sundaram Mutual Fund';
const SOURCE_PAGE = 'https://www.sundarammutual.com/fund-portfolio';
const DATA_URL = 'https://www.sundarammutual.com/Upload/JSON/Monthly_Portfolio.json';
const SITE_URL = 'https://www.sundarammutual.com';

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
    .replace(/\b(SUNDARAM|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|net assets)/i.test(value)
    || /^total for/i.test(value);
}

function isSection(value) {
  return /^(equity|debt|money market|derivatives|units of|cash|others?|foreign securities|government securities|treasury bill|commercial paper|certificate of deposit|corporate debt|exchange traded funds|mutual fund units|repo|reverse repo|treps|[a-z]\)|\([a-z]\))/i.test(value);
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
  const marketValueColumn = header.findIndex((cell) => /mkt value|market value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*of\s*net asset/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const name = text(rows.slice(0, headerIndex).flat().find((cell) => /^sundaram\b/i.test(text(cell)) && !/mutual fund$/i.test(text(cell))))
    || item.GROUP_NAME;
  const date = String(item.PORTFOLIO_DATE).slice(0, 10);
  if (!name || !date) return null;

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
    if (isSection(instrumentName) && quantity == null && marketValueLakh == null && publishedWeight == null) {
      if (/^(?:[a-z]\)\s*)?(equity|debt|money market|derivatives|foreign securities|government securities|mutual fund units)/i.test(instrumentName)) {
        assetClass = instrumentName;
        holdingGroup = null;
      } else {
        holdingGroup = instrumentName;
      }
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
      isin: isin && !/^nil$|^na$|^-$/i.test(isin) ? isin : null,
      industryOrRating: industryOrRating && !/^nil$|^na$|^-$/i.test(industryOrRating) ? industryOrRating : null,
      quantity,
      marketValueLakh,
      weight: publishedWeight,
      yield: publishedYield,
      yieldToCall: null,
    });
  }
  const normalizedHoldings = normalizeHoldings(holdings, name);
  return normalizedHoldings.length ? {
    sourceFundCode: item.FUNDGROUP_ID || sheetName,
    name,
    date,
    holdings: normalizedHoldings,
    sourceUrl,
  } : null;
}

async function fetchPortfolios() {
  const dataResponse = await fetch(DATA_URL);
  if (!dataResponse.ok) throw new Error(`Sundaram portfolio index returned ${dataResponse.status}.`);
  const items = await dataResponse.json();
  const latestDate = items.map((item) => String(item.PORTFOLIO_DATE).slice(0, 10)).sort().at(-1);
  const latestItems = items.filter((item) => String(item.PORTFOLIO_DATE).startsWith(latestDate) && item.PORTFOLIO_PATH);
  if (!latestItems.length) throw new Error('Sundaram has not published usable monthly portfolio workbooks.');

  const portfolios = [];
  const concurrency = 6;
  for (let index = 0; index < latestItems.length; index += concurrency) {
    const batch = latestItems.slice(index, index + concurrency);
    const parsed = await Promise.all(batch.map(async (item) => {
      const sourceUrl = new URL(item.PORTFOLIO_PATH, SITE_URL).href;
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Sundaram portfolio workbook returned ${response.status}: ${sourceUrl}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const isCompound = bytes[0] === 0xd0 && bytes[1] === 0xcf;
      if (!isZip && !isCompound) {
        console.warn(`Skipping unreadable Sundaram workbook for ${item.GROUP_NAME}.`);
        return null;
      }
      try {
        return parseWorkbook(bytes, item, sourceUrl);
      } catch (error) {
        console.warn(`Skipping ${item.GROUP_NAME}: ${error.message}`);
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
    throw new Error('Sundaram returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Sundaram monthly portfolio disclosure');
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
    importUpsert.run(AMC, asOfDate, `sundaram-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);

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
  console.log('Fetching Sundaram monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Sundaram portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
