const db = require('../server/db');
const AMC = 'NJ Mutual Fund';
const DOWNLOADS = 'https://downloads.njmutualfund.com/downloads.php';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const families = ['NJ Flexi Cap Fund', 'NJ ELSS Tax Saver Scheme', 'NJ Balanced Advantage Fund', 'NJ Arbitrage Fund', 'NJ Overnight Fund'];

async function latestFactsheet() {
  const response = await fetch(DOWNLOADS, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`NJ downloads page returned ${response.status}.`);
  const html = await response.text();
  const match = html.match(/href="([^"]*viewfile\.php\?file=NJ-MF-Factsheet-[^"]+\.pdf)"[^>]*>NJ Mutual Fund Factsheet/iu);
  if (!match) throw new Error('NJ did not expose a current monthly factsheet PDF.');
  return new URL(match[1], DOWNLOADS).href;
}
async function readPages(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`NJ factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}
function monthEnd(text) {
  const match = text.match(/Report as on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return date.toISOString().slice(0, 10);
}
function value(text, label) {
  const match = text.match(new RegExp(`${label}\\s*[:\\s]+([\\d.-]+)\\s*%?`, 'i'));
  return match ? Number(match[1]) : null;
}
function pageValues(page) {
  const exit = page.match(/Exit Load:\s*([\s\S]{0,100}?)(?=\s+Tier 1 Benchmark)/i);
  const managerText = page.match(/Name of the Fund Manager:\s*([^.]*)\.\s*Work Experience:\s*([^.]*)\./i);
  const managers = managerText ? [...managerText[1].matchAll(/Mr\.\s*([A-Za-z ]+?)(?:,| and|$)/g)].map((m) => ({
    name: `Mr. ${clean(m[1])}`,
    experience: Number((managerText[2].match(new RegExp(`${m[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-\\s*(\\d+)`, 'i')) || [])[1]) || null,
  })) : [];
  const sd = value(page, 'Standard deviation'); const beta = value(page, 'Beta'); const sharpe = value(page, 'Sharpe Ratio');
  const ytm = value(page, 'Yield to Maturity'); const modified = value(page, 'Modified Duration'); const macaulay = value(page, 'Macaulay Duration');
  return { exit: exit ? clean(exit[1]) : null, managers, risk: [sd, beta, sharpe].some((x) => x !== null) ? { sd, beta, sharpe } : null, debt: [ytm, modified, macaulay].some((x) => x !== null) ? { ytm, modified, macaulay } : null };
}
async function main() {
  console.log('Discovering the latest NJ factsheet...'); const url = await latestFactsheet(); const pages = await readPages(url);
  const date = monthEnd(pages.join(' ')); if (!date) throw new Error('NJ factsheet has no recognised disclosure date.');
  const schemes = db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC);
  const records = families.map((family) => ({ family, page: pages.find((p) => p.toUpperCase().includes(family.toUpperCase()) && /Name of the Fund Manager:/i.test(p)), codes: schemes.filter((s) => s.name.startsWith(family)).map((s) => s.scheme_code) }));
  const matched = records.filter((r) => r.page && r.codes.length); const count = matched.flatMap((r) => r.codes).length;
  if (count !== 16) throw new Error(`Only ${count} NJ published plan records matched; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const risk = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  const debt = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0; let debtCount = 0;
  db.transaction(() => { for (const table of ['scheme_factsheet_managers','scheme_factsheet_risk_snapshots','scheme_debt_quant_snapshots','scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC); for (const record of matched) { const values = pageValues(record.page); for (const code of record.codes) { snapshot.run(code,date,AMC,values.exit,url,new URL(url).pathname.split('/').pop()); values.managers.forEach((m) => manager.run(code,date,m.name,null,m.experience,url)); if(values.risk){risk.run(code,date,'3Y monthly',values.risk.sharpe,values.risk.beta,null,null,null,values.risk.sd,null,url);riskCount+=1;} if(values.debt){debt.run(code,date,values.debt.modified,null,null,values.debt.ytm,values.debt.macaulay,null,url);debtCount+=1;} imported+=1; } } })();
  console.log(`Imported NJ factsheet observations for ${imported} published NAV plans (${riskCount} official risk; ${debtCount} debt-quant snapshots) as of ${date}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
