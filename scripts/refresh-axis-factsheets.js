const db = require('../server/db');

const AMC = 'Axis Mutual Fund';
const ROOT = 'https://www.axismf.com/cms/sites/default/files/pdf-factsheets';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalized = (value) => text(value).toUpperCase().replace(/AXIS/g, '').replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const numeric = (value) => { const hit = text(value).match(/-?\d+(?:\.\d+)?/); return hit ? Number(hit[0]) : null; };
const toYears = (value, unit) => { const n = numeric(value); return Number.isFinite(n) ? (/days?/i.test(unit) ? n / 365.2425 : n) : null; };

async function latestUrl() {
  const now = new Date(); now.setUTCDate(1);
  for (let offset = 1; offset <= 4; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const url = `${ROOT}/Axis%20Fund%20Factsheet%20${MONTHS[date.getUTCMonth()]}%20${date.getUTCFullYear()}.pdf`;
    if ((await fetch(url, { method: 'HEAD' })).ok) return url;
  }
  throw new Error('Axis did not publish a usable main factsheet in the latest four completed months.');
}
async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Axis factsheet returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n += 1) { const page = await document.getPage(n); pages.push((await page.getTextContent()).items.map((item) => item.str).join(' ')); }
  return pages;
}
function asOfDate(pages) {
  const hit = pages.join(' ').match(/AS ON\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!hit) return null;
  const date = new Date(`${hit[2]} ${hit[1]}, ${hit[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function managers(segment) {
  const heading = segment.match(/FUND MANAGER\s+([\s\S]*?)\s+Work experience:/i)?.[1] || '';
  const names = [...heading.matchAll(/(Mr\.|Ms\.|Mrs\.)\s*([A-Z][A-Za-z. ]+?)(?=\s+(?:Mr\.|Ms\.|Mrs\.)|$)/g)]
    .map((m) => text(`${m[1]} ${m[2]}`));
  const details = [...segment.matchAll(/Work experience:\s*(\d+(?:\.\d+)?)\s+years?\.\s*(?:He|She) has been managing this fund since\s+(.+?)(?=\s+Work experience:|\s+(?:Government Bond|Corporate Bond|Instrument Type|Entry Load|Exit Load|Portfolio|Annualised|June \d{4}))/gi)];
  return names.map((managerName, index) => ({ managerName, experienceYears: Number(details[index]?.[1]), managingSince: text(details[index]?.[2]) }))
    .filter((m) => m.managerName && Number.isFinite(m.experienceYears));
}
function exitLoad(segment) { const hit = segment.match(/Exit Load:\s*([\s\S]*?)(?=\s+(?:Period|Face value|Past performance|INCOME DISTRIBUTION|Returns greater|FUND MANAGER)\b|$)/i); return hit ? text(hit[1]) : null; }
function debtQuants(segment) {
  const residual = segment.match(/RESIDUAL MATURITY\*?\s+([\d.]+)\s*(days|years)/i);
  const modified = segment.match(/MODIFIED DURATION\*?\s+([\d.]+)\s*(days|years)/i);
  const macaulay = segment.match(/MACAULAY DURATION\*?\s+([\d.]+)\s*(days|years)/i);
  const ytm = segment.match(/Annualised Portfolio YTM\*?\s+([\d.]+)%/i);
  if (!residual || !modified || !macaulay || !ytm) return null;
  return { residual: toYears(residual[1], residual[2]), modified: toYears(modified[1], modified[2]), macaulay: toYears(macaulay[1], macaulay[2]), ytm: Number(ytm[1]) };
}

async function main() {
  console.log('Fetching Axis monthly factsheet...');
  const sourceUrl = await latestUrl(); const pages = await pagesFrom(sourceUrl); const date = asOfDate(pages);
  if (!date) throw new Error('Axis factsheet had no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) { const key = normalized(scheme.name); if (key.length >= 6) families.set(key, [...(families.get(key) || []), scheme.scheme_code]); }
  const candidates = [...families.entries()].sort((a, b) => b[0].length - a[0].length);
  const sourceFile = new URL(sourceUrl).pathname.split('/').pop();
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text, source_url=excluded.source_url, source_file=excluded.source_file`);
  const deleteManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const addManager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code, as_of_date, manager_name, managing_since, experience_years, source_url) VALUES (?, ?, ?, ?, ?, ?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code, as_of_date, modified_duration_years, residual_maturity_years, yield_to_maturity_percent, macaulay_duration_years, source_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years, residual_maturity_years=excluded.residual_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, source_url=excluded.source_url`);
  const clear = (table) => db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    clear('scheme_factsheet_managers'); clear('scheme_debt_quant_snapshots'); clear('scheme_factsheet_snapshots');
    const imported = new Set();
    for (let index = 0; index < pages.length; index += 1) {
      const segment = `${pages[index]} ${pages[index + 1] || ''}`;
      if (!/FUND MANAGER/i.test(segment)) continue;
      const family = candidates.find(([key]) => normalized(segment).includes(key)); if (!family) continue;
      const managerRows = managers(segment); const debt = debtQuants(segment); const load = exitLoad(segment);
      for (const code of family[1]) {
        if (imported.has(code)) continue;
        snapshot.run(code, date, AMC, load, sourceUrl, sourceFile); deleteManagers.run(code, date);
        const uniqueManagers = [...new Map(managerRows.map((m) => [m.managerName.toUpperCase(), m])).values()];
        uniqueManagers.forEach((m) => addManager.run(code, date, m.managerName, m.managingSince, m.experienceYears, sourceUrl));
        if (debt) { quant.run(code, date, debt.modified, debt.residual, debt.ytm, debt.macaulay, sourceUrl); debtCount += 1; }
        imported.add(code); matched += 1;
      }
    }
  })();
  console.log(`Imported Axis factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
