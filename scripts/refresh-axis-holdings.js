const crypto = require('crypto');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.axismf.com/statutory-disclosures';
const TOKEN_URL = 'https://www.axismf.com/cms/token';
const DOCUMENT_API = 'https://www.axismf.com/cms/get-scheme-documents';
const HEADERS = {
  'content-type': 'application/json',
  referer: SOURCE_PAGE,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
};
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

async function fetchToken(browserId) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { ...HEADERS, authorization: '', 'browser-id': browserId },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Axis CMS token service returned ${response.status}.`);
  const payload = await response.json();
  if (!payload.data?.token) throw new Error('Axis CMS token service returned no token.');
  return payload.data.token;
}

async function fetchMonth(year, month, token, browserId) {
  const response = await fetch(DOCUMENT_API, {
    method: 'POST',
    headers: { ...HEADERS, authorization: token, 'browser-id': browserId },
    body: JSON.stringify({
      sdType: 'yearMonthSchemeDocs',
      sdID: 'sdMonthSchemePortfolio',
      year: String(year),
      month: MONTHS[month],
      schemeCode: 'Consolidated',
    }),
  });
  if (!response.ok) throw new Error(`Axis document service returned ${response.status}.`);
  return response.json();
}

async function fetchItems() {
  const browserId = crypto.randomUUID();
  const token = await fetchToken(browserId);
  const now = new Date();
  for (let offset = 0; offset < 4; offset += 1) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const payload = await fetchMonth(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      token,
      browserId,
    );
    const document = (payload.data?.documentList || []).find((item) =>
      /^monthly[\s_-]*portfolio/i.test(text(item.documentName))
      && /\.xlsx?(?:\.xlsx?)?$/i.test(item.docuementURL || ''));
    if (document) {
      return [{
        title: document.documentName,
        asOfDate: document.documentPostedDate,
        sourceUrl: document.docuementURL,
      }];
    }
  }
  throw new Error('Axis has not published a usable recent monthly portfolio workbook.');
}

async function main() {
  console.log('Fetching Axis monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Axis Mutual Fund',
    amcWords: ['AXIS', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `axis-portfolios-${date}.xlsx`,
    description: 'Axis monthly portfolio disclosure',
    fetchItems,
    fetchBytes: async (item) => {
      const response = await fetch(item.sourceUrl, {
        headers: {
          ...HEADERS,
          accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
        },
      });
      if (!response.ok) throw new Error(`Axis workbook returned ${response.status}: ${item.sourceUrl}`);
      return Buffer.from(await response.arrayBuffer());
    },
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) =>
      text(rows.slice(0, headerIndex).flat().find((cell) => /^Axis .+Fund/i.test(text(cell))))
      || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Axis portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
