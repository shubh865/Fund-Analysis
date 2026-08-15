const db = require('../server/db');

const AMC = 'ITI Mutual Fund';
const BASE = 'https://www.itiamc.com/digitalfactsheet';
const clean = (value) => String(value || '').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

const pages = [
  ['Arbitrage-Fund.html', 'ITI Arbitrage Fund'], ['Balanced-Advantage.html', 'ITI Balanced Advantage Fund'],
  ['Banking.html', 'ITI Banking & PSU Debt Fund'], ['bff.html', 'ITI Banking and Financial Services Fund'],
  ['Bharat-Consumption-Fund.html', 'ITI Bharat Consumption Fund'], ['Business-Cycle.html', 'ITI Business Cycle Fund'],
  ['Dynamic.html', 'ITI Dynamic Term Fund'], ['Long-Term.html', 'ITI ELSS Tax Saver Fund'],
  ['Flexi-Cap.html', 'ITI Flexi Cap Fund'], ['Focused-Equity.html', 'ITI Focused Fund'],
  ['Large-Mid-Cap-Fund.html', 'ITI Large & Midcap Fund'], ['Large-Cap.html', 'ITI Large Cap Fund'],
  ['Liquid.html', 'ITI Liquid Fund'], ['Mid-Cap.html', 'ITI Mid Cap Fund'], ['Multi-Cap.html', 'ITI Multi Cap Fund'],
  ['Overnight.html', 'ITI Overnight Fund'], ['Pharma.html', 'ITI Pharma and Healthcare Fund'],
  ['Small-Cap.html', 'ITI Small Cap Fund'], ['Ultra-Short.html', 'ITI Ultra Short'], ['value.html', 'ITI Value Fund'],
];

function monthFolder(date) {
  return `${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}${date.getUTCFullYear()}`;
}

async function sourceMonth() {
  const now = new Date();
  for (let offset = 0; offset < 4; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const folder = monthFolder(date);
    const url = `${BASE}/${folder}/innerpages/Multi-Cap.html`;
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) continue;
    const html = await response.text();
    if (/Risk Ratio[\s\S]{0,200}Standard Deviation|NAV as on/i.test(html)) return { folder, url };
  }
  throw new Error('ITI has not exposed a usable recent legacy factsheet month.');
}

function textFromHtml(html) {
  return clean(html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function dateFrom(text) {
  const match = text.match(/(?:NAV|Computed[^.]{0,80})\s+(?:as on|ended)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!match) return null;
  const value = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

function exitLoad(text) {
  const match = text.match(/Exit Load:\s*([\s\S]{1,600}?)(?=\s+Total Expense Ratio:|\s+Fund Manager\b)/i);
  return match ? clean(match[1]) : null;
}

function managers(text) {
  const block = text.match(/Fund Manager\s+([\s\S]{1,1200}?)(?=\s+Portfolio Details|\s+Risk Ratio|\s+NAV as on)/i)?.[1] || '';
  const list = [];
  const pattern = /((?:Mr\.?|Ms\.?|Mrs\.?)\s+[A-Za-z][A-Za-z .'-]+?)\s*\(Since\s+([^)]+)\)\s*(?:Total Experience\s*:\s*([\d.]+)\s*years?)?/gi;
  for (const match of block.matchAll(pattern)) list.push({ name: clean(match[1]), since: clean(match[2]), experience: match[3] ? Number(match[3]) : null });
  return list;
}

function numberAfter(text, label) {
  const match = text.match(new RegExp(`${label}\\s*[:^*]*\\s*([\\d.]+)%?`, 'i'));
  return match ? Number(match[1]) : null;
}

function risk(text) {
  const standardDeviation = numberAfter(text, 'Standard Deviation');
  const beta = numberAfter(text, 'Beta');
  const sharpe = numberAfter(text, 'Sharpe Ratio');
  if ([standardDeviation, beta, sharpe].every((value) => value === null)) return null;
  const method = text.match(/Computed for the\s+([\d-]+)\s*yr\s+period ended[^.]*\.\s*Based on\s+([A-Za-z]+)\s+return/i);
  return {
    standardDeviation,
    beta,
    sharpe,
    window: method ? `${String(method[1]).replace(/\D/g, '')}Y ${method[2].toLowerCase()}` : 'AMC methodology',
  };
}

function debtQuants(text) {
  const modifiedDuration = numberAfter(text, 'Modified Duration');
  const averageMaturity = numberAfter(text, 'Average Maturity');
  const residualMaturity = numberAfter(text, 'Residual Maturity');
  // ITI writes this as “Yield To Maturity (Regular & Direct) Plans”, so
  // allow its plan-description text between the label and the reported rate.
  const ytmMatch = text.match(/Yield\s+To\s+Maturity(?:\s*\([^)]*\))?(?:\s+Plans?)?\s*:\s*([\d.]+)%/i);
  const ytm = ytmMatch ? Number(ytmMatch[1]) : null;
  const macaulay = numberAfter(text, 'Macaulay Duration');
  if ([modifiedDuration, averageMaturity, residualMaturity, ytm, macaulay].every((value) => value === null)) return null;
  return { modifiedDuration, averageMaturity, residualMaturity, ytm, macaulay };
}

async function main() {
  console.log('Discovering the latest ITI digital factsheet month...');
  const source = await sourceMonth();
  const schemes = db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC);
  const results = [];
  for (const [file, family] of pages) {
    const url = `${BASE}/${source.folder}/innerpages/${file}`;
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) continue;
    const text = textFromHtml(await response.text());
    const asOf = dateFrom(text);
    if (!asOf) continue;
    const codes = schemes.filter((scheme) => scheme.name.toLowerCase().includes(family.toLowerCase())).map((scheme) => scheme.scheme_code);
    if (!codes.length) continue;
    results.push({ codes, asOf, url, exit: exitLoad(text), managers: managers(text), risk: risk(text), debt: debtQuants(text) });
  }
  const expected = new Set(results.flatMap((item) => item.codes));
  if (expected.size < 90) throw new Error(`Only ${expected.size} ITI NAV plans matched official pages; aborting without changing data.`);
  const date = [...new Set(results.map((item) => item.asOf))].sort().at(-1);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const riskInsert = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  const debtInsert = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_risk_snapshots', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const item of results) for (const code of item.codes) {
      snapshot.run(code, item.asOf, AMC, item.exit, item.url, item.url.split('/').pop());
      for (const person of item.managers) manager.run(code, item.asOf, person.name, person.since, person.experience, item.url);
      if (item.risk) { riskInsert.run(code, item.asOf, item.risk.window, item.risk.sharpe, item.risk.beta, null, null, null, item.risk.standardDeviation, null, item.url); riskCount += 1; }
      if (item.debt) { debtInsert.run(code, item.asOf, item.debt.modifiedDuration, item.debt.averageMaturity, item.debt.residualMaturity, item.debt.ytm, item.debt.macaulay, item.risk?.standardDeviation ?? null, item.url); debtCount += 1; }
      imported += 1;
    }
  })();
  console.log(`Imported ITI factsheet observations for ${imported} NAV plans (${riskCount} official risk snapshots; ${debtCount} debt-quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
