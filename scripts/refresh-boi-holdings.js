const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'Bank of India Mutual Fund';
const SOURCE_PAGE = 'https://www.boimf.in/investor-corner#t2';
const API_URL = 'https://www.boimf.in/AjaxService.asmx/GetDocuments';

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
  const match = text(value).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})\b/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function family(value) {
  return text(value)
    .toUpperCase()
    .split('(')[0]
    .replace(/\b(BANK OF INDIA|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|net assets|total net assets)/i.test(value);
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

function parseSheet(workbook, sheetName, fallbackDate, sourceUrl) {
  if (/^index$/i.test(sheetName)) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: null,
    raw: true,
  });
  const headerIndex = rows.findIndex((row) => row.some((cell) => /name of the instrument/i.test(text(cell))));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex].map((cell) => text(cell).toLowerCase());
  const instrumentColumn = header.findIndex((cell) => /name of the instrument/.test(cell));
  const isinColumn = header.findIndex((cell) => /^isin/.test(cell));
  const ratingColumn = header.findIndex((cell) => /rating|industry/.test(cell));
  const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
  const marketValueColumn = header.findIndex((cell) => /market\/fair value|market value/.test(cell));
  const weightColumn = header.findIndex((cell) => /%\s*to\s*net assets/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const name = text(rows.slice(0, headerIndex).flat().find((cell) => /^bank of india\b/i.test(text(cell)) && !/mutual fund$/i.test(text(cell))))
    .split('(')[0].trim() || sheetName;
  const date = rows.slice(0, headerIndex).flat().map(dateFromText).find(Boolean) || fallbackDate;
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
      if (/^(equity|debt|money market|derivatives|foreign securities|government securities|mutual fund units)/i.test(instrumentName)) {
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
      yield: publishedYield == null ? null : (Math.abs(publishedYield) <= 1 ? publishedYield * 100 : publishedYield),
      yieldToCall: null,
    });
  }
  const normalizedHoldings = normalizeHoldings(holdings, name);
  return normalizedHoldings.length
    ? { sourceFundCode: sheetName, name, date, holdings: normalizedHoldings, sourceUrl }
    : null;
}

async function fetchPortfolios() {
  const indexResponse = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      pagno: 0,
      category: null,
      fromDate: null,
      toDate: null,
      LibraryName: 'InvestorCorner',
      folderName: 'MONTHLY PORTFOLIO',
      CategoryValue: 'no',
    }),
  });
  if (!indexResponse.ok) throw new Error(`Bank of India disclosure API returned ${indexResponse.status}.`);
  const envelope = await indexResponse.json();
  const payload = JSON.parse(envelope.d || '{}');
  const documents = payload.Documents || [];
  const latest = documents
    .filter((document) => /\.xlsx?(?:$|\?)/i.test(document.FolderUrl || ''))
    .sort((left, right) => {
      const rightTimestamp = Number(String(right.CustomFolderDate).match(/\d+/)?.[0] || 0);
      const leftTimestamp = Number(String(left.CustomFolderDate).match(/\d+/)?.[0] || 0);
      return rightTimestamp - leftTimestamp;
    })[0];
  if (!latest) throw new Error('Bank of India has not published a usable monthly portfolio workbook.');

  const workbookResponse = await fetch(latest.FolderUrl);
  if (!workbookResponse.ok) throw new Error(`Bank of India portfolio workbook returned ${workbookResponse.status}.`);
  const workbook = XLSX.read(Buffer.from(await workbookResponse.arrayBuffer()), { type: 'buffer' });
  const fallbackDate = dateFromText(latest.DocName.replace(/(\d{1,2})-([A-Z]+)-(\d{4})/i, '$2 $1, $3'));
  return workbook.SheetNames
    .map((sheetName) => parseSheet(workbook, sheetName, fallbackDate, latest.FolderUrl))
    .filter(Boolean);
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error('Bank of India returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Bank of India monthly portfolio disclosure');
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
    importUpsert.run(AMC, asOfDate, `boi-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);

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
  console.log('Fetching Bank of India monthly portfolio disclosure...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Bank of India portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
