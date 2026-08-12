const db = require('../server/db');

const AMC = 'Franklin Templeton Mutual Fund';
const SOURCE_PAGE = 'https://www.franklintempletonindia.com/static/factsheet/index.html';
const clean = (value) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\b(?:FRANKLIN|TEMPLETON|INDIA|THE|ERSTWHILE|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function sourcePages() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Franklin factsheet index returned ${response.status}.`);
  return [...(await response.text()).matchAll(/href=["'](Innerpage\/[^"']+\.html)["']/gi)]
    .map((match) => new URL(match[1], SOURCE_PAGE).href)
    .filter((url) => !/(?:snapshot|market|note|review|positioning|risk-matrix|performance|product-label|fund-man|contact|disclaimer|winding-up|understand)/i.test(url));
}

function asOfDate(html) {
  const match = html.match(/As on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function title(html) {
  return clean(html.match(/font-weight:bold;font-size:25px;[^>]*>\s*([^<]+?)\s*(?:<!--|<)/i)?.[1]
    || html.match(/font-size:16px[^>]*>\s*([^<]+?)\s*</i)?.[1]);
}

function exitLoad(html) {
  const match = html.match(/Exit Load\s*\(for each purchase of Units\)[\s\S]{0,450}?<td[^>]*>\s*:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  return match ? clean(match[1]) : null;
}

function managers(html) {
  const match = html.match(/FUND MANAGER\(S\):[\s\S]{0,300}?<\/span>\s*([\s\S]*?)\s*<br/i);
  if (!match) return [];
  return clean(match[1]).replace(/\([^)]*dedicated[^)]*\)/gi, '').split(/\s*(?:,|&| and )\s*/i)
    .map((name) => clean(name.replace(/\([^)]*\)/g, ''))).filter((name) => name.length >= 3)
    .map((name) => ({ name }));
}

function numberAfter(html, label, suffix) {
  const match = html.match(new RegExp(`${label}[\\s\\S]{0,300}?<td[^>]*>\\s*([\\d.]+)\\s*${suffix}`, 'i'));
  return match ? Number(match[1]) : null;
}

function debtQuants(html) {
  const average = numberAfter(html, 'RESIDUAL MATURITY / AVERAGE MATURITY', '(?:Days|Years)');
  const ytm = numberAfter(html, 'ANNUALISED PORTFOLIO YTM', '%');
  const modified = numberAfter(html, 'MODIFIED DURATION', '(?:Days|Years)');
  const macaulay = numberAfter(html, 'MACAULAY DURATION', '(?:Days|Years)');
  const nearby = clean(html.match(/RESIDUAL MATURITY \/ AVERAGE MATURITY[\s\S]{0,1600}/i)?.[0]);
  const units = [...nearby.matchAll(/([\d.]+)\s*(Days|Years)/gi)].map((match) => /days/i.test(match[2]) ? Number(match[1]) / 365.2425 : Number(match[1]));
  return [average, ytm, modified, macaulay].every(Number.isFinite) ? { average: units[0] ?? average, ytm, modified: units[1] ?? modified, macaulay: units[2] ?? macaulay } : null;
}

async function load(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  const html = await response.text();
  return { url, title: title(html), date: asOfDate(html), exit: exitLoad(html), managerRows: managers(html), debt: debtQuants(html) };
}

async function main() {
  console.log('Discovering Franklin monthly digital factsheets...');
  const urls = await sourcePages(); const loaded = [];
  for (const url of urls) {
    try { const record = await load(url); if (record.title && record.date) loaded.push(record); } catch (error) { console.warn(`Skipping ${url}: ${error.message}`); }
  }
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = loaded.map((record) => ({ ...record, codes: families.get(key(record.title)) || [] })).filter((record) => record.codes.length);
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 100) throw new Error(`Only ${codes.size} Franklin NAV plans matched official scheme pages; aborting without changing data.`);
  const dates = [...new Set(records.map((record) => record.date))];
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  const imported = new Set(); let debtCount = 0;
  db.transaction(() => {
    for (const date of dates) for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of records) for (const code of record.codes) {
      if (imported.has(`${code}:${record.date}`)) continue;
      snapshot.run(code, record.date, AMC, record.exit, record.url, new URL(record.url).pathname.split('/').pop());
      clearManagers.run(code, record.date);
      for (const row of [...new Map(record.managerRows.map((item) => [item.name.toUpperCase(), item])).values()]) manager.run(code, record.date, row.name, null, null, record.url);
      if (record.debt) { quant.run(code, record.date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, record.url); debtCount += 1; }
      imported.add(`${code}:${record.date}`);
    }
  })();
  console.log(`Imported Franklin factsheet observations for ${imported.size} NAV plans (${debtCount} debt-plan quant snapshots) as of ${dates.join(', ')}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
