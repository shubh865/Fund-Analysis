const db = require('../server/db');

const AMC = 'DSP Mutual Fund';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\([^)]*(?:ERSTWHILE|THE INFRASTRUCTURE)[^)]*\)/g, '')
  .replace(/MIDCAP/g, 'MID CAP').replace(/MULTICAP/g, 'MULTI CAP')
  .replace(/\b(DSP|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const today = new Date();
  for (let offset = 0; offset < 4; offset += 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const name = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
    const url = `https://www.dspim.com/downloads/dsp-factsheet-${name}-${date.getUTCFullYear()}.pdf`;
    const response = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } });
    if (/application\/pdf/i.test(response.headers.get('content-type') || '')) return url;
  }
  throw new Error('DSP did not expose a current monthly factsheet PDF at its official download location.');
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`DSP factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function indexedTitles(pages) {
  const index = `${pages[1]} ${pages[2]}`;
  return [...index.matchAll(/(?:^|\s)\d{2}\s+(DSP\s+.+?)\s+(\d{2,3})(?=\s+\d{2}\s+DSP|\s+Fund Snapshot|$)/g)]
    .map((match) => ({ title: clean(match[1].replace(/\s+\d+\s+Sr\..*$/i, '')), page: Number(match[2]) }));
}

function asOfDate(page) {
  const match = page.match(/NAV AS ON\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function managers(page) {
  return [...page.matchAll(/FUND MANAGER\s+([A-Z][A-Za-z. ]+?)\s+Total work experience of\s+(\d+(?:\.\d+)?)\s+years?\.\s+Managing this Scheme since\s+([A-Za-z]+\s+\d{4})/g)]
    .map((match) => ({ name: clean(match[1]), experience: Number(match[2]), since: match[3] }));
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
  console.log('Discovering the latest DSP monthly factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url);
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = indexedTitles(pages).map(({ title, page }) => {
    const text = pages[page - 1] || '';
    return { codes: families.get(key(title)) || [], date: asOfDate(text), managerRows: managers(text), debt: debtQuants(text) };
  }).filter((record) => record.codes.length && record.date);
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 250) throw new Error(`Only ${codes.size} DSP NAV plans matched indexed official scheme pages; aborting without changing data.`);
  const dates = [...new Set(records.map((record) => record.date))];
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  const imported = new Set(); let debtCount = 0;
  db.transaction(() => {
    for (const date of dates) for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of records) for (const code of record.codes) {
      if (imported.has(code)) continue;
      snapshot.run(code, record.date, AMC, null, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, record.date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) manager.run(code, record.date, row.name, row.since, row.experience, url);
      if (record.debt) { quant.run(code, record.date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      imported.add(code);
    }
  })();
  console.log(`Imported DSP factsheet observations for ${imported.size} NAV plans (${debtCount} debt-plan quant snapshots) as of ${dates.join(', ')}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
