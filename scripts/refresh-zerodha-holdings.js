const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Zerodha Mutual Fund';
const SOURCE_PAGE = 'https://www.zerodhafundhouse.com/resources/disclosures/nav';
const MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4],
  ['may', 5], ['june', 6], ['july', 7], ['august', 8],
  ['september', 9], ['october', 10], ['november', 11], ['december', 12],
]);

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = typeof value === 'number'
    ? value
    : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function monthEnd(monthName, year) {
  const month = MONTHS.get(String(monthName).toLowerCase());
  if (!month) return null;
  return new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10);
}

function disclosureDate(value) {
  const match = text(value).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  return match ? monthEnd(match[1], match[2]) : null;
}

function family(value) {
  return text(value)
    .toUpperCase()
    .replace(/\b(ZERODHA|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(value);
}

function isSection(value) {
  return /^(equity|debt|money market|derivatives|units of|cash|others?|foreign securities|government securities|treasury bill|commercial paper|certificate of deposit|corporate debt|exchange traded funds|mutual fund units|repo|treps)/i.test(value);
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

function parseWorkbook(bytes, file) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
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
  const isinColumn = header.findIndex((cell) => /^isin$/.test(cell));
  const ratingColumn = header.findIndex((cell) => /rating|industry/.test(cell));
  const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
  const marketValueColumn = header.findIndex((cell) => /market value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*nav/.test(cell));
  const yieldColumn = header.findIndex((cell) => /ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const heading = rows
    .slice(0, headerIndex)
    .flat()
    .map(text)
    .find((cell) => /monthly portfolio statement/i.test(cell)) || file.name;
  const name = text(heading)
    .replace(/^.*?MONTHLY PORTFOLIO STATEMENT OF\s+/i, '')
    .replace(/\s+FOR\s+(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}.*$/i, '')
    .trim();
  const date = disclosureDate(heading) || disclosureDate(file.name);
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
    if (!instrumentName || isTotal(instrumentName)) continue;
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
      isin: isin && isin !== '-' ? isin : null,
      industryOrRating: industryOrRating && industryOrRating !== '-' ? industryOrRating : null,
      quantity,
      marketValueLakh,
      weight: publishedWeight,
      yield: publishedYield == null ? null : (Math.abs(publishedYield) <= 1 ? publishedYield * 100 : publishedYield),
      yieldToCall: null,
    });
  }
  return holdings.length
    ? { sourceFundCode: sheetName, name, date, holdings, sourceUrl: file.url }
    : null;
}

async function fetchPortfolios() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Zerodha disclosure page returned ${response.status}`);
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Zerodha disclosure metadata was not found.');
  const pageData = JSON.parse(match[1]);
  const reports = pageData.props?.pageProps?.initialReports || [];
  const monthly = reports
    .flatMap((report) => report.data || [])
    .find((report) => /^monthly portfolio$/i.test(text(report.title)));
  if (!monthly?.files?.length) throw new Error('Zerodha has not published usable monthly portfolio workbooks.');

  const datedFiles = monthly.files
    .map((file) => ({ ...file, date: disclosureDate(file.name) }))
    .filter((file) => file.date && /\.xlsx(?:$|\?)/i.test(file.url));
  const latestDate = datedFiles.reduce((latest, file) => file.date > latest ? file.date : latest, '');
  const latestFiles = datedFiles.filter((file) => file.date === latestDate);
  const portfolios = [];
  for (const file of latestFiles) {
    const workbookResponse = await fetch(encodeURI(file.url));
    if (!workbookResponse.ok) throw new Error(`Zerodha portfolio workbook returned ${workbookResponse.status}: ${file.url}`);
    const portfolio = parseWorkbook(Buffer.from(await workbookResponse.arrayBuffer()), file);
    if (portfolio) portfolios.push(portfolio);
  }
  return portfolios;
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error('Zerodha returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Zerodha monthly portfolio disclosure');
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
    importUpsert.run(AMC, asOfDate, `zerodha-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);

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
  console.log('Fetching Zerodha monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Zerodha portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
