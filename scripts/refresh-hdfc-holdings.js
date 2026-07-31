const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_PAGE = 'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio';

function runScript(name, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${name} exited with code ${result.status}.`);
}

async function main() {
  console.log('Fetching HDFC monthly portfolio disclosures...');
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`HDFC portfolio page returned ${response.status}.`);
  const html = await response.text();
  const candidates = [...html.matchAll(/"url":"(https:\/\/files\.hdfcfund\.com\/[^"]+\.xlsx)"/gi)]
    .map((match) => {
      const sourceUrl = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      const decoded = decodeURIComponent(sourceUrl);
      const dateMatch = decoded.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\.xlsx$/i);
      if (!dateMatch) return null;
      const parsed = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]} UTC`);
      return Number.isNaN(parsed.getTime()) ? null : { sourceUrl, asOfDate: parsed.toISOString().slice(0, 10) };
    })
    .filter(Boolean);
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  const latest = [...new Map(candidates.filter((item) => item.asOfDate === latestDate)
    .map((item) => [item.sourceUrl, item])).values()];
  if (!latest.length) throw new Error('HDFC monthly portfolio workbooks were not found.');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdfc-portfolios-'));
  try {
    for (let index = 0; index < latest.length; index += 1) {
      const item = latest[index];
      const workbookResponse = await fetch(item.sourceUrl);
      if (!workbookResponse.ok) throw new Error(`HDFC workbook returned ${workbookResponse.status}: ${item.sourceUrl}`);
      fs.writeFileSync(path.join(temporaryDirectory, `${String(index + 1).padStart(3, '0')}.xlsx`),
        Buffer.from(await workbookResponse.arrayBuffer()));
      if ((index + 1) % 20 === 0 || index + 1 === latest.length) {
        console.log(`HDFC: downloaded ${index + 1}/${latest.length} workbooks`);
      }
    }
    runScript('import-hdfc-holdings.js', [
      temporaryDirectory,
      '--source-url',
      SOURCE_PAGE,
    ]);
    runScript('map-hdfc-portfolios.js');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
