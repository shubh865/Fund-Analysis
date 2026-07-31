const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.oldbridgemf.com/statutory-disclosures.html';

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Old Bridge disclosure page returned ${response.status}.`);
  const html = await response.text();
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const matches = [...html.matchAll(/<h2[^>]*>Old Bridge ([^<]+) - ([A-Za-z]+) (\d{4})<\/h2>\s*<a href="([^"]+\.xlsx)"/gi)]
    .map((match) => {
      const month = months[match[2].toLowerCase()];
      const asOfDate = new Date(Date.UTC(Number(match[3]), month, 0)).toISOString().slice(0, 10);
      return { sourceUrl: new URL(match[4], SOURCE_PAGE).href, asOfDate };
    });
  const latestDate = matches.map((item) => item.asOfDate).sort().at(-1);
  return matches.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching Old Bridge monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Old Bridge Mutual Fund',
    amcWords: ['OLD', 'BRIDGE', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `old-bridge-portfolios-${date}.xlsx`,
    description: 'Old Bridge monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight / 100,
    nameFromRows: (rows, headerIndex, sheetName) => text(rows.slice(0, headerIndex).flat()
      .find((cell) => /^Old Bridge .+ Fund$/i.test(text(cell)) && !/^Old Bridge Mutual Fund$/i.test(text(cell)))) || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Old Bridge portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
