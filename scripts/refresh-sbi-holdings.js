const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORTFOLIO_PAGE = 'https://www.sbimf.com/portfolios';
const PORTFOLIO_LIST_URL = 'https://www.sbimf.com/ajaxcall/CMS/GetSchemePortfolioSheets';

function previousMonth() {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return {
    month: date.toLocaleString('en-US', { month: 'long' }),
    year: String(date.getFullYear()),
  };
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, '&').replace(/&#39;/g, "'");
}

async function fetchOfficialWorkbook(target) {
  const response = await fetch(PORTFOLIO_LIST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ FundId: 0, PSYear: target.year, PSMonth: target.month, PSFrequency: 'Monthly' }),
  });
  if (!response.ok) throw new Error(`SBI portfolio list returned ${response.status}.`);
  const listing = await response.text();
  const links = [...listing.matchAll(/href="([^"]+\.xlsx[^\"]*)"/gi)].map((match) => decodeHtml(match[1]));
  const workbookUrl = links.find((link) => /all-schemes-monthly-portfolio/i.test(link));
  if (!workbookUrl) throw new Error(`SBI has not published its all-schemes monthly workbook for ${target.month} ${target.year} yet.`);
  const workbookResponse = await fetch(workbookUrl);
  if (!workbookResponse.ok) throw new Error(`SBI workbook returned ${workbookResponse.status}.`);
  return { workbookUrl, bytes: Buffer.from(await workbookResponse.arrayBuffer()) };
}

async function main() {
  const target = previousMonth();
  const { workbookUrl, bytes } = await fetchOfficialWorkbook(target);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-portfolio-'));
  const workbookPath = path.join(temporaryDirectory, `sbi-all-schemes-${target.year}-${target.month.toLowerCase()}.xlsx`);
  try {
    fs.writeFileSync(workbookPath, bytes);
    const run = (script, args = []) => execFileSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
    console.log(run('import-sbi-holdings.js', [workbookPath, '--source-url', PORTFOLIO_PAGE]));
    console.log(run('map-sbi-portfolios.js'));
    console.log(`SBI portfolio refresh complete from ${workbookUrl}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
