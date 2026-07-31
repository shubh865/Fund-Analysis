const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const SOURCE_PAGE = 'https://www.icicipruamc.com/media-center/downloads?currentTabFilter=Disclosures&subCatTabFilter=MonthlyPortfolioDisclosures';
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function runScript(name, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${name} exited with code ${result.status}.`);
}

function findEdge() {
  const executablePath = EDGE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('Microsoft Edge is required for the official ICICI Prudential disclosures page.');
  return executablePath;
}

async function main() {
  console.log('Fetching ICICI Prudential monthly portfolio disclosure...');
  const browser = await chromium.launch({ headless: true, executablePath: findEdge() });
  let page;
  try {
    page = await browser.newPage();
    const filesResponse = page.waitForResponse(
      (response) => /\/nms\/v1\/downloads\/files/i.test(response.url()) && response.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await page.goto(SOURCE_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const payload = await (await filesResponse).json();
    const files = payload?.success?.data?.files || [];
    const latest = files
      .filter((file) => /monthly portfolio disclosure/i.test(file.title?.text || '') && /\.zip$/i.test(file.url || ''))
      .sort((left, right) => Number(right.applicableMonth || right.fileDate || 0) - Number(left.applicableMonth || left.fileDate || 0))[0];
    if (!latest) throw new Error('ICICI Prudential monthly portfolio ZIP was not found.');
    const sourceUrl = new URL(`/blob${latest.url}`, 'https://www.icicipruamc.com').href;
    const download = await page.request.get(sourceUrl, { timeout: 120_000 });
    if (!download.ok()) throw new Error(`ICICI Prudential ZIP returned ${download.status()}.`);

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'icici-portfolios-'));
    const archivePath = path.join(temporaryDirectory, path.basename(new URL(sourceUrl).pathname));
    try {
      fs.writeFileSync(archivePath, await download.body());
      runScript('import-icici-holdings.js', [
        archivePath,
        '--source-url',
        SOURCE_PAGE,
      ]);
      runScript('map-icici-portfolios.js');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
