const db = require('../server/db');

const AMC = 'Kotak Mahindra Mutual Fund';
const ROOT = 'https://vatseelabs-s3.kotakmf.com/FormsDownloads/Factsheet';
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) {
  return text(value).toUpperCase().replace(/KOTAK(?: MAHINDRA)?/g, '')
    .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function number(value) { const found = text(value).match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : null; }
function daysOrYears(value, unit) { const n = number(value); return Number.isFinite(n) ? (/days?/i.test(unit) ? n / 365.2425 : n) : null; }

async function getLatestFactsheet() {
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let offset = 1; offset <= 4; offset += 1) {
    const date = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - offset, 1));
    const month = months[date.getUTCMonth()];
    const sourceUrl = `${ROOT}/Factsheet-for-${month}-${date.getUTCFullYear()}/KotakMFFactsheet${month}${date.getUTCFullYear()}.pdf`;
    if ((await fetch(sourceUrl, { method: 'HEAD' })).ok) return sourceUrl;
  }
  throw new Error('Kotak published no usable monthly factsheet in the latest four completed months.');
}
async function extractPages(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Kotak factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= document.numPages; pageNo += 1) {
    const page = await document.getPage(pageNo);
    pages.push((await page.getTextContent()).items.map((item) => item.str).join(' '));
  }
  return pages;
}
function asOfDateFromPages(pages) {
  const match = pages.join(' ').match(/Data\s+as\s+on\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function exitLoadFromPage(page) {
  const match = page.match(/Exit Load:\s*([\s\S]*?)(?=\s+Data\s+as\s+on\b)/i);
  return match ? text(match[1]) : null;
}
function managersFromPage(page) {
  const match = page.match(/Fund Manager\*:\s*([\s\S]*?)(?=\s+AAUM:)/i);
  if (!match) return [];
  return text(match[1]).replace(/\(effective[^)]*\)/ig, '').split(/\s*&\s*|\s+and\s+/i)
    .map((managerName) => text(managerName)).filter(Boolean).map((managerName) => ({ managerName }));
}
function debtQuantsFromPage(page) {
  const section = page.match(/Debt Quant & Ratios([\s\S]*?)(?=\s+Expense Ratio\*\*)/i)?.[1];
  if (!section) return null;
  const layout = section.match(/Average Maturity\s+Modified Duration\s+Macaulay Duration\s+Annualised YTM\*\s+\$?\s*Standard Deviation\s+([\d.]+)\s*(days|yrs|years)\s+([\d.]+)\s*(days|yrs|years)\s+([\d.]+)\s*(days|yrs|years)\s+([\d.]+)%\s+([\d.]+)%/i);
  if (!layout) return null;
  return { averageMaturity: daysOrYears(layout[1], layout[2]), modifiedDuration: daysOrYears(layout[3], layout[4]), macaulayDuration: daysOrYears(layout[5], layout[6]), ytm: Number(layout[7]), standardDeviation: Number(layout[8]) };
}

async function main() {
  console.log('Fetching Kotak monthly factsheet...');
  const sourceUrl = await getLatestFactsheet();
  const pages = await extractPages(sourceUrl);
  const asOfDate = asOfDateFromPages(pages);
  if (!asOfDate) throw new Error('Kotak factsheet did not expose a recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
    const key = normalized(scheme.name); if (key.length < 6) continue;
    families.set(key, [...(families.get(key) || []), scheme.scheme_code]);
  }
  const candidates = [...families.entries()].sort((a, b) => b[0].length - a[0].length);
  const sourceFile = new URL(sourceUrl).pathname.split('/').pop();
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text, source_url=excluded.source_url, source_file=excluded.source_file`);
  const removeManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code = ? AND as_of_date = ?');
  const addManager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code, as_of_date, manager_name, source_url) VALUES (?, ?, ?, ?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code, as_of_date, modified_duration_years, average_maturity_years, yield_to_maturity_percent, macaulay_duration_years, standard_deviation_percent, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years, average_maturity_years=excluded.average_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, standard_deviation_percent=excluded.standard_deviation_percent, source_url=excluded.source_url`);
  const clear = (table) => db.prepare(`DELETE FROM ${table} WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`).run(asOfDate, AMC);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    clear('scheme_factsheet_managers'); clear('scheme_debt_quant_snapshots'); clear('scheme_factsheet_snapshots');
    for (const page of pages) {
      if (!/Fund Manager\*:/i.test(page) || !/Exit Load:/i.test(page)) continue;
      const family = candidates.find(([key]) => normalized(page).includes(key));
      if (!family) continue;
      const exitLoad = exitLoadFromPage(page); const managers = managersFromPage(page); const debt = debtQuantsFromPage(page);
      for (const code of family[1]) {
        snapshot.run(code, asOfDate, AMC, exitLoad, sourceUrl, sourceFile); removeManagers.run(code, asOfDate);
        managers.forEach(({ managerName }) => addManager.run(code, asOfDate, managerName, sourceUrl));
        if (debt) { quant.run(code, asOfDate, debt.modifiedDuration, debt.averageMaturity, debt.ytm, debt.macaulayDuration, debt.standardDeviation, sourceUrl); debtCount += 1; }
        matched += 1;
      }
    }
  })();
  console.log(`Imported Kotak factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${asOfDate}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
