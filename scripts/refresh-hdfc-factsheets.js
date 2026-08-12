const db = require('../server/db');

const AMC = 'HDFC Mutual Fund';
const SOURCE_PAGE = 'https://www.hdfcfund.com/mutual-funds/factsheets';

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) {
  return text(value).toUpperCase()
    .replace(/HDFC/g, '')
    .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function dateFromText(value) {
  const match = text(value).match(/\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function daysOrYears(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return /^days?$/i.test(unit) ? numeric / 365.2425 : numeric;
}

async function getLatestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`HDFC factsheet page returned ${response.status}.`);
  const html = await response.text();
  const links = [...html.matchAll(/https?:[^"'\s>]+\.pdf[^"'\s<]*/gi)].map((match) => match[0]);
  const sourceUrl = [...new Set(links)].find((link) => /HDFC(?:%20|\s)MF(?:%20|\s)Factsheet/i.test(link) && !/Index(?:%20|\s)Solutions/i.test(link));
  if (!sourceUrl) throw new Error('HDFC latest main factsheet PDF was not found.');
  return sourceUrl;
}

async function extractPages(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0', referer: SOURCE_PAGE } });
  if (!response.ok) throw new Error(`HDFC factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return pages;
}

function managersFromPage(page) {
  const start = page.search(/FUND MANAGER/i);
  const end = page.search(/DATE OF ALLOTMENT|NAV\s*\(As On/i);
  if (start < 0 || end <= start) return [];
  const section = page.slice(start, end);
  return [...section.matchAll(/([A-Z][A-Za-z. ]+?)\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+(?:Over\s+)?([\d.]+)\s+years?/g)]
    .map((match) => ({ managerName: text(match[1]).replace(/^Name Since Total Exp\s*/i, ''), managingSince: text(match[2]), experienceYears: Number(match[3]) }))
    .filter((manager) => manager.managerName && Number.isFinite(manager.experienceYears));
}

function exitLoadFromPage(page) {
  const start = page.search(/EXIT LOAD\$\$/i);
  if (start < 0) return null;
  const section = page.slice(start).replace(/^EXIT LOAD\$\$\s*/i, '');
  const end = section.search(/(?:\.\.\.\.Contd|PORTFOLIO|SIP PERFORMANCE|Investment Amount, Plans & Options)/i);
  return text(end >= 0 ? section.slice(0, end) : section);
}

function debtQuantsFromPage(page) {
  const match = page.match(/Residual Maturity\s*\*?\s*Macaulay Duration\s*\*?\s*Modified Duration\s*\*?\s*Annualized Portfolio YTM#?\*?\s*([\d.]+)\s*(Years|Days)\s*([\d.]+)\s*(Years|Days)\s*([\d.]+)\s*(Years|Days)\s*([\d.]+)\s*%/i);
  if (!match) return null;
  const standardDeviation = page.match(/Risk Ratio\s+Standard Deviation\s+Beta\s+Sharpe Ratio\*?\s*([\d.]+)\s*%/i);
  return {
    residualMaturity: daysOrYears(match[1], match[2]),
    macaulayDuration: daysOrYears(match[3], match[4]),
    modifiedDuration: daysOrYears(match[5], match[6]),
    ytm: Number(match[7]),
    standardDeviation: standardDeviation ? Number(standardDeviation[1]) : null,
  };
}

async function main() {
  console.log('Fetching HDFC monthly factsheet...');
  const sourceUrl = await getLatestFactsheet();
  const pages = await extractPages(sourceUrl);
  const asOfDate = pages.map(dateFromText).find(Boolean);
  if (!asOfDate) throw new Error('HDFC factsheet did not expose a recognised as-of date.');
  const sourceFile = new URL(sourceUrl).pathname.split('/').pop();
  const schemeFamilies = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
    const key = normalized(scheme.name);
    if (key.length < 6) continue;
    const family = schemeFamilies.get(key) || [];
    family.push(scheme.scheme_code);
    schemeFamilies.set(key, family);
  }
  const candidates = [...schemeFamilies.entries()].sort((left, right) => right[0].length - left[0].length);
  const snapshotUpsert = db.prepare(`INSERT INTO scheme_factsheet_snapshots
    (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET
    exit_load_text=excluded.exit_load_text, source_url=excluded.source_url, source_file=excluded.source_file`);
  const deleteManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code = ? AND as_of_date = ?');
  const managerInsert = db.prepare(`INSERT INTO scheme_factsheet_managers
    (scheme_code, as_of_date, manager_name, managing_since, experience_years, source_url) VALUES (?, ?, ?, ?, ?, ?)`);
  const debtUpsert = db.prepare(`INSERT INTO scheme_debt_quant_snapshots
    (scheme_code, as_of_date, modified_duration_years, residual_maturity_years, yield_to_maturity_percent, macaulay_duration_years, standard_deviation_percent, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET
    modified_duration_years=excluded.modified_duration_years, residual_maturity_years=excluded.residual_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, standard_deviation_percent=excluded.standard_deviation_percent, source_url=excluded.source_url`);
  const deleteCurrentManagers = db.prepare(`DELETE FROM scheme_factsheet_managers
    WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  const deleteCurrentQuants = db.prepare(`DELETE FROM scheme_debt_quant_snapshots
    WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  const deleteCurrentSnapshots = db.prepare(`DELETE FROM scheme_factsheet_snapshots
    WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  let matched = 0;
  let debtCount = 0;
  db.transaction(() => {
    // A re-run replaces this source month's HDFC observations, while leaving
    // prior factsheet months intact.
    deleteCurrentManagers.run(asOfDate, AMC);
    deleteCurrentQuants.run(asOfDate, AMC);
    deleteCurrentSnapshots.run(asOfDate, AMC);
    for (const page of pages) {
      if (!/FUND MANAGER/i.test(page) || !/EXIT LOAD\$\$/i.test(page)) continue;
      const pageKey = normalized(page);
      const family = candidates.find(([key]) => pageKey.includes(key));
      if (!family) continue;
      const exitLoad = exitLoadFromPage(page);
      const managers = managersFromPage(page);
      const quants = debtQuantsFromPage(page);
      for (const schemeCode of family[1]) {
        snapshotUpsert.run(schemeCode, asOfDate, AMC, exitLoad, sourceUrl, sourceFile);
        deleteManagers.run(schemeCode, asOfDate);
        managers.forEach((manager) => managerInsert.run(schemeCode, asOfDate, manager.managerName, manager.managingSince, manager.experienceYears, sourceUrl));
        if (quants) {
          debtUpsert.run(schemeCode, asOfDate, quants.modifiedDuration, quants.residualMaturity, quants.ytm, quants.macaulayDuration, quants.standardDeviation, sourceUrl);
          debtCount += 1;
        }
        matched += 1;
      }
    }
  })();
  console.log(`Imported HDFC factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${asOfDate}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
