const db = require('../server/db');
const AMC = 'Shriram Mutual Fund';
const SOURCE_PAGE = 'https://www.shriramamc.in/factsheet';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase().replace(/\b(?:SHRIRAM|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ETF|FUND|DAILY|MONTHLY|WEEKLY|ANNUAL|QUARTERLY)\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestPdf() {
  const page = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!page.ok) throw new Error(`Shriram factsheet page returned ${page.status}.`);
  const html = await page.text();
  const matches = [...html.matchAll(/https:\/\/cdn\.shriramamc\.in\/[^"\\]+\/Factsheet-July-2026[^"\\]+\.pdf/gi)].map((match) => match[0]);
  if (!matches.length) throw new Error('Shriram did not expose its latest factsheet PDF.');
  return matches[0];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Shriram factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) pages.push(clean((await (await pdf.getPage(n)).getTextContent()).items.map((item) => item.str).join(' ')));
  return pages;
}

function numberAfter(text, label) { const match = text.match(new RegExp(`${label}[\\s:^]*([\\d.]+)%?`, 'i')); return match ? Number(match[1]) : null; }
function exitLoad(text) { const match = text.match(/Exit Load\s*:\s*([\s\S]{1,500}?)(?=\s+(?:Types? of Scheme|Minimum Investment|Total Expense|Fund Managers?|Quantitative Data|Portfolio))/i); return match ? clean(match[1]) : null; }
function managers(text) { return [...text.matchAll(/((?:Mr\.?|Ms\.?|Mrs\.?)\s+[A-Za-z][A-Za-z .'-]+?)\s*\(Since\s+([^)]*)\)\s*Total Experience:\s*(?:Over\s*)?([\d.]+)\s+years/gi)].map((match) => ({ name: clean(match[1]), since: clean(match[2]), experience: Number(match[3]) })); }
function risk(text) {
  const grouped = text.match(/Standard Deviation\s*\(Annualised\)[\s\S]{0,180}?Portfolio Beta[\s\S]{0,180}?Sharpe Ratio[\s\S]{0,180}?([\d.]+)%\s+(-?[\d.]+)\s+(-?[\d.]+)/i);
  const sd = grouped ? Number(grouped[1]) : numberAfter(text, 'Standard Deviation(?: \(Annualised\))?');
  const beta = grouped ? Number(grouped[2]) : numberAfter(text, '(?:Portfolio )?Beta');
  const sharpe = grouped ? Number(grouped[3]) : numberAfter(text, 'Sharpe Ratio');
  return [sd, beta, sharpe].every((value) => value === null) ? null : { sd, beta, sharpe, window: /3-year period/i.test(text) ? '3Y monthly' : 'AMC methodology' };
}
function debt(text) {
  const inYears = (value, unit) => unit.toLowerCase().startsWith('day') ? Number(value) / 365 : Number(value);
  const grouped = text.match(/Average Maturity\s+Modified Duration\s+Macaulay Duration\s+Yield to Maturity\s+([\d.]+)\s*(days?|years?)\s+([\d.]+)\s*(days?|years?)\s+([\d.]+)\s*(days?|years?)\s+([\d.]+)%/i);
  const avg = grouped ? inYears(grouped[1], grouped[2]) : numberAfter(text, 'Average Maturity');
  const modified = grouped ? inYears(grouped[3], grouped[4]) : numberAfter(text, 'Modified Duration');
  const macaulay = grouped ? inYears(grouped[5], grouped[6]) : numberAfter(text, 'Macaulay Duration');
  const ytm = grouped ? Number(grouped[7]) : numberAfter(text, '(?:Annualised Portfolio )?Yield to Maturity');
  const residual = numberAfter(text, 'Residual Maturity');
  return [avg, residual, modified, macaulay, ytm].every((value) => value === null) ? null : { avg, residual, modified, macaulay, ytm };
}

async function main() {
  console.log('Discovering the latest Shriram factsheet...');
  const url = await latestPdf(); const pages = await pagesFrom(url);
  const date = pages.join(' ').match(/Data as on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!date) throw new Error('Shriram factsheet has no recognised as-of date.');
  const asOf = new Date(`${date[1]} ${date[2]}, ${date[3]} UTC`).toISOString().slice(0, 10);
  const schemes = db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC);
  const families = new Map(); for (const scheme of schemes) { const family = key(scheme.name); families.set(family, [...(families.get(family) || []), scheme.scheme_code]); }
  const recordMap = new Map(); let active = null;
  for (const page of pages) {
    const title = page.match(/\b(SHRIRAM\s+[A-Z0-9 &-]+?(?:FUND|ETF))\b/);
    if (title && families.has(key(title[1]))) {
      const familyKey = key(title[1]);
      active = recordMap.get(familyKey) || { codes: families.get(familyKey), text: '' };
      active.text += ` ${page}`;
      recordMap.set(familyKey, active);
    } else if (active) active.text += ` ${page}`;
  }
  const records = [...recordMap.values()];
  const expected = new Set(records.flatMap((record) => record.codes));
  if (expected.size < 25) throw new Error(`Only ${expected.size} Shriram NAV plans matched the official factsheet; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const riskInsert = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  const debtInsert = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0; let debtCount = 0;
  db.transaction(() => { for (const table of ['scheme_factsheet_managers','scheme_factsheet_risk_snapshots','scheme_debt_quant_snapshots','scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(asOf, AMC); for (const record of records) for (const code of record.codes) { const itemRisk = risk(record.text); const itemDebt = debt(record.text); snapshot.run(code,asOf,AMC,exitLoad(record.text),url,new URL(url).pathname.split('/').pop()); for (const person of managers(record.text)) manager.run(code,asOf,person.name,person.since,person.experience,url); if(itemRisk){riskInsert.run(code,asOf,itemRisk.window,itemRisk.sharpe,itemRisk.beta,null,null,null,itemRisk.sd,null,url);riskCount+=1;} if(itemDebt){debtInsert.run(code,asOf,itemDebt.modified,itemDebt.avg,itemDebt.residual,itemDebt.ytm,itemDebt.macaulay,itemRisk?.sd??null,url);debtCount+=1;} imported+=1; } })();
  console.log(`Imported Shriram factsheet observations for ${imported} NAV plans (${riskCount} official risk snapshots; ${debtCount} debt-quant snapshots) as of ${asOf}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
