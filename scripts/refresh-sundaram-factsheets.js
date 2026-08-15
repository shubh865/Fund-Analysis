const db = require('../server/db');

const AMC = 'Sundaram Mutual Fund';
const SOURCE_PAGE = 'https://www.sundarammutual.com/fundwise-factsheet';
const DOWNLOAD_ENDPOINT = 'https://www.sundarammutual.com/ajax/Modules_Forms_Downloads_Fundwise_Factsheet,App_Web_2c51iwzf.ashx?_method=DownloadArchive&_session=no';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\(\s*FORMERLY\s+KNOWN[^)]*\)/gi, ' ')
  .replace(/\bFLEXICAP\b/g, 'FLEXI CAP')
  .replace(/\bMIDCAP\b/g, 'MID CAP')
  .replace(/\b(?:SUNDARAM|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|RETAIL|INSTITUTIONAL|FUND|CUM|INCOME|DISTRIBUTION|CAPITAL|WITHDRAWAL)\b/g, ' ')
  .replace(/\b(?:AND|DEBT|THE)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const year = now.getUTCFullYear();
  const response = await fetch(DOWNLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: SOURCE_PAGE,
      origin: 'https://www.sundarammutual.com',
      accept: '*/*',
      'x-requested-with': 'XMLHttpRequest',
    },
    // This legacy official endpoint expects CRLF-delimited form values.
    body: `cat=1\r\nmnth=${month}/${year}`,
  });
  if (!response.ok) throw new Error(`Sundaram factsheet endpoint returned ${response.status}.`);
  const url = clean(await response.text()).replace(/^['"]|['"]$/g, '');
  if (!/^https:\/\/www\.sundarammutual\.com\//.test(url) || !/\.pdf(?:$|\?)/i.test(url)) {
    throw new Error('Sundaram did not expose a current consolidated factsheet PDF.');
  }
  return url;
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Sundaram factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function asOfDate(pages) {
  const text = pages.join(' ');
  const match = text.match(/Returns\/investment value are as of\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function schemeTitle(page) {
  const match = page.match(/\b(Sundaram\s+.{2,120}?)\s+(?:An\s+(?:open|close)|www\.sundarammutual\.com)/i);
  return match ? clean(match[1]).replace(/\s+A close-ended Equity Linked Savings Scheme$/i, '') : null;
}

function managers(page) {
  const section = page.match(/Fund Managers\s+([\s\S]*?)(?=\s+(?:Month End AUM|Avg\. AUM|Inception Date|Benchmark))/i)?.[1] || '';
  return clean(section).split(',').map(clean)
    .filter((name) => /^[A-Z][A-Za-z. ]{2,}$/.test(name))
    .map((name) => ({ name }));
}

function exitLoad(page) {
  const match = page.match(/Exit Load\s+([\s\S]*?)(?=\s+(?:NAV\*|NET ASSET VALUE|RATIO \(ANNUALISED\)|PORTFOLIO))/i);
  return match ? clean(match[1]) : null;
}

function debtQuants(page) {
  const average = page.match(/Average Maturity of Portfolio\s+([\d.]+)\s+Years/i)?.[1];
  const modified = page.match(/Modified Duration of Portfolio\s+([\d.]+)\s+Years/i)?.[1];
  const ytm = page.match(/YTM of Portfolio\s+([\d.]+)\s*%/i)?.[1];
  const macaulay = page.match(/Macaulay Duration of Portfolio\s+([\d.]+)\s+Years/i)?.[1];
  return [average, modified, ytm, macaulay].every((value) => value !== undefined)
    ? { average: Number(average), modified: Number(modified), ytm: Number(ytm), macaulay: Number(macaulay) }
    : null;
}

async function main() {
  console.log('Discovering the latest Sundaram consolidated factsheet...');
  const url = await latestFactsheet();
  const pages = await pagesFrom(url);
  const date = asOfDate(pages);
  if (!date) throw new Error('Sundaram factsheet has no recognised underlying as-of date.');

  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = pages.map((page) => {
    const title = schemeTitle(page);
    return title ? { codes: families.get(key(title)) || [], exit: exitLoad(page), managerRows: managers(page), debt: debtQuants(page) } : null;
  }).filter((record) => record?.codes.length);
  const expectedCodes = new Set(records.flatMap((record) => record.codes));
  if (expectedCodes.size < 150) throw new Error(`Only ${expectedCodes.size} Sundaram NAV plans matched official scheme pages; aborting without changing data.`);

  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);

  let imported = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) {
      db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    }
    const seen = new Set();
    for (const record of records) for (const code of record.codes) {
      if (seen.has(code)) continue;
      snapshot.run(code, date, AMC, record.exit, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) {
        manager.run(code, date, row.name, null, null, url);
      }
      if (record.debt) {
        quant.run(code, date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url);
        debtCount += 1;
      }
      seen.add(code); imported += 1;
    }
  })();
  console.log(`Imported Sundaram factsheet observations for ${imported} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
