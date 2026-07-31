const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://mf.whiteoakamc.com/regulatory-disclosures/scheme-portfolios';
const API_URL = 'https://cms.whiteoakamc.com/api/scheme-portfolios';
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function disclosureDate(value) {
  const normalized = text(value).replace(/_/g, ' ');
  const match = normalized.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(20\d{2})\b/i);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const year = Number(match[2]);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchItems() {
  const params = new URLSearchParams({
    'pagination[page]': '1',
    'pagination[pageSize]': '100',
    populate: '*',
    'filters[period][$eq]': 'Monthly',
    'sort[published_date]': 'desc',
  });
  const response = await fetch(`${API_URL}?${params}`, {
    headers: {
      accept: 'application/json',
      referer: SOURCE_PAGE,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`WhiteOak disclosure API returned ${response.status}.`);
  const payload = await response.json();
  const candidates = (payload.data || []).map((entry) => {
    const attributes = entry.attributes || {};
    const sourceUrl = attributes.doc_file?.data?.attributes?.url || attributes.doc_link;
    return {
      sourceUrl,
      title: attributes.scheme_name || attributes.doc_name,
      asOfDate: disclosureDate(`${attributes.doc_name || ''} ${sourceUrl || ''}`),
    };
  }).filter((item) => item.sourceUrl && item.asOfDate && /\.xlsx?$/i.test(item.sourceUrl));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('WhiteOak has not published usable monthly portfolio workbooks.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching WhiteOak monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'WhiteOak Capital Mutual Fund',
    amcWords: ['WHITEOAK', 'WHITE', 'OAK', 'CAPITAL', 'MUTUAL', 'FUND', 'YES'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `whiteoak-portfolios-${date}.xlsx`,
    description: 'WhiteOak Capital monthly portfolio disclosure',
    fetchItems,
    fetchBytes: async (item) => {
      const response = await fetch(item.sourceUrl, {
        headers: {
          referer: SOURCE_PAGE,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
        },
      });
      if (!response.ok) throw new Error(`WhiteOak workbook returned ${response.status}: ${item.sourceUrl}`);
      return Buffer.from(await response.arrayBuffer());
    },
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /(?:WhiteOak Capital|YES).+Fund/i.test(text(cell))
          && !/(?:WhiteOak Capital|YES) Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : item.title || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} WhiteOak portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
