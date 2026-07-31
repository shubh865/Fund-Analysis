const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.assetmanagement.hsbc.co.in/en/mutual-funds/investor-resources/information-library';
const ORIGIN = 'https://www.assetmanagement.hsbc.co.in';
const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
};

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE, { headers: HEADERS });
  if (!response.ok) throw new Error(`HSBC information library returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/href="(\/?-\/media\/files\/attachments\/india\/mutual-funds\/portfolios\/document-(\d{2})(\d{2})(\d{4})\/[^"]+\.xlsx?)"[^>]*(?:title="([^"]+)")?[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      sourceUrl: new URL(match[1].startsWith('/') ? match[1] : `/${match[1]}`, ORIGIN).href,
      title: text((match[5] || match[6]).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')),
      asOfDate: `${match[4]}-${match[3]}-${match[2]}`,
    }));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('HSBC has not published usable monthly portfolio workbooks.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching HSBC monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'HSBC Mutual Fund',
    amcWords: ['HSBC', 'L&T', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `hsbc-portfolios-${date}.xlsx`,
    description: 'HSBC monthly portfolio disclosure',
    fetchItems,
    fetchBytes: async (item) => {
      const response = await fetch(item.sourceUrl, { headers: { ...HEADERS, referer: SOURCE_PAGE } });
      if (!response.ok) throw new Error(`HSBC workbook returned ${response.status}: ${item.sourceUrl}`);
      return Buffer.from(await response.arrayBuffer());
    },
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /(?:HSBC|L&T).+Fund/i.test(text(cell)) && !/(?:HSBC|L&T) Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : item.title.replace(/\s+\d{1,2}\s+\w+\s+\d{4}.*$/i, '') || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} HSBC portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
