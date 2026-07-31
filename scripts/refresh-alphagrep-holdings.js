const fs = require('fs/promises');
const { chromium } = require('playwright-core');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.alphagrepmf.ai/disclosures';
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const monthNumber = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4],
  ['may', 5], ['june', 6], ['july', 7], ['august', 8],
  ['september', 9], ['october', 10], ['november', 11], ['december', 12],
]);

async function findEdge() {
  for (const candidate of EDGE_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next standard Edge installation path.
    }
  }
  throw new Error('Microsoft Edge is required for the AlphaGrep disclosure page.');
}

function asOfDate(value) {
  const fullDate = text(value).match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (fullDate) {
    return `${fullDate[3]}-${String(monthNumber.get(fullDate[2].toLowerCase())).padStart(2, '0')}-${String(Number(fullDate[1])).padStart(2, '0')}`;
  }
  const monthDate = text(value).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)[-_ ]+(\d{4})\b/i);
  if (monthDate) {
    const month = monthNumber.get(monthDate[1].toLowerCase());
    return new Date(Date.UTC(Number(monthDate[2]), month, 0)).toISOString().slice(0, 10);
  }
  return null;
}

async function fetchItems() {
  const browser = await chromium.launch({ headless: true, executablePath: await findEdge() });
  const page = await browser.newPage();
  try {
    await page.goto(SOURCE_PAGE, { waitUntil: 'networkidle', timeout: 90_000 });
    const links = await page.locator('a').evaluateAll((anchors) => anchors.map((anchor) => ({
      label: anchor.innerText,
      sourceUrl: anchor.href,
    })));
    return links.filter((link) => /\.xlsx?(?:$|\?)/i.test(link.sourceUrl)
      && /portfolio/i.test(`${link.label} ${link.sourceUrl}`))
      .map((link) => ({
        ...link,
        asOfDate: asOfDate(`${link.label} ${link.sourceUrl}`),
      }))
      .filter((link) => link.asOfDate)
      .sort((left, right) => right.asOfDate.localeCompare(left.asOfDate))
      .filter((link, _, all) => link.asOfDate === all[0].asOfDate);
  } finally {
    await browser.close();
  }
}

async function main() {
  const items = await fetchItems();
  if (!items.length) {
    console.log('AlphaGrep has not yet published a month-end portfolio; its first scheme launched in July 2026.');
    return;
  }
  const result = await importStandardPortfolios({
    amc: 'AlphaGrep Mutual Fund',
    amcWords: ['ALPHAGREP', 'ALPHA', 'GREP'],
    description: 'Official AlphaGrep Mutual Fund monthly portfolio disclosure.',
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `AlphaGrep monthly portfolios ${date}`,
    fetchItems: async () => items,
    normalizeWeight: (value) => value > 1 ? value / 100 : value,
  });
  console.log(`AlphaGrep holdings refreshed: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
