const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const SOURCE_PAGE = 'https://mutualfund.adityabirlacapital.com/forms-and-downloads/portfolio';
const API_URL = 'https://mutualfund.adityabirlacapital.com/postlogin/CustomApi/Resources/FactsheetAccordionById?id=3ccab227-9de5-4494-b78d-2b4f7c0c054a&ctype=%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ%2FCustomer%20Types%2FIndividual&month=%20&year=0';

function runScript(name, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${name} exited with code ${result.status}.`);
}

async function main() {
  console.log('Fetching Aditya Birla Sun Life monthly portfolio disclosure...');
  const response = await fetch(API_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'x-requested-with': 'XMLHttpRequest',
      referer: SOURCE_PAGE,
    },
  });
  if (!response.ok) throw new Error(`ABSL disclosure API returned ${response.status}.`);
  const payload = await response.json();
  const latest = (payload.AccordionList || [])
    .map((item) => {
      const match = String(item.ResourceLink || '').match(/as on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
      if (!match || !/\.zip$/i.test(item.pdfUrl || '')) return null;
      const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
      return Number.isNaN(parsed.getTime()) ? null : { ...item, asOfDate: parsed.toISOString().slice(0, 10) };
    })
    .filter(Boolean)
    .sort((left, right) => right.asOfDate.localeCompare(left.asOfDate))[0];
  if (!latest) throw new Error('ABSL monthly portfolio ZIP was not found.');
  const downloadUrl = latest.pdfUrl.replace('https://abcscprod.azureedge.net', 'https://mutualfund.adityabirlacapital.com');
  const archiveResponse = await fetch(downloadUrl);
  if (!archiveResponse.ok) throw new Error(`ABSL monthly portfolio ZIP returned ${archiveResponse.status}.`);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'absl-portfolios-'));
  try {
    const zip = new AdmZip(Buffer.from(await archiveResponse.arrayBuffer()));
    const workbookEntry = zip.getEntries().find((entry) => !entry.isDirectory && /\.xlsx$/i.test(entry.entryName));
    if (!workbookEntry) throw new Error('ABSL portfolio ZIP contained no Excel workbook.');
    const workbookPath = path.join(temporaryDirectory, path.basename(workbookEntry.entryName));
    fs.writeFileSync(workbookPath, workbookEntry.getData());
    runScript('import-absl-holdings.js', [workbookPath, '--source-url', SOURCE_PAGE]);
    runScript('map-absl-portfolios.js');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
