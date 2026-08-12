const db = require('../server/db');

const AMC = 'HSBC Mutual Fund';
const SOURCE_PAGE = 'https://www.assetmanagement.hsbc.co.in/en/mutual-funds/investor-resources?Doc=fund-factsheets';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/HSBC/g, '').replace(/&/g, ' AND ')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const toYears = (value, unit) => /days?/i.test(unit) ? Number(value) / 365.2425 : Number(value);

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`HSBC resource page returned ${response.status}.`);
  const urls = [...(await response.text()).matchAll(/https?:[^"'\s]+\.pdf/gi)]
    .map((match) => match[0].replace(/&amp;/g, '&'))
    .filter((url) => /\/the-asset-(?:january|february|march|april|may|june|july|august|september|october|november|december)-20\d{2}\.pdf/i.test(url));
  if (!urls.length) throw new Error('HSBC did not expose a dated monthly “The Asset” factsheet PDF.');
  return urls[0];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`HSBC factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function titlesFromIndex(indexPage) {
  return [...indexPage.matchAll(/(HSBC\s+.+?)\s+(\d{2})(?=\s+(?:HSBC|Fund Snapshot)|$)/g)]
    .map((match) => ({ title: clean(match[1]), page: Number(match[2]) }));
}

function asOfDate(page) {
  const match = page.match(/NAV\s*\(as on\s*(\d{1,2})\.(\d{1,2})\.(\d{2})\)/i);
  if (!match) return null;
  return `20${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function managers(page) {
  return [...page.matchAll(/([A-Z][A-Za-z. ]+?)\s+\((?:Equity|Fixed Income|Overseas Investments)\)\s+Total Experience\s+(\d+(?:\.\d+)?)\s+Years\s+Managing [Ss]ince\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/g)]
    .map((match) => ({ name: clean(match[1]).replace(/^Nil\s+(?=[A-Z])/i, ''), experience: Number(match[2]), since: match[3] }));
}

function exitLoad(page) {
  const match = page.match(/Exit [Ll]oad:\s*([\s\S]*?)(?=\s+(?:Fund Manager(?: & Experience)?|Rating Profile|Quantitative Data|Lumpsum|[A-Z][a-z]+ [A-Z][a-z]+ \((?:Equity|Fixed Income|Overseas Investments)\)))/i);
  return match ? clean(match[1]) : null;
}

function debtQuants(page) {
  const match = page.match(/YTM\s*\$?\s*([\d.]+)%\s+Average Maturity\s*([\d.]+)\s*(Days|Years)\s+Modified Duration\s*([\d.]+)\s*(Days|Years)\s+Macaulay Duration\s*\^?\s*([\d.]+)\s*(Days|Years)/i);
  return match ? { ytm: Number(match[1]), average: toYears(match[2], match[3]), modified: toYears(match[4], match[5]), macaulay: toYears(match[6], match[7]) } : null;
}

async function main() {
  console.log('Discovering the latest HSBC monthly factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url);
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = titlesFromIndex(pages[1]).map(({ title, page }) => {
    const text = pages[page - 1] || '';
    return { codes: families.get(key(title)) || [], date: asOfDate(text), exit: exitLoad(text), managerRows: managers(text), debt: debtQuants(text) };
  }).filter((record) => record.codes.length && record.date);
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 80) throw new Error(`Only ${codes.size} HSBC NAV plans matched indexed official scheme pages; aborting without changing data.`);
  const dates = [...new Set(records.map((record) => record.date))];
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  const imported = new Set(); let debtCount = 0;
  db.transaction(() => {
    for (const date of dates) for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of records) for (const code of record.codes) {
      if (imported.has(code)) continue;
      snapshot.run(code, record.date, AMC, record.exit, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, record.date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) manager.run(code, record.date, row.name, row.since, row.experience, url);
      if (record.debt) { quant.run(code, record.date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      imported.add(code);
    }
  })();
  console.log(`Imported HSBC factsheet observations for ${imported.size} NAV plans (${debtCount} debt-plan quant snapshots) as of ${dates.join(', ')}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
