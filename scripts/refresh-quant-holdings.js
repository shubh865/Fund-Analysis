const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://quantmutual.com/statutory-disclosures';
const API_BASE = 'https://quantmutual.com/statutorydisclosures.aspx';
const CATEGORY = 'MONTHLY PORTFOLIO - FUND - WISE';

async function post(method, payload) {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Quant disclosure API returned ${response.status}.`);
  return (await response.json()).d || '';
}

async function fetchItems() {
  const year = new Date().getFullYear();
  const monthHtml = await post('displaydisclouser1', { id: String(year), cat: CATEGORY });
  const months = [...monthHtml.matchAll(/id='(\d{1,2})'[^>]*>\s*([A-Za-z]{3})\s*</gi)]
    .map((match) => Number(match[1])).filter(Number.isFinite);
  if (!months.length) throw new Error(`Quant has not published monthly portfolios for ${year}.`);
  const month = Math.max(...months);
  const fileHtml = await post('displaydisclouser2', {
    id: String(month),
    cat: CATEGORY,
    tab: String(year),
  });
  const candidates = [...fileHtml.matchAll(/href='([^']+\.xlsx?)'[^>]*>([^<]+)<\/a>/gi)]
    .map((match) => ({
      sourceUrl: new URL(match[1], SOURCE_PAGE).href,
      title: text(match[2]),
      dateMatch: match[1].match(/(\d{1,2})[_ -]([A-Za-z]{3})[_ -](\d{4})/i),
    }))
    .filter((item) => item.dateMatch);
  if (!candidates.length) throw new Error('Quant returned no usable monthly portfolio workbooks.');
  return candidates.map((item) => ({
    sourceUrl: item.sourceUrl,
    title: item.title,
    asOfDate: `${item.dateMatch[3]}-${String(month).padStart(2, '0')}-${String(Number(item.dateMatch[1])).padStart(2, '0')}`,
  }));
}

async function main() {
  console.log('Fetching Quant monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'quant Mutual Fund',
    amcWords: ['QUANT', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `quant-portfolios-${date}.xlsx`,
    description: 'Quant monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName, item) => {
      const candidate = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /^quant .+ fund/i.test(text(cell)) && !/^quant mutual fund$/i.test(text(cell))));
      return candidate ? candidate.split('(')[0].trim() : item.title || sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Quant portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
