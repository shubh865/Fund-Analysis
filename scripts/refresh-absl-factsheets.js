const db = require('../server/db');

const AMC = 'Aditya Birla Sun Life Mutual Fund';
const SOURCE_PAGE = 'https://mutualfund.adityabirlacapital.com/forms-and-downloads/factsheets';

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) {
  return text(value).toUpperCase()
    .replace(/ADITYA BIRLA SUN LIFE/g, '')
    .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function dateFromText(value) {
  const match = text(value).match(/(?:data\s+as\s+on|as\s+on)\s+(\d{1,2})\w*\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function number(value) {
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
function pageValue(page, label, suffix) {
  const match = page.match(new RegExp(`${label}\\s+([\\s\\S]*?)${suffix}`, 'i'));
  return match ? text(match[1]) : null;
}
function exitLoadFromPage(page) {
  const match = page.match(/Exit Load:\s*([\s\S]*?)(?=\s+(?:Count of Securities|Investment Objective|Fund Category:|Fund Performance|Benchmark|Portfolio Turnover Ratio)\b)/i);
  return match ? text(match[1]) : null;
}

async function getLatestFactsheet() {
  const page = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!page.ok) throw new Error(`ABSL factsheet page returned ${page.status}.`);
  const html = await page.text();
  const paths = [...html.matchAll(/href=["']([^"']*\/factsheets\/\d{4}\/[^"']+\.pdf)["']/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&'));
  const sourceUrl = [...new Set(paths)].find((path) => /absl.*factsheet/i.test(path));
  if (!sourceUrl) throw new Error('ABSL latest monthly factsheet PDF was not found.');
  return new URL(sourceUrl, SOURCE_PAGE).href;
}

async function extractPages(sourceUrl) {
  const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0', referer: SOURCE_PAGE } });
  if (!response.ok) throw new Error(`ABSL factsheet PDF returned ${response.status}.`);
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
  return [...page.matchAll(/Fund Manager\s*-\s*(.*?)\s+Managing the Fund Since:\s*(.*?)\s+Experience in Managing the Fund:\s*([\d.]+)\s*Years?/gi)]
    .map((match) => ({ managerName: text(match[1]), managingSince: text(match[2]), experienceYears: number(match[3]) }))
    .filter((manager) => manager.managerName);
}

function debtQuantsFromPage(page) {
  if (!/Debt Quants/i.test(page)) return null;
  const section = page.slice(page.search(/Debt Quants/i));
  const metric = (label) => number(pageValue(section, label, '(?:years|%)'));
  const values = {
    modifiedDuration: metric('Modified Duration'), averageMaturity: metric('Average Maturity'),
    ytm: metric('Yield to Maturity'), macaulayDuration: metric('Macaulay Duration'),
    standardDeviation: metric('Standard Deviation'),
  };
  return Object.values(values).some(Number.isFinite) ? values : null;
}

async function main() {
  console.log('Fetching ABSL monthly factsheet...');
  const sourceUrl = await getLatestFactsheet();
  const pages = await extractPages(sourceUrl);
  const asOfDate = pages.map(dateFromText).find(Boolean);
  if (!asOfDate) throw new Error('ABSL factsheet did not expose a recognised as-of date.');
  const sourceFile = sourceUrl.split('/').pop();
  const schemeFamilies = new Map();
  for (const scheme of db.prepare(`SELECT scheme_code, name FROM schemes WHERE amc = ?`).all(AMC)) {
    const key = normalized(scheme.name);
    if (key.length < 6) continue;
    const entry = schemeFamilies.get(key) || [];
    entry.push(scheme.scheme_code);
    schemeFamilies.set(key, entry);
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
  let matched = 0;
  let debtCount = 0;
  db.transaction(() => {
    for (const page of pages) {
      if (!/Fund Snapshot/i.test(page) || !/Exit Load:/i.test(page)) continue;
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
  console.log(`Imported ABSL factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${asOfDate}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
