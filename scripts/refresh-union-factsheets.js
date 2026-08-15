const db = require('../server/db');

const AMC = 'Union Mutual Fund';
const SOURCE_PAGE = 'https://www.unionmf.com/about-us/downloads/factsheets';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\bLARGECAP\b/g, 'LARGE CAP').replace(/\bMIDCAP\b/g, 'MID CAP')
  .replace(/\b(?:UNION|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND|CUM|INCOME|DISTRIBUTION|CAPITAL|WITHDRAWAL)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Union factsheet page returned ${response.status}.`);
  const urls = [...(await response.text()).matchAll(/https:\/\/www\.unionmf\.com\/docs\/[^'"\s]+factsheet-(?:july|august|september|october|november|december|january|february|march|april|may|june)-\d{4}\.pdf\?[^'"\s]+/gi)]
    .map((match) => match[0].replace(/&amp;/g, '&'));
  if (!urls.length) throw new Error('Union did not expose a current factsheet PDF on its official download page.');
  return urls[0];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Union factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function asOfDate(pages) {
  const match = pages.join(' ').match(/Factsheet as on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function schemeTitle(page) {
  const candidates = [...page.matchAll(/\b(Union\s+[A-Za-z &-]+?\s+Fund)\b/gi)].map((match) => clean(match[1]));
  return candidates.at(-1) || null;
}

function managers(page) {
  const section = page.match(/(?:Co-)?Fund Managers\s+([\s\S]*?)(?=\s+@@@|\s+Benchmark Index)/i)?.[1] || '';
  return [...section.matchAll(/([A-Z][A-Za-z. ]{2,})\s+Over\s+(\d+)\s+years of experience/gi)]
    .map((match) => ({ name: clean(match[1]), experience: Number(match[2]) }));
}

function debtQuants(page) {
  const average = page.match(/Average Maturity\s+([\d.]+)\s+Years/i)?.[1];
  const modified = page.match(/Modified Duration\s+([\d.]+)\s+Years/i)?.[1];
  const ytm = page.match(/(?:Portfolio Yield|Annualised Yield)\s+([\d.]+)%/i)?.[1];
  const macaulay = page.match(/Macaulay Duration\s+([\d.]+)\s+Years/i)?.[1];
  return [average, modified, ytm, macaulay].every((value) => value !== undefined)
    ? { average: Number(average), modified: Number(modified), ytm: Number(ytm), macaulay: Number(macaulay) }
    : null;
}

async function main() {
  console.log('Discovering the latest Union factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url); const date = asOfDate(pages);
  if (!date) throw new Error('Union factsheet has no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 4) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = pages.map((page) => {
    const title = schemeTitle(page);
    return title ? { codes: families.get(key(title)) || [], managerRows: managers(page), debt: debtQuants(page) } : null;
  }).filter((record) => record?.codes.length);
  const expectedCodes = new Set(records.flatMap((record) => record.codes));
  if (expectedCodes.size < 100) throw new Error(`Only ${expectedCodes.size} Union NAV plans matched official scheme pages; aborting without changing data.`);

  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  let imported = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    const seen = new Set();
    for (const record of records) for (const code of record.codes) {
      if (seen.has(code)) continue;
      snapshot.run(code, date, AMC, null, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) manager.run(code, date, row.name, null, row.experience, url);
      if (record.debt) { quant.run(code, date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      seen.add(code); imported += 1;
    }
  })();
  console.log(`Imported Union factsheet observations for ${imported} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
