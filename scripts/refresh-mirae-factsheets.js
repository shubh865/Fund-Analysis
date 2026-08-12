const db = require('../server/db');

const AMC = 'Mirae Asset Mutual Fund';
const SOURCE_PAGE = 'https://www.miraeassetmf.co.in/downloads/factsheet';
const API = 'https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalize = (value) => clean(value).toUpperCase()
  .replace(/MIRAE\s+ASSET/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ request: { modulename: 'Factsheet', pgno: 1, pgsize: 10 } }) });
  if (!response.ok) throw new Error(`Mirae factsheet listing returned ${response.status}.`);
  const payload = await response.json();
  const source = (payload.Data || []).find((item) => /active fund factsheet/i.test(item.Title || ''));
  if (!source?.URL) throw new Error('Mirae did not publish a usable active monthly factsheet.');
  return new URL(source.URL, SOURCE_PAGE).href;
}
async function pagesFrom(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Mirae factsheet returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) { const page = await pdf.getPage(number); pages.push((await page.getTextContent()).items.map((item) => item.str).join(' ')); }
  return pages;
}
function asOfDate(pages) {
  const hit = pages.join(' ').match(/Monthly Factsheet as on\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!hit) return null;
  const parsed = new Date(`${hit[2]} ${hit[1]}, ${hit[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function managers(segment) {
  const block = segment.match(/Fund Managers?\s*[:@]*\s*([\s\S]*?)(?=\s+(?:Allotment Date|Benchmark|Net AUM|Exit Load)\b)/i)?.[1] || '';
  return [...block.matchAll(/(Mr\.|Ms\.|Mrs\.)\s*([A-Z][A-Za-z. ]+?)(?=\s*(?:\(|Mr\.|Ms\.|Mrs\.|$))/g)]
    .map((match) => ({ managerName: clean(`${match[1]} ${match[2]}`), managingSince: null, experienceYears: null }));
}
function toYears(value, unit) { return /days?/i.test(unit) ? Number(value) / 365.2425 : Number(value); }
function debtQuants(segment) {
  const average = segment.match(/Average Maturity\s+([\d.]+)\s*(days|years)/i);
  const modified = segment.match(/Modified Duration\s+([\d.]+)\s*(days|years)/i);
  const macaulay = segment.match(/Macaulay Duration\s*:?\s*([\d.]+)\s*(days|years)/i);
  const ytm = segment.match(/(?:Annualized Portfolio )?YTM\*?\s+([\d.]+)%/i);
  if (!average || !modified || !macaulay || !ytm) return null;
  return { residual: toYears(average[1], average[2]), modified: toYears(modified[1], modified[2]), macaulay: toYears(macaulay[1], macaulay[2]), ytm: Number(ytm[1]) };
}
async function main() {
  console.log('Fetching Mirae Asset monthly factsheet...');
  const sourceUrl = await latestFactsheet(); const pages = await pagesFrom(sourceUrl); const date = asOfDate(pages);
  if (!date) throw new Error('Mirae factsheet did not expose a recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) { const name = normalize(scheme.name); if (name.length >= 6) families.set(name, [...(families.get(name) || []), scheme.scheme_code]); }
  const candidates = [...families.entries()].sort((a, b) => b[0].length - a[0].length);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET source_url=excluded.source_url, source_file=excluded.source_file`);
  const deleteManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const insertManager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code, as_of_date, manager_name, managing_since, experience_years, source_url) VALUES (?, ?, ?, ?, ?, ?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code, as_of_date, modified_duration_years, residual_maturity_years, yield_to_maturity_percent, macaulay_duration_years, source_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years, residual_maturity_years=excluded.residual_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, source_url=excluded.source_url`);
  const clear = (table) => db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    clear('scheme_factsheet_managers'); clear('scheme_debt_quant_snapshots'); clear('scheme_factsheet_snapshots');
    const imported = new Set();
    for (const segment of pages) {
      const family = candidates.find(([name]) => normalize(segment).includes(name)); if (!family) continue;
      const managerRows = managers(segment); const debt = debtQuants(segment);
      for (const code of family[1]) {
        if (imported.has(code)) continue;
        snapshot.run(code, date, AMC, null, sourceUrl, new URL(sourceUrl).pathname.split('/').pop()); deleteManagers.run(code, date);
        [...new Map(managerRows.map((manager) => [manager.managerName.toUpperCase(), manager])).values()].forEach((manager) => insertManager.run(code, date, manager.managerName, null, null, sourceUrl));
        if (debt) { quant.run(code, date, debt.modified, debt.residual, debt.ytm, debt.macaulay, sourceUrl); debtCount += 1; }
        imported.add(code); matched += 1;
      }
    }
  })();
  console.log(`Imported Mirae Asset factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
