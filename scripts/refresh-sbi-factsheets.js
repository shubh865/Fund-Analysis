const db = require('../server/db');

const AMC = 'SBI Mutual Fund';
const SOURCE_PAGE = 'https://www.sbimf.com/factsheets';
const LISTING_URL = 'https://www.sbimf.com/ajaxcall/CMS/GetRecentFactSheets';

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) {
  return text(value).toUpperCase()
    .replace(/STATE BANK OF INDIA|SBI/g, '')
    .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function dateFromText(value) {
  const match = text(value).match(/(?:factsheet|details)\s+as\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}
function number(value) {
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function getLatestFactsheet() {
  const response = await fetch(LISTING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', referer: SOURCE_PAGE },
    body: '{}',
  });
  if (!response.ok) throw new Error(`SBI factsheet listing returned ${response.status}.`);
  const listing = await response.text();
  const links = [...listing.matchAll(/https?:[^"'\s<>]+\.pdf[^"'\s<>]*/gi)].map((match) => match[0]);
  const sourceUrl = [...new Set(links)].find((link) => /all-sbimf-schemes-factsheet/i.test(link) && !/passive/i.test(link));
  if (!sourceUrl) throw new Error('SBI latest main factsheet PDF was not found.');
  return sourceUrl;
}

async function extractPages(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0', referer: SOURCE_PAGE } });
  if (!response.ok) throw new Error(`SBI factsheet PDF returned ${response.status}.`);
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
  return [...page.matchAll(/(Mr\.|Ms\.|Mrs\.)\s*([A-Z][A-Za-z. ]+?(?:\s*-\s*(?:Equity|Debt))?)\s+(\d+(?:\.\d+)?)\s+years?\s+([A-Z][a-z]+\s+\d{4})/g)]
    .map((match) => ({ managerName: text(`${match[1]} ${match[2]}`), experienceYears: Number(match[3]), managingSince: text(match[4]) }))
    .filter((manager) => manager.managerName && Number.isFinite(manager.experienceYears));
}

function exitLoadFromPage(page) {
  const match = page.match(/Exit load:\s*([\s\S]*?)(?=\s+(?:Top Ten Holdings|PORTFOLIO|ASSET PROFILE|SCHEME PERFORMANCE|SIP PERFORMANCE|FUND MATRIX|Mutual Fund investments are subject|June \d{4}\s+FUND DETAILS|Expense Ratio)\b)/i);
  return match ? text(match[1]).replace(/[•]+$/g, '').trim() : null;
}

function debtQuantsFromPage(page) {
  const sectionStart = page.search(/Quantitative Indicators/i);
  const sectionEnd = page.search(/(?:Entry load:|Exit load:)/i);
  if (sectionStart < 0 || sectionEnd <= sectionStart) return null;
  const section = page.slice(sectionStart, sectionEnd);
  const values = {
    modifiedDuration: number(section.match(/Modified Duration\s+([\d.]+)\s+years/i)?.[1]),
    averageMaturity: number(section.match(/Average Maturity\s+([\d.]+)\s+years/i)?.[1]),
    macaulayDuration: number(section.match(/Macaulay Duration\s+([\d.]+)\s+years/i)?.[1]),
    ytm: number(section.match(/Yield to Maturity\^?\s+([\d.]+)%/i)?.[1]),
    standardDeviation: number(section.match(/Standard Deviation\s+([\d.]+)%/i)?.[1]),
  };
  return Object.values(values).some(Number.isFinite) ? values : null;
}

async function main() {
  console.log('Fetching SBI monthly factsheet...');
  const sourceUrl = await getLatestFactsheet();
  const pages = await extractPages(sourceUrl);
  const asOfDate = pages.map(dateFromText).find(Boolean);
  if (!asOfDate) throw new Error('SBI factsheet did not expose a recognised as-of date.');
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
    (scheme_code, as_of_date, modified_duration_years, average_maturity_years, yield_to_maturity_percent, macaulay_duration_years, standard_deviation_percent, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET
    modified_duration_years=excluded.modified_duration_years, average_maturity_years=excluded.average_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, standard_deviation_percent=excluded.standard_deviation_percent, source_url=excluded.source_url`);
  const deleteCurrentManagers = db.prepare(`DELETE FROM scheme_factsheet_managers WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  const deleteCurrentQuants = db.prepare(`DELETE FROM scheme_debt_quant_snapshots WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  const deleteCurrentSnapshots = db.prepare(`DELETE FROM scheme_factsheet_snapshots WHERE as_of_date = ? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc = ?)`);
  let matched = 0;
  let debtCount = 0;
  db.transaction(() => {
    deleteCurrentManagers.run(asOfDate, AMC);
    deleteCurrentQuants.run(asOfDate, AMC);
    deleteCurrentSnapshots.run(asOfDate, AMC);
    for (const page of pages) {
      if (!/Fund Manager\s+Total Experience\s+Managing Since/i.test(page) || !/Exit load:/i.test(page)) continue;
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
          debtUpsert.run(schemeCode, asOfDate, quants.modifiedDuration, quants.averageMaturity, quants.ytm, quants.macaulayDuration, quants.standardDeviation, sourceUrl);
          debtCount += 1;
        }
        matched += 1;
      }
    }
  })();
  console.log(`Imported SBI factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${asOfDate}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
