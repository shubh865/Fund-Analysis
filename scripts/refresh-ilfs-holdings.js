const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.ilfsinfrafund.com/other.php';
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`IL&FS disclosure page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/href="([^"]*ILFS_Portfolio_TransactionReports_([A-Za-z]+)_(20\d{2})[^"]*\.xlsx?)"/gi)]
    .map((match) => {
      const month = MONTHS[match[2].toLowerCase()];
      const year = Number(match[3]);
      if (!month) return null;
      const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        sourceUrl: new URL(match[1], SOURCE_PAGE).href,
        asOfDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      };
    }).filter(Boolean);
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('IL&FS has not published a usable monthly portfolio workbook.');
  return candidates.filter((item) => item.asOfDate === latestDate).slice(0, 1);
}

async function main() {
  console.log('Fetching IL&FS IDF monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: 'IL&FS Mutual Fund (IDF)',
    amcWords: ['IL', 'FS', 'IL&FS', 'INFRASTRUCTURE', 'DEBT', 'IDF', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `ilfs-idf-portfolios-${date}.xlsx`,
    description: 'IL&FS Infrastructure Debt Fund monthly portfolio disclosure',
    fetchItems,
    sheetFilter: (sheetName) => /\b30\b/.test(sheetName),
    codeFromSheet: (sheetName) => sheetName.replace(/\s+\d{1,2}\s+\w+\s+\d{4}$/i, ''),
    normalizeWeight: (weight) => weight / 100,
    nameFromRows: (rows, headerIndex, sheetName) => text(rows.slice(0, headerIndex).flat()
      .find((cell) => /^IL&FS Infrastructure Debt Fund Series/i.test(text(cell)))) || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} IL&FS IDF portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
