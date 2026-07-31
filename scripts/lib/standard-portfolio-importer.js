const XLSX = require('xlsx');
const db = require('../../server/db');
const { normalizeHoldings } = require('./portfolio-normalization');

const text = (value) => value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const number = (value) => {
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const isTotal = (value) => /^(sub\s*total|total|grand\s*total|net current assets|net assets|margin deposited)/i.test(value)
  || /^total for/i.test(value);

const portfolioUpsert = db.prepare(`INSERT INTO holding_portfolios(amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?) ON CONFLICT(amc, source_fund_code) DO UPDATE SET name=excluded.name, description=excluded.description`);
const portfolioFind = db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?');
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const deleteAmcPositions = db.prepare(`DELETE FROM portfolio_holdings
  WHERE as_of_date = ? AND portfolio_id IN (SELECT portfolio_id FROM holding_portfolios WHERE amc = ?)`);
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

function defaultFamily(value, amcWords) {
  const removable = [...amcWords, 'DIRECT', 'REGULAR', 'PLAN', 'GROWTH', 'OPTION', 'IDCW', 'DIVIDEND', 'REINVESTMENT', 'PAYOUT']
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text(value).toUpperCase().split('(')[0]
    .replace(new RegExp(`\\b(?:${removable})\\b`, 'g'), ' ')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseWorkbook(bytes, item, config) {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const portfolios = [];
  for (const sheetName of workbook.SheetNames) {
    if (config.sheetFilter && !config.sheetFilter(sheetName, item)) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const headerIndex = rows.findIndex((row) => row.some((cell) => /name of.*instrument/i.test(text(cell))));
    if (headerIndex < 0) continue;
    const header = rows[headerIndex].map((cell) => text(cell).toLowerCase());
    const instrumentColumn = header.findIndex((cell) => /name of.*instrument/.test(cell));
    const isinColumn = header.findIndex((cell) => /isin/.test(cell));
    const ratingColumn = header.findIndex((cell) => /rating/.test(cell));
    const industryColumn = header.findIndex((cell) => /industry/.test(cell));
    const quantityColumn = header.findIndex((cell) => /quantity/.test(cell));
    const marketValueColumn = header.findIndex((cell) => /market.*value|fair value|mkt value/.test(cell));
    const weightColumn = header.findIndex((cell) => /(?:%|percentage)\s*(?:to|of)\s*(?:net\s*)?(?:assets?|nav|aum)/.test(cell));
    const yieldColumn = header.findIndex((cell) => /^(?:ytm|% yield|yield)/.test(cell));
    const callColumn = header.findIndex((cell) => /^ytc/.test(cell));
    if ([instrumentColumn, marketValueColumn, weightColumn].some((column) => column < 0)) continue;
    const name = config.nameFromRows?.(rows, headerIndex, sheetName, item)
      || text(rows.slice(0, headerIndex).flat().find((cell) => config.namePattern?.test(text(cell))))
      || sheetName;
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
        if (/^(equity|debt|money market|derivatives|government securities|units of|mutual fund units|cash|foreign|repo|treps)/i.test(instrumentName)) {
          assetClass = instrumentName;
          holdingGroup = null;
        } else {
          holdingGroup = instrumentName;
        }
        continue;
      }
      const isin = isinColumn >= 0 ? text(row[isinColumn]) : '';
      const rating = text(industryColumn >= 0 ? row[industryColumn] : null)
        || text(ratingColumn >= 0 ? row[ratingColumn] : null);
      holdings.push({
        assetClass, holdingGroup, instrumentName,
        isin: isin && !/^(nil|na|-)$/i.test(isin) ? isin : null,
        industryOrRating: rating && !/^(nil|na|-)$/i.test(rating) ? rating : null,
        quantity, marketValueLakh,
        weight: publishedWeight,
        yield: yieldColumn >= 0 ? number(row[yieldColumn]) : null,
        yieldToCall: callColumn >= 0 ? number(row[callColumn]) : null,
      });
    }
    const normalizedHoldings = normalizeHoldings(holdings, name);
    if (normalizedHoldings.length) portfolios.push({
      sourceFundCode: config.codeFromSheet?.(sheetName, item) || sheetName,
      name, date: item.asOfDate || config.asOfDate, holdings: normalizedHoldings, sourceUrl: item.sourceUrl,
    });
  }
  return portfolios;
}

async function importStandardPortfolios(config) {
  const items = await config.fetchItems();
  const portfolios = [];
  for (let index = 0; index < items.length; index += (config.concurrency || 6)) {
    const parsed = await Promise.all(items.slice(index, index + (config.concurrency || 6)).map(async (item) => {
      let bytes;
      if (config.fetchBytes) {
        bytes = await config.fetchBytes(item);
      } else {
        const response = await fetch(item.sourceUrl);
        if (!response.ok) throw new Error(`${config.amc} workbook returned ${response.status}: ${item.sourceUrl}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      return config.parseBytes
        ? config.parseBytes(bytes, item, config)
        : parseWorkbook(bytes, item, config);
    }));
    portfolios.push(...parsed.flat());
  }
  if (!portfolios.length) throw new Error(`${config.amc} returned no usable portfolios.`);
  const asOfDate = portfolios[0].date;
  if (!asOfDate || portfolios.some((portfolio) => portfolio.date !== asOfDate)) {
    throw new Error(`${config.amc} returned mixed or unreadable disclosure dates.`);
  }
  return db.transaction(() => {
    let holdingCount = 0;
    deleteAmcPositions.run(asOfDate, config.amc);
    for (const portfolio of portfolios) {
      portfolioUpsert.run(config.amc, portfolio.sourceFundCode, portfolio.name, config.description);
      const { portfolio_id: portfolioId } = portfolioFind.get(config.amc, portfolio.sourceFundCode);
      deletePositions.run(portfolioId, asOfDate);
      portfolio.holdings.forEach((holding, position) => positionInsert.run(
        portfolioId, asOfDate, position + 1, holding.assetClass, holding.holdingGroup,
        holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
        holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
      ));
      holdingCount += portfolio.holdings.length;
    }
    const sourceFile = typeof config.sourceFile === 'function' ? config.sourceFile(asOfDate) : config.sourceFile;
    importUpsert.run(config.amc, asOfDate, sourceFile, config.sourcePage);
    const family = (value) => config.family
      ? config.family(value)
      : defaultFamily(value, config.amcWords || config.amc.toUpperCase().split(/\s+/));
    const byFamily = new Map(db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?')
      .all(config.amc).map((portfolio) => [family(portfolio.name), portfolio]));
    let mappedCount = 0;
    for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(config.amc)) {
      const portfolio = byFamily.get(family(scheme.name));
      if (!portfolio) continue;
      mappingUpsert.run(scheme.scheme_code, portfolio.portfolio_id, config.sourcePage);
      mappedCount += 1;
    }
    return { asOfDate, holdingCount, portfolioCount: portfolios.length, mappedCount };
  })();
}

module.exports = { importStandardPortfolios, text };
