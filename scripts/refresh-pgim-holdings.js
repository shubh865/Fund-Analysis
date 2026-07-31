const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.pgimindia.com/mutual-funds/disclosures/Portfolios/Monthly-Portfolio';
const API_URL = 'https://www.pgimindia.com/api/v1/brochure/published/disclosure';
const HEADERS = {
  accept: 'application/json, text/plain, */*',
  browser: 'Chrome',
  checkenc: 'false',
  'content-type': 'application/json',
  deviceos: 'Windows',
  referer: SOURCE_PAGE,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
};

const monthNumber = (month) => String(new Date(`${month} 1, 2000`).getMonth() + 1).padStart(2, '0');
const disclosureDate = (item) => `${item.year}-${monthNumber(item.month)}-${String(item.date).padStart(2, '0')}`;
const cleanTitle = (title) => text(title).replace(/\s+\w+\s+\d{4}\s*$/i, '');

async function fetchItems() {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      headerId: 2,
      sectionId: 'SECTION_747960037',
      source: 'W',
      branchCode: null,
    }),
  });
  if (!response.ok) throw new Error(`PGIM disclosure API returned ${response.status}.`);
  const payload = await response.json();
  const candidates = (payload.data || [])
    .filter((tab) => tab.tabName !== 'Prior to June 2021')
    .flatMap((tab) => tab.content || [])
    .filter((item) => /\.xlsx?$/i.test(item.pdfPath || '') && item.displayStatus !== false)
    .map((item) => ({
      sourceUrl: item.pdfPath,
      title: cleanTitle(item.title),
      asOfDate: disclosureDate(item),
    }));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('PGIM has not published usable monthly portfolio workbooks.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching PGIM India monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'PGIM India Mutual Fund',
    amcWords: ['PGIM', 'INDIA', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `pgim-portfolios-${date}.xlsx`,
    description: 'PGIM India monthly portfolio disclosure',
    fetchItems,
    fetchBytes: async (item) => {
      const response = await fetch(item.sourceUrl, {
        headers: { ...HEADERS, referer: SOURCE_PAGE },
      });
      if (!response.ok) throw new Error(`PGIM workbook returned ${response.status}: ${item.sourceUrl}`);
      return Buffer.from(await response.arrayBuffer());
    },
    normalizeWeight: (weight) => weight / 100,
    codeFromSheet: (_sheetName, item) => item.title,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /PGIM INDIA.+FUND/i.test(text(cell))));
      return candidate || item.title || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} PGIM portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
