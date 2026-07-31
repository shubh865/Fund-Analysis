const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.360.one/asset/mutual-funds/downloads/';
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function disclosureDate(url) {
  const decoded = decodeURIComponent(url).replace(/_/g, ' ');
  const match = decoded.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(20\d{2})\b/i);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const year = Number(match[2]);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`360 ONE downloads page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/https:\/\/s3\.ap-south-1\.amazonaws\.com\/x-web-s3\.360\.one\/[^"'\\]+/gi)]
    .map((match) => match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'))
    .filter((url) => /(?:360_ONE|IN_MF).*MONTHLY[_ ]PORTFOLIO/i.test(url) && /\.xlsx?$/i.test(url))
    .map((sourceUrl) => ({ sourceUrl, asOfDate: disclosureDate(sourceUrl) }))
    .filter((item) => item.asOfDate);
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('360 ONE has not published a usable monthly portfolio workbook.');
  return candidates.filter((item) => item.asOfDate === latestDate).slice(0, 1);
}

async function main() {
  console.log('Fetching 360 ONE monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: '360 ONE Mutual Fund',
    amcWords: ['360', 'ONE', 'MUTUAL', 'FUND', 'IIFL'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `360-one-portfolios-${date}.xlsx`,
    description: '360 ONE monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /(?:360 ONE|IIFL).+Fund/i.test(text(cell)) && !/(?:360 ONE|IIFL) Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} 360 ONE portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
