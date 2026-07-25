const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'ICICI Prudential Mutual Fund';
const DEFAULT_SOURCE_URL = 'https://www.icicipruamc.com/media-center/downloads?currentTabFilter=Disclosures&subCatTabFilter=MonthlyPortfolioDisclosures';
const [inputPath, ...args] = process.argv.slice(2);

if (!inputPath || inputPath.startsWith('--')) {
  console.error('Usage: node scripts/import-icici-holdings.js <monthly-disclosure.zip> [--source-url URL]');
  process.exit(1);
}

const sourceUrlIndex = args.indexOf('--source-url');
const sourceUrl = sourceUrlIndex >= 0 ? args[sourceUrlIndex + 1] : DEFAULT_SOURCE_URL;
if (sourceUrlIndex >= 0 && !sourceUrl) {
  console.error('--source-url needs a URL.');
  process.exit(1);
}

const resolvedInput = path.resolve(inputPath);
if (!fs.existsSync(resolvedInput)) {
  console.error(`File not found: ${resolvedInput}`);
  process.exit(1);
}
if (path.extname(resolvedInput).toLowerCase() !== '.zip') {
  console.error('ICICI monthly disclosures must be supplied as the official ZIP archive.');
  process.exit(1);
}

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = text(value).replace(/,/g, '');
  if (!normalized || /^nil$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOfDate(value) {
  const match = text(value).match(/portfolio as on\s+([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function sourceFundCode(name) {
  return text(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isSubtotal(name) {
  return /^(sub\s*total|total|grand\s*total|total net assets|net current assets)/i.test(name);
}

function isSection(name) {
  return /^(equity\b|debt instruments|money market instruments|others$|derivative|units of an alternative investment fund)/i.test(name);
}

function isGroup(name) {
  return /^(listed|unlisted|securitized debt|term deposits|deposits \(|certificate of deposits|commercial papers|treasury bills|treps$|cash and cash equivalents)/i.test(name);
}

const portfolioUpsert = db.prepare(`
  INSERT INTO holding_portfolios (amc, source_fund_code, name, description)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, source_fund_code) DO UPDATE SET
    name = excluded.name,
    description = excluded.description
`);
const portfolioFind = db.prepare(`
  SELECT portfolio_id FROM holding_portfolios WHERE amc = ? AND source_fund_code = ?
`);
const deletePositions = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
const positionInsert = db.prepare(`
  INSERT INTO portfolio_holdings (
    portfolio_id, as_of_date, position_order, asset_class, holding_group,
    instrument_name, isin, industry_or_rating, quantity, market_value_lakh,
    weight, yield, yield_to_call
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const importUpsert = db.prepare(`
  INSERT INTO holding_imports (amc, as_of_date, source_file, source_url)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(amc, as_of_date, source_file) DO UPDATE SET
    source_url = excluded.source_url,
    imported_at = CURRENT_TIMESTAMP
`);

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return null;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const fundName = text(rows[1]?.[1]);
  const date = asOfDate(rows[2]?.[1]);
  if (!fundName || !date) return null;

  const holdings = [];
  let assetClass = null;
  let holdingGroup = null;
  for (const row of rows.slice(4)) {
    const instrumentName = text(row[1]);
    if (!instrumentName) continue;
    if (isSection(instrumentName)) {
      assetClass = instrumentName;
      holdingGroup = null;
      continue;
    }
    if (isGroup(instrumentName)) {
      holdingGroup = instrumentName;
      continue;
    }
    if (isSubtotal(instrumentName)) continue;

    const quantity = number(row[5]);
    const marketValueLakh = number(row[6]);
    const weight = number(row[7]);
    if (quantity == null && marketValueLakh == null && weight == null) continue;
    holdings.push({
      assetClass,
      holdingGroup,
      instrumentName,
      isin: text(row[2]) || null,
      industryOrRating: text(row[4]) || null,
      quantity,
      marketValueLakh,
      weight,
      yield: number(row[8]),
      yieldToCall: number(row[9]),
    });
  }
  return { fundName, date, holdings };
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'icici-portfolio-'));
try {
  execFileSync('tar', ['-xf', resolvedInput, '-C', temporaryDirectory], { stdio: 'pipe' });
  const workbookPaths = fs.readdirSync(temporaryDirectory)
    .filter((name) => /\.xlsx$/i.test(name))
    .map((name) => path.join(temporaryDirectory, name));
  if (!workbookPaths.length) throw new Error('No Excel workbooks were found in the ICICI disclosure archive.');

  const result = db.transaction(() => {
    let disclosureDate = null;
    let portfolioCount = 0;
    let holdingCount = 0;
    for (const workbookPath of workbookPaths) {
      const portfolio = parseWorkbook(workbookPath);
      if (!portfolio) continue;
      if (!disclosureDate) disclosureDate = portfolio.date;
      if (disclosureDate !== portfolio.date) {
        throw new Error(`Mixed disclosure dates found: ${disclosureDate} and ${portfolio.date}.`);
      }
      const fundCode = sourceFundCode(portfolio.fundName);
      portfolioUpsert.run(AMC, fundCode, portfolio.fundName, 'ICICI Prudential monthly portfolio disclosure');
      const { portfolio_id: portfolioId } = portfolioFind.get(AMC, fundCode);
      deletePositions.run(portfolioId, portfolio.date);
      portfolio.holdings.forEach((holding, index) => {
        positionInsert.run(
          portfolioId, portfolio.date, index + 1, holding.assetClass, holding.holdingGroup,
          holding.instrumentName, holding.isin, holding.industryOrRating, holding.quantity,
          holding.marketValueLakh, holding.weight, holding.yield, holding.yieldToCall,
        );
      });
      portfolioCount += 1;
      holdingCount += portfolio.holdings.length;
    }
    if (!disclosureDate) throw new Error('No ICICI portfolio workbooks with a recognised disclosure date were found.');
    importUpsert.run(AMC, disclosureDate, path.basename(resolvedInput), sourceUrl);
    return { disclosureDate, portfolioCount, holdingCount };
  })();
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} ICICI portfolios as of ${result.disclosureDate}.`);
} finally {
  const resolvedTemporary = path.resolve(temporaryDirectory);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (resolvedTemporary.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
    fs.rmSync(resolvedTemporary, { recursive: true, force: true });
  }
}
