const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.wealthcompanyamc.in/literature-forms/portfolio-documents/monthly/';
const ORIGIN = 'https://www.wealthcompanyamc.in';

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36' },
  });
  if (!response.ok) throw new Error(`The Wealth Company monthly portfolio page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/\{\\"uploadDate\\":\\"(\d{4}-\d{2}-\d{2})\\"[\s\S]*?\\"name\\":\\"([^"]+)\\"[\s\S]*?\\"attachment\\":\{[\s\S]*?\\"url\\":\\"([^"]+\.xlsx?)\\"/gi)]
    .map((match) => ({
      asOfDate: match[1],
      title: text(match[2]),
      sourceUrl: new URL(match[3].replace(/\\\//g, '/'), ORIGIN).href,
    }));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('The Wealth Company has not published usable monthly portfolio workbooks.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching The Wealth Company monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'The Wealth Company Mutual Fund',
    amcWords: ['THE', 'WEALTH', 'COMPANY', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `wealth-company-portfolios-${date}.xlsx`,
    description: 'The Wealth Company monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /^The Wealth Company .+ Fund/i.test(text(cell))
          && !/^The Wealth Company Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim()
        : item.title.replace(/^Monthly\s*-\s*/i, '').replace(/\s*-\s*\w+\s+\d{1,2},\s*\d{4}$/i, '') || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Wealth Company portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
