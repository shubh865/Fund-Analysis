const db = require('../server/db');

const AMC = 'Invesco Mutual Fund';
const SOURCE_PAGE = 'https://www.invescomutualfund.com/literature-and-form?tab=Forms';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
// The issuer PDF's embedded font occasionally drops the final letter in “India”.
// Remove the issuer name before matching the stable, scheme-specific part.
const key = (value) => clean(value).toUpperCase()
  .replace(/INVESCO/g, '').replace(/INDI[A-Z]*/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const number = (value) => { const hit = clean(value).match(/-?\d+(?:\.\d+)?/); return hit ? Number(hit[0]) : null; };
const years = (value, unit) => /days?/i.test(unit) ? Number(value) / 365.2425 : Number(value);

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Invesco literature page returned ${response.status}.`);
  const html = await response.text();
  const links = [...html.matchAll(/href=["']([^"']*factsheet[^"']*\.pdf[^"']*)["']/gi)]
    .map((hit) => new URL(hit[1].replace(/&amp;/g, '&'), SOURCE_PAGE).href);
  if (links.length) return links[0];
  // The issuer sometimes renders this list client-side. Its dated official
  // document path is stable, so probe recent completed months rather than
  // relying on a stale hard-coded month.
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const today = new Date();
  for (let offset = 1; offset <= 5; offset += 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const month = months[date.getUTCMonth()]; const year = date.getUTCFullYear();
    for (const separator of ['-', '---']) {
      const url = `https://www.invescomutualfund.com/docs/default-source/factsheet/invesco-mf-factsheet${separator}${month}-${year}.pdf`;
      if ((await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } })).ok) return url;
    }
  }
  throw new Error('Invesco has not published a usable main factsheet in the latest five completed months.');
}
async function pagesFrom(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Invesco factsheet returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push((await page.getTextContent()).items.map((item) => item.str).join(' '));
  }
  return pages;
}
function dateFrom(pages) {
  const hit = pages.join(' ').match(/As on\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!hit) return null;
  const parsed = new Date(`${hit[2]} ${hit[1]}, ${hit[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function exitLoad(segment) {
  const hit = segment.match(/Exit Load\s+([\s\S]*?)(?=\s+(?:Minimum Investment|Additional Purchase|Date of Allotment|NAV p\.u\.|Base Expense Ratio)\b)/i);
  return hit ? clean(hit[1]) : null;
}
function managers(segment) {
  const block = segment.match(/Fund Manager & Experience\s+([\s\S]*?)(?=\s+(?:Rating Profile|Asset Allocation|Performance Attributes|YTM|Lumpsum Performance)\b)/i)?.[1] || '';
  return [...block.matchAll(/([A-Z][A-Za-z. ]+?)\s+Total Experience\s+(\d+(?:\.\d+)?)\s+Years\s+Experience in managing this fund:\s+Since\s+(.+?)(?=\s+[A-Z][A-Za-z. ]+?\s+Total Experience|$)/gi)]
    .map((match) => ({ managerName: clean(match[1]), experienceYears: Number(match[2]), managingSince: clean(match[3]) }))
    .filter((manager) => manager.managerName && Number.isFinite(manager.experienceYears));
}
function debtQuants(segment) {
  const ytm = segment.match(/\bYTM\s+([\d.]+)%/i);
  const average = segment.match(/Average Maturity\s+([\d.]+)\s*(days|years)/i);
  const macaulay = segment.match(/Macaulay Duration\s+([\d.]+)\s*(days|years)/i);
  const modified = segment.match(/Modified Duration\s+([\d.]+)\s*(days|years)/i);
  if (!ytm || !average || !macaulay || !modified) return null;
  return { ytm: Number(ytm[1]), residual: years(average[1], average[2]), macaulay: years(macaulay[1], macaulay[2]), modified: years(modified[1], modified[2]) };
}

async function main() {
  console.log('Discovering the latest Invesco monthly factsheet...');
  const sourceUrl = await latestFactsheet();
  const pages = await pagesFrom(sourceUrl); const asOfDate = dateFrom(pages);
  if (!asOfDate) throw new Error('Invesco factsheet did not expose a recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
    const schemeKey = key(scheme.name); if (schemeKey.length >= 6) families.set(schemeKey, [...(families.get(schemeKey) || []), scheme.scheme_code]);
  }
  const candidates = [...families.entries()].sort((a, b) => b[0].length - a[0].length);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text, source_url=excluded.source_url, source_file=excluded.source_file`);
  const deleteManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const insertManager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code, as_of_date, manager_name, managing_since, experience_years, source_url) VALUES (?, ?, ?, ?, ?, ?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code, as_of_date, modified_duration_years, residual_maturity_years, yield_to_maturity_percent, macaulay_duration_years, source_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years, residual_maturity_years=excluded.residual_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, source_url=excluded.source_url`);
  const clear = (table) => db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(asOfDate, AMC);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    clear('scheme_factsheet_managers'); clear('scheme_debt_quant_snapshots'); clear('scheme_factsheet_snapshots');
    const imported = new Set();
    for (const segment of pages) {
      const family = candidates.find(([schemeKey]) => key(segment).includes(schemeKey));
      if (!family) continue;
      const load = exitLoad(segment); const managerRows = managers(segment); const debt = debtQuants(segment);
      for (const schemeCode of family[1]) {
        if (imported.has(schemeCode)) continue;
        snapshot.run(schemeCode, asOfDate, AMC, load, sourceUrl, new URL(sourceUrl).pathname.split('/').pop());
        deleteManagers.run(schemeCode, asOfDate);
        [...new Map(managerRows.map((manager) => [manager.managerName.toUpperCase(), manager])).values()].forEach((manager) => insertManager.run(schemeCode, asOfDate, manager.managerName, manager.managingSince, manager.experienceYears, sourceUrl));
        if (debt) { quant.run(schemeCode, asOfDate, debt.modified, debt.residual, debt.ytm, debt.macaulay, sourceUrl); debtCount += 1; }
        imported.add(schemeCode); matched += 1;
      }
    }
  })();
  console.log(`Imported Invesco factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${asOfDate}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
