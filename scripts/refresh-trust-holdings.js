const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.trustmf.com/disclosures?activeTab=portfolio-monthly-disclosure';
const API_URL = 'https://www.trustmf.com/api/api/Trust/GetData';

async function fetchItems() {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      systemQueryFileName: 'disclosuresweb.xml',
      tagName: 'GetDisclosureByType',
      searchField: '',
      searchValue: '',
      sortField: 'uploaddate',
      sortDirection: 'DESC',
      replaceField: '_slug_',
      replaceValue: 'portfolio-monthly-disclosure',
    }),
  });
  if (!response.ok) throw new Error(`TRUST disclosure API returned ${response.status}.`);
  const documents = (await response.json()).resultSetArray || [];
  const latest = documents.find((document) => /\.xlsx?(?:$|\?)/i.test(document.fileurl || '')
    && /as on \d{2}\.\d{2}\.\d{4}/i.test(document.title || ''));
  if (!latest) throw new Error('TRUST has not published a usable monthly portfolio workbook.');
  const match = latest.title.match(/as on (\d{2})\.(\d{2})\.(\d{4})/i);
  return [{
    sourceUrl: latest.fileurl,
    asOfDate: `${match[3]}-${match[2]}-${match[1]}`,
  }];
}

async function main() {
  console.log('Fetching TRUST monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: 'Trust Mutual Fund',
    amcWords: ['TRUST', 'TRUSTMF', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `trust-portfolios-${date}.xlsx`,
    description: 'TRUST monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => text(rows.slice(0, headerIndex).flat()
      .find((cell) => /^TRUSTMF .+ Fund$/i.test(text(cell)))) || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} TRUST portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
