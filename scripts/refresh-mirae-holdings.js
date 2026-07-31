const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Mirae Asset Mutual Fund';
const SOURCE_PAGE = 'https://www.miraeassetmf.co.in/downloads/portfolio';
const API_URL = 'https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData';
const SITE_URL = 'https://www.miraeassetmf.co.in';

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = typeof value === 'number'
    ? value
    : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromText(value) {
  const input = text(value);
  const monthFirst = input.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i);
  const dayFirst = input.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  const parsed = monthFirst
    ? new Date(`${monthFirst[1]} ${monthFirst[2]}, ${monthFirst[3]} UTC`)
    : dayFirst
      ? new Date(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]} UTC`)
      : null;
  if (!parsed) return null;
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function family(value) {
  return text(value)
    .toUpperCase()
    .replace(/\bMIRAE ASSET\b/g, ' ')
    .replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
    .replace(/\bEXCHANGE TRADED\b/g, ' ETF ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(value);
}

function isSection(value) {
  return /^(equity|debt|money market|derivatives|units of|cash|others?|foreign securities|government securities|treasury bill|commercial paper|certificate of deposit|corporate debt|exchange traded funds|mutual fund units|repo|reverse repo|treps|listed|unlisted|\([a-z]\))/i.test(value);
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

function parseWorkbook(bytes, item) {
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
  const marketValueColumn = header.findIndex((cell) => /market\/fair value|market value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*net assets/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const date = rows.slice(0, headerIndex).flat().map(dateFromText).find(Boolean) || item.date;
  const name = text(rows[0]?.find((cell) => text(cell))) || item.name;
  const codeRow = rows.slice(0, headerIndex).find((row) => text(row[instrumentColumn]) === name);
  const sourceFundCode = text(codeRow?.[isinColumn]) || sheetName || item.url.split('/').pop();
  if (!date || !name || !sourceFundCode) return null;

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
      if (/^(equity|debt|money market|derivatives|units of|foreign|government)/i.test(instrumentName)) {
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
      isin: isin && isin !== '-' ? isin : null,
      industryOrRating: industryOrRating && industryOrRating !== '-' ? industryOrRating : null,
      quantity,
      marketValueLakh,
      weight: publishedWeight == null ? null : publishedWeight,
      yield: publishedYield == null ? null : (Math.abs(publishedYield) <= 1 ? publishedYield * 100 : publishedYield),
      yieldToCall: null,
    });
  }
  return holdings.length ? {
    sourceFundCode,
    name,
    date,
    holdings,
    sourceUrl: item.url,
  } : null;
}

async function fetchLatestItems() {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      request: { modulename: 'portfolio_tab1', pgno: 1, pgsize: 500 },
    }),
  });
  if (!response.ok) throw new Error(`Mirae disclosure API returned ${response.status}.`);
  const payload = await response.json();
  if (payload.ReturnCode !== '0' || !Array.isArray(payload.Data)) {
    throw new Error(payload.ReturnMsg || 'Mirae disclosure API returned no portfolio files.');
  }
  const items = payload.Data
    .map((item) => ({
      name: text(item.Title).replace(/^Portfolio Details as on .*? for /i, ''),
      date: dateFromText(item.Title),
      url: new URL(item.URL, SITE_URL).href,
    }))
    .filter((item) => item.date && /\.xlsx?(?:$|\?)/i.test(item.url));
  const latestDate = items.map((item) => item.date).sort().at(-1);
  const latest = items.filter((item) => item.date === latestDate);
  if (!latest.length) throw new Error('Mirae has not published a usable monthly portfolio workbook.');
  return latest;
}

async function fetchPortfolios() {
  const items = await fetchLatestItems();
  const portfolios = [];
  const concurrency = 6;
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const parsed = await Promise.all(batch.map(async (item) => {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`Mirae portfolio workbook returned ${response.status}: ${item.url}`);
      return parseWorkbook(Buffer.from(await response.arrayBuffer()), item);
    }));
    portfolios.push(...parsed.filter(Boolean));
  }
  return portfolios;
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error('Mirae returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Mirae Asset monthly portfolio disclosure');
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
    importUpsert.run(AMC, asOfDate, `mirae-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);

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
  console.log('Fetching Mirae Asset monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Mirae Asset portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
