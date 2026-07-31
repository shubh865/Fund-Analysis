const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.angelonemf.com/downloads';
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Angel One downloads page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/https:\/\/cms\.angelonemf\.com\/[^"'\\]+\/Monthly-Portfolio-([A-Za-z]+)-(\d{4})-([^"'\\]+\.xlsx?)/gi)]
    .map((match) => {
      const month = MONTHS[match[1].toLowerCase()];
      const year = Number(match[2]);
      if (!month) return null;
      const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        sourceUrl: match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'),
        title: decodeURIComponent(match[3]).replace(/\.xlsx?$/i, '').replace(/-\d+$/, '').replace(/-/g, ' '),
        asOfDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      };
    })
    .filter(Boolean);
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('Angel One has not published usable monthly portfolio workbooks.');
  const seen = new Set();
  return candidates.filter((item) => item.asOfDate === latestDate)
    .filter((item) => !seen.has(item.sourceUrl) && seen.add(item.sourceUrl));
}

async function main() {
  console.log('Fetching Angel One monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Angel One Mutual Fund',
    amcWords: ['ANGEL', 'ONE', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `angel-one-portfolios-${date}.xlsx`,
    description: 'Angel One monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /^Angel One .+/i.test(text(cell)) && !/^Angel One Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : item.title || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Angel One portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
