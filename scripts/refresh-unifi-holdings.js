const https = require('https');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://unifimf.com/statutorydocuments/';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).href).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Unifi source returned ${response.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchItems() {
  const html = (await download(SOURCE_PAGE)).toString('utf8');
  const candidates = [...html.matchAll(/href="([^"]+\/MP-Unifi-[^"]+-(\d{8})\.xlsx?)"/gi)]
    .map((match) => ({
      sourceUrl: match[1],
      asOfDate: `${match[2].slice(4)}-${match[2].slice(2, 4)}-${match[2].slice(0, 2)}`,
    }));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('Unifi has not published usable monthly portfolio workbooks.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching Unifi monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Unifi Mutual Fund',
    amcWords: ['UNIFI', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `unifi-portfolios-${date}.xlsx`,
    description: 'Unifi monthly portfolio disclosure',
    fetchItems,
    fetchBytes: (item) => download(item.sourceUrl),
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /^Unifi .+ Fund/i.test(text(cell)) && !/^Unifi Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Unifi portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
