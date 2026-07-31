const XLSX = require('xlsx');
const db = require('../server/db');
const { normalizeHoldings } = require('./lib/portfolio-normalization');

const AMC = 'Samco Mutual Fund';
const SOURCE_PAGE = 'https://www.samcomf.com/StatutoryDisclosure';

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function family(value) {
  return text(value).toUpperCase().split('(')[0]
    .replace(/\b(SAMCO|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|PAYOUT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isTotal(value) {
  return /^(sub\s*total|total|grand\s*total|net current assets|net assets|margin deposited)/i.test(value)
    || /^total for/i.test(value);
}

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
  ON CONFLICT(scheme_code)
  DO UPDATE SET portfolio_id = excluded.portfolio_id, mapping_status = excluded.mapping_status,
                source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP
`);

function parseWorkbook(bytes, sourceUrl) {
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
  const weightColumn = header.findIndex((cell) => /%\s*to\s*(net\s*)?assets?/.test(cell));
  const yieldColumn = header.findIndex((cell) => /^ytm/.test(cell));
  if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) return null;

  const heading = text(rows.slice(0, headerIndex).flat().find((cell) => /monthly portfolio statement of/i.test(text(cell))));
  const match = heading.match(/MONTHLY PORTFOLIO STATEMENT OF\s+(.+?)\s+AS ON\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const name = text(match[1]);
  const date = `${match[4]}-${months[match[2].toLowerCase()]}-${String(match[3]).padStart(2, '0')}`;
  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const instrumentName = text(row[instrumentColumn]);
    const isin = isinColumn >= 0 ? text(row[isinColumn]) : '';
    const industryOrRating = ratingColumn >= 0 ? text(row[ratingColumn]) : '';
    const quantity = quantityColumn >= 0 ? number(row[quantityColumn]) : null;
    const marketValueLakh = number(row[marketValueColumn]);
    const weight = number(row[weightColumn]);
    const publishedYield = yieldColumn >= 0 ? number(row[yieldColumn]) : null;
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
    holdings.push({
      assetClass, holdingGroup, instrumentName,
      isin: isin && !/^(nil|na|-)$/i.test(isin) ? isin : null,
      industryOrRating: industryOrRating && !/^(nil|na|-)$/i.test(industryOrRating) ? industryOrRating : null,
      quantity, marketValueLakh, weight, yield: publishedYield, yieldToCall: null,
    });
  }
  const normalizedHoldings = normalizeHoldings(holdings, name);
  return normalizedHoldings.length ? { sourceFundCode: sheetName, name, date, holdings: normalizedHoldings, sourceUrl } : null;
}

async function fetchPortfolios() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Samco disclosure page returned ${response.status}.`);
  const html = await response.text();
  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const candidates = [...html.matchAll(/href="(https:\/\/media1\.samco\.in\/scomamc\/amc_documents\/[^" ]+\.xlsx)\s*"/gi)]
    .map((match) => match[1])
    .filter((url) => /monthly[_-]?portfolio|portfolio[_-]?monthly/i.test(url))
    .map((url) => {
      const named = url.match(/(January|February|March|April|May|June|July|August|September|October|November|December)[_-]?(\d{4})/i);
      const compact = url.match(/(?:_|-)(\d{2})(\d{2})(\d{4})(?:[^0-9]|$)/);
      const date = named
        ? `${named[2]}-${months[named[1].toLowerCase()]}-${new Date(Date.UTC(Number(named[2]), Number(months[named[1].toLowerCase()]), 0)).getUTCDate()}`
        : compact ? `${compact[3]}-${compact[2]}-${compact[1]}` : null;
      return { url, date };
    }).filter((item) => item.date);
  const latestDate = candidates.map((item) => item.date).sort().at(-1);
  const urls = candidates.filter((item) => item.date === latestDate).map((item) => item.url);
  if (!urls.length) throw new Error('Samco has not published a usable monthly portfolio workbook.');
  const byFamily = new Map();
  for (let index = 0; index < urls.length; index += 6) {
    const parsed = await Promise.all(urls.slice(index, index + 6).map(async (sourceUrl) => {
      const workbookResponse = await fetch(sourceUrl);
      if (!workbookResponse.ok) throw new Error(`Samco workbook returned ${workbookResponse.status}: ${sourceUrl}`);
      return parseWorkbook(Buffer.from(await workbookResponse.arrayBuffer()), sourceUrl);
    }));
    for (const portfolio of parsed.filter(Boolean)) byFamily.set(family(portfolio.name), portfolio);
  }
  return [...byFamily.values()];
}

function savePortfolios(portfolios) {
  const asOfDate = portfolios[0]?.date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error('Samco returned mixed or unreadable disclosure dates.');
  }
  return db.transaction(() => {
    let holdingCount = 0;
    for (const portfolio of portfolios) {
      portfolioUpsert.run(AMC, portfolio.sourceFundCode, portfolio.name, 'Samco monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, index) => positionInsert.run(
        portfolioId, asOfDate, index + 1, holding.assetClass, holding.holdingGroup,
        holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
        holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
      ));
      holdingCount += portfolio.holdings.length;
    }
    importUpsert.run(AMC, asOfDate, `samco-portfolios-${asOfDate}.xlsx`, SOURCE_PAGE);
    const portfolioFamilies = new Map(db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?')
      .all(AMC).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
      const portfolio = portfolioFamilies.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_PAGE);
      mappedCount += 1;
    }
    return { asOfDate, holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

async function main() {
  console.log('Fetching Samco monthly portfolio disclosures...');
  const result = savePortfolios(await fetchPortfolios());
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Samco portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
