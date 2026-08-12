const db = require('../server/db');
const AMC = 'PPFAS Mutual Fund';
const ROOT = 'https://amc.ppfas.com/downloads/digital-factsheet';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const text = (value) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const normalized = (value) => text(value).toUpperCase().replace(/PARAG PARIKH/g, '').replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const number = (value) => { const found = text(value).match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : null; };
async function latestSource() {
  const now = new Date(); now.setUTCDate(1);
  for (let offset = 1; offset <= 4; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const month = MONTHS[date.getUTCMonth()];
    const url = `${ROOT}/${date.getUTCFullYear()}/${month}-${date.getUTCFullYear()}/`;
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (response.ok && /Factsheet\s*-\s*[A-Za-z]+\s+\d{4}/i.test(await response.clone().text())) return { url, html: await response.text() };
  }
  throw new Error('PPFAS published no usable digital factsheet in the latest four completed months.');
}
function sections(html) { return html.split(/(?=<h2[^>]*class="text-brand text-2xl")/i).filter((part) => /<h2/i.test(part)); }
function values(section) {
  const heading = text(section.match(/<h2[^>]*>([^<]+)/i)?.[1]);
  const date = text(section.match(/Factsheet\s*-\s*([A-Za-z]+\s+\d{4})/i)?.[1]);
  const exit = text(section.match(/<strong>Exit Load<\/strong>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i)?.[1]);
  const managers = [...section.matchAll(/<strong>(Mr\.|Ms\.|Mrs\.)\s*([^<]+)<\/strong>[\s\S]{0,220}?(?:Since\s+([^)<]+)|Since Inception)/gi)]
    .map((m) => ({ managerName: text(`${m[1]} ${m[2]}`).replace(/[-–]+$/g, '').trim(), managingSince: m[3] ? text(m[3]) : 'Since inception' }));
  const metric = (label) => number(section.match(new RegExp(`${label}[\\s\\S]{0,500}?<div[^>]*>\\s*([\\d.]+)`, 'i'))?.[1]);
  const quants = { average: metric('(?:Average Maturity|Avg maturity of the fund)'), modified: metric('Modified Duration'), ytm: metric('Yield to Maturity'), macaulay: metric('Macaulay duration'), stddev: metric('Standard Deviation') };
  return { heading, date, exit: exit || null, managers, quants: Object.values(quants).some(Number.isFinite) ? quants : null };
}
async function main() {
  console.log('Fetching PPFAS monthly digital factsheet...');
  const { url, html } = await latestSource();
  const sourceFile = new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('-');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) { const key = normalized(scheme.name); if (key.length >= 6) families.set(key, [...(families.get(key) || []), scheme.scheme_code]); }
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const removeManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,source_url) VALUES (?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    for (const section of sections(html)) {
      const item = values(section); if (!item.heading || !item.date) continue;
      const parsed = new Date(`${item.date} UTC`); const asOf = Number.isNaN(parsed.getTime()) ? null : `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate()}`;
      const family = [...families.entries()].find(([key]) => normalized(item.heading).includes(key)); if (!asOf || !family) continue;
      for (const code of family[1]) {
        snapshot.run(code, asOf, AMC, item.exit, url, sourceFile); removeManagers.run(code, asOf);
        [...new Map(item.managers.map((m) => [m.managerName.toUpperCase(), m])).values()].forEach((m) => manager.run(code, asOf, m.managerName, m.managingSince, url));
        if (item.quants) { quant.run(code, asOf, item.quants.modified, item.quants.average, item.quants.ytm, item.quants.macaulay, item.quants.stddev, url); debtCount += 1; }
        matched += 1;
      }
    }
  })();
  console.log(`Imported PPFAS factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots).`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
