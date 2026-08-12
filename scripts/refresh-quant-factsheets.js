const db = require('../server/db');

const AMC = 'quant Mutual Fund';
const SOURCE_PAGE = 'https://quantmutual.com/downloads/factsheet';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\b(?:QUANT|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`quant factsheet page returned ${response.status}.`);
  const match = (await response.text()).match(/href=["']([^"']*quant_Factsheet[^"']+\.pdf)["']/i);
  if (!match) throw new Error('quant did not expose a monthly factsheet PDF on its official archive page.');
  return new URL(match[1], SOURCE_PAGE).href;
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`quant factsheet PDF returned ${response.status}.`);
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
  const match = pages.join(' ').match(/As on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function title(page) {
  return clean(page.match(/\b(quant\s+.+?\s+Fund)\s+Investment Objective:/i)?.[1]);
}

function managers(page) {
  const match = page.match(/(?:FUND|MONEY) MANAGERS?\s+([\s\S]*?)(?=\s+MINIMUM INVESTMENT)/i);
  if (!match) return [];
  return clean(match[1]).split(',').map((name) => clean(name)).filter((name) => /^[A-Z][A-Za-z. ]{2,}$/.test(name)).map((name) => ({ name }));
}

function exitLoad(page) {
  const match = page.match(/LOAD STRUCTURE\s+Entry:\s*Nil\s*\|\s*Exit:\s*([\s\S]*?)(?=\s+EXPENSE RATIO)/i);
  return match ? clean(match[1]) : null;
}

function debtQuants(page) {
  const average = page.match(/AVERAGE MATURITY\s+([\d.]+)\s+years/i)?.[1];
  const modified = page.match(/MODIFIED DURATION\s+([\d.]+)\s+years/i)?.[1];
  const ytm = page.match(/PORTFOLIO YTM \(ANNUALISED\)\s*#?\s*([\d.]+)%/i)?.[1];
  const macaulay = page.match(/PORTFOLIO MACAULAY DURATION\s+([\d.]+)\s+years/i)?.[1];
  return [average, modified, ytm, macaulay].every((value) => value !== undefined)
    ? { average: Number(average), modified: Number(modified), ytm: Number(ytm), macaulay: Number(macaulay) }
    : null;
}

async function main() {
  console.log('Discovering the latest quant monthly factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url); const date = asOfDate(pages);
  if (!date) throw new Error('quant factsheet has no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = pages.map((page) => ({ codes: families.get(key(title(page))) || [], exit: exitLoad(page), managerRows: managers(page), debt: debtQuants(page) })).filter((record) => record.codes.length);
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 70) throw new Error(`Only ${codes.size} quant NAV plans matched official scheme pages; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  const imported = new Set(); let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of records) for (const code of record.codes) {
      if (imported.has(code)) continue;
      snapshot.run(code, date, AMC, record.exit, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) manager.run(code, date, row.name, null, null, url);
      if (record.debt) { quant.run(code, date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      imported.add(code);
    }
  })();
  console.log(`Imported quant factsheet observations for ${imported.size} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
