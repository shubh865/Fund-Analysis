const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.abakkusmf.com/statutory-disclosures.html';
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function disclosureDate(url) {
  const filename = decodeURIComponent(url).replace(/_/g, ' ');
  let match = filename.match(/\b(\d{1,2})\s+(\d{1,2})\s+(20\d{2})\b/);
  if (match) return `${match[3]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  match = filename.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\s+(20\d{2})\b/i);
  if (match) return `${match[3]}-${String(MONTHS[match[1].toLowerCase()]).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
  match = filename.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{2})\b/i);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    const year = 2000 + Number(match[2]);
    const dayMatch = filename.match(new RegExp(`(\\d{1,2})\\s+${match[1]}`, 'i'));
    const day = dayMatch ? Number(dayMatch[1]) : new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Abakkus disclosures page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/href="([^"]+\.(?:xlsx?|xls))"/gi)]
    .map((match) => new URL(match[1], SOURCE_PAGE).href)
    .filter((url) => /monthly.*portfolio|portfolio.*(?:31|30|28).*20\d{2}/i.test(url) && !/fortnight|half.year|dashboard/i.test(url))
    .map((sourceUrl) => ({ sourceUrl, asOfDate: disclosureDate(sourceUrl) }))
    .filter((item) => item.asOfDate);
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('Abakkus has not published a usable monthly portfolio workbook.');
  return candidates.filter((item) => item.asOfDate === latestDate).slice(0, 1);
}

async function main() {
  console.log('Fetching Abakkus monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: 'Abakkus Mutual Fund',
    amcWords: ['ABAKKUS', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `abakkus-portfolios-${date}.xlsx`,
    description: 'Abakkus monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /^Abakkus .+ Fund/i.test(text(cell)) && !/^Abakkus Mutual Fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Abakkus portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
