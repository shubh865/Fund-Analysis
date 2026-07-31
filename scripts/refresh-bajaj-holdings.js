const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const AMC = 'Bajaj Finserv Mutual Fund';
const SOURCE_PAGE = 'https://www.bajajamc.com/downloads?portfolio';
const SECTION_ID = '757';

async function post(ajaxUrl, nonce, action, fields) {
  const form = new FormData();
  form.append('action', action);
  form.append('nonce', nonce);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(ajaxUrl, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Bajaj disclosure API returned ${response.status}.`);
  const envelope = await response.json();
  if (!envelope.success) throw new Error('Bajaj disclosure API rejected the request.');
  return envelope.data;
}

async function fetchItems() {
  const pageResponse = await fetch(SOURCE_PAGE);
  if (!pageResponse.ok) throw new Error(`Bajaj downloads page returned ${pageResponse.status}.`);
  const html = await pageResponse.text();
  const configMatch = html.match(/bajajDownloads\s*=\s*(\{[^;]+\})/i);
  if (!configMatch) throw new Error('Bajaj downloads API configuration was not found.');
  const config = JSON.parse(configMatch[1]);
  const years = await post(config.ajaxUrl, config.nonce, 'bajaj_get_filter_options', {
    filter_for: 'years',
    section_id: SECTION_ID,
  });
  const latestYear = years.options.map((option) => option.value)
    .sort((left, right) => Number(right.slice(0, 4)) - Number(left.slice(0, 4)))[0];
  const months = await post(config.ajaxUrl, config.nonce, 'bajaj_get_filter_options', {
    filter_for: 'months',
    section_id: SECTION_ID,
    year: latestYear,
  });
  const monthOrder = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const latestMonth = months.options.map((option) => option.value)
    .sort((left, right) => monthOrder.indexOf(right) - monthOrder.indexOf(left))[0];
  const downloads = await post(config.ajaxUrl, config.nonce, 'bajaj_get_downloads', {
    section_id: SECTION_ID,
    year: latestYear,
    month: latestMonth,
  });
  const url = downloads.html.match(/href="([^"]+\.xlsx?)"/i)?.[1];
  const dateMatch = downloads.html.match(/as on (\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!url || !dateMatch) throw new Error('Bajaj has not published a usable monthly portfolio workbook.');
  const month = monthOrder.findIndex((value) => value.toLowerCase().startsWith(dateMatch[2].toLowerCase())) + 1;
  return [{
    sourceUrl: url,
    asOfDate: `${dateMatch[3]}-${String(month).padStart(2, '0')}-${String(dateMatch[1]).padStart(2, '0')}`,
  }];
}

async function main() {
  console.log('Fetching Bajaj Finserv monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: AMC,
    amcWords: ['BAJAJ', 'FINSERV', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `bajaj-portfolios-${date}.xls`,
    description: 'Bajaj Finserv monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => text(rows.slice(0, headerIndex).flat()
      .find((cell) => /^Bajaj Finserv .+ Fund$/i.test(text(cell)))) || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Bajaj Finserv portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
