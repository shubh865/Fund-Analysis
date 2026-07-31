const fs = require('fs/promises');
const { chromium } = require('playwright-core');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://bandhanmutual.com/statutory-disclosures/scheme-portfolios/monthly-half-yearly';
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
      // Try the next standard Windows Edge location.
    }
  }
  throw new Error('Microsoft Edge is required for the official Bandhan disclosure page.');
}

function disclosureDate(value) {
  const match = text(value).match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (!match) return null;
  const month = monthNumber.get(match[2].toLowerCase());
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
}

async function fetchItems() {
  const executablePath = await findEdge();
  let browser = null;
  let page = null;
  const items = [];

  async function openPage() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ acceptDownloads: true });
    await page.goto(SOURCE_PAGE, { waitUntil: 'networkidle', timeout: 90_000 });
    const notificationClose = page.locator('#wzrk-cancel');
    if (await notificationClose.count()) {
      await notificationClose.click({ timeout: 3_000 }).catch(() => {});
    }
    await page.locator('div.fixed.inset-0').evaluateAll((elements) => {
      elements.forEach((element) => element.remove());
    });
    await page.waitForTimeout(750);
  }

  async function readSchemes() {
    const schemeButton = page.locator('button.w-full.flex.justify-between').nth(2);
    await schemeButton.click();
    const schemes = (await page.locator('li').allTextContents()).map(text)
      .filter((name) => /^Bandhan\b/i.test(name));
    await page.keyboard.press('Escape');
    if (!schemes.length) throw new Error('Bandhan scheme list was empty.');
    return schemes;
  }

  async function downloadScheme(scheme) {
    await page.locator('div.fixed.inset-0').evaluateAll((elements) => {
      elements.forEach((element) => element.remove());
    });
    const schemeButton = page.locator('button.w-full.flex.justify-between').nth(2);
    await schemeButton.click();
    const option = page.locator('li').filter({ hasText: new RegExp(`^${scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await option.click();
    await page.waitForTimeout(500);

    const downloadButton = page.locator('button:has(svg path[d^="M9.32969"])').last();
    if (!await downloadButton.count()) {
      console.warn(`Bandhan: no monthly disclosure found for ${scheme}.`);
      return null;
    }
    const rowText = text(await downloadButton.locator('xpath=..').innerText());
    const asOfDate = disclosureDate(rowText);
    if (!asOfDate) {
      console.warn(`Bandhan: could not read disclosure date for ${scheme}.`);
      return null;
    }
    const pendingDownload = page.waitForEvent('download', { timeout: 60_000 });
    await downloadButton.click();
    const download = await pendingDownload;
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error(`Bandhan download failed for ${scheme}.`);
    return {
      scheme,
      asOfDate,
      sourceUrl: download.url(),
      sourceFile: download.suggestedFilename(),
      bytes: await fs.readFile(downloadedPath),
    };
  }

  try {
    await openPage();
    const schemes = await readSchemes();
    for (let index = 0; index < schemes.length; index += 1) {
      const scheme = schemes[index];
      if (index > 0 && index % 20 === 0) await openPage();
      let item = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          item = await downloadScheme(scheme);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          console.warn(`Bandhan: retrying ${scheme} after browser/download error (${attempt}/3).`);
          await openPage();
        }
      }
      if (item) items.push(item);
      console.log(`Bandhan: processed ${index + 1}/${schemes.length} - ${scheme}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return items;
}

importStandardPortfolios({
  amc: 'Bandhan Mutual Fund',
  amcWords: ['BANDHAN', 'IDFC'],
  description: 'Official Bandhan Mutual Fund monthly portfolio disclosure.',
  sourcePage: SOURCE_PAGE,
  sourceFile: (asOfDate) => `Bandhan monthly portfolios ${asOfDate}`,
  fetchItems,
  fetchBytes: async (item) => item.bytes,
  concurrency: 8,
  normalizeWeight: (value) => value > 1 ? value / 100 : value,
  nameFromRows: (rows, headerIndex, sheetName, item) => {
    const workbookName = rows.slice(0, headerIndex).flat().map(text)
      .find((value) => /^Bandhan\b/i.test(value) && !/mutual fund|portfolio statement/i.test(value));
    return workbookName || item.scheme || sheetName;
  },
  codeFromSheet: (sheetName, item) => `${item.scheme}::${sheetName}`,
}).then((result) => {
  console.log(`Bandhan holdings refreshed: ${JSON.stringify(result)}`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
