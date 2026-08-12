const db = require('../server/db');

const AMC = 'UTI Mutual Fund';
const FACTSHEET_API = 'https://www.utimf.com/api/get-fact-sheet';
const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalized = (value) => text(value).toUpperCase()
  .replace(/UTI(?:\s+MUTUAL\s+FUND)?/g, '')
  .replace(/\b(?:DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const numeric = (value) => { const match = text(value).match(/-?\d+(?:\.\d+)?/); return match ? Number(match[0]) : null; };
const years = (value, unit) => (/days?/i.test(unit || '') ? numeric(value) / 365.2425 : numeric(value));
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function latestFiles() {
  const current = new Date();
  for (let offset = 0; offset < 5; offset += 1) {
    const date = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - offset, 1));
    const year = date.getUTCFullYear(); const month = monthNames[date.getUTCMonth()];
    const response = await fetch(`${FACTSHEET_API}?year=${year}&month=${month}`);
    if (!response.ok) continue;
    const rows = (await response.json()).rows || [];
    const files = rows.filter((row) => /UTI Fund Watch/i.test(row.name || '') && row.url);
    if (files.length) return { files, year, month };
  }
  throw new Error('UTI did not publish a usable Active or Passive factsheet in the latest five months.');
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`UTI factsheet returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    pages.push((await page.getTextContent()).items.map((item) => item.str).join(' '));
  }
  return pages;
}

function asOfDate(pages) {
  const match = pages.join(' ').match(/(?:as on|as at)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function managerRows(segment) {
  return [...segment.matchAll(/((?:Mr|Ms|Mrs)\.\s+[A-Z][A-Za-z. ]+?)(?:\s*[-,][^]*?)?\s+Managing the scheme since\s+([A-Za-z]+\s+\d{4})\.?\s+Total Exp:\s*(\d+(?:\.\d+)?)\s*Yrs?/gi)]
    .map((match) => ({ managerName: text(match[1]), managingSince: text(match[2]), experienceYears: Number(match[3]) }))
    .filter((manager) => manager.managerName && Number.isFinite(manager.experienceYears));
}

function exitLoad(segment) {
  const match = segment.match(/Exit Load\s*:\s*([\s\S]*?)(?=\s+(?:Category|Investment Objective|Date of inception|Benchmark Index|Fund Manager|Plans\/Option|Fund AUM|Active Stock positions|Fund Performance|SIP Returns|High\/Low NAV|Month-end Total Expense|Minimum Investment|NAV per unit|Market Capitalisation|Portfolio Details|Quantitative Indicators|Portfolio Parameters|Past Performance)\b|$)/i);
  return match ? text(match[1]) : null;
}

function debtQuants(segment) {
  const average = segment.match(/(?:Weighted )?Average Maturity\s+([\d.]+)\s*(days|years|yrs)/i);
  const modified = segment.match(/Modified Duration\s+([\d.]+)\s*(days|years|yrs)/i);
  const macaulay = segment.match(/Macaulay Duration\s+([\d.]+)\s*(days|years|yrs)/i);
  const ytm = segment.match(/Yield to Maturity\*?\s+([\d.]+)%/i);
  if (!average || !modified || !macaulay || !ytm) return null;
  return { average: years(average[1], average[2]), modified: years(modified[1], modified[2]), macaulay: years(macaulay[1], macaulay[2]), ytm: Number(ytm[1]) };
}

async function main() {
  const { files, month, year } = await latestFiles();
  console.log(`Fetching UTI ${month} ${year} Active/Passive factsheets...`);
  const documents = await Promise.all(files.map(async (file) => ({ file, pages: await pagesFrom(file.url) })));
  const date = documents.map((document) => asOfDate(document.pages)).find(Boolean);
  if (!date) throw new Error('UTI factsheets had no recognised as-of date.');

  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc = ?').all(AMC)) {
    const key = normalized(scheme.name);
    const aliases = [key, key.replace(/\bERSTWHILE\b.*$/, '').trim()];
    aliases.filter((alias) => alias.length >= 6).forEach((alias) => families.set(alias, [...(families.get(alias) || []), scheme.scheme_code]));
  }
  const candidates = [...families.entries()].sort((left, right) => right[0].length - left[0].length);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text, source_url=excluded.source_url, source_file=excluded.source_file`);
  const deleteManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const addManager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code, as_of_date, manager_name, managing_since, experience_years, source_url) VALUES (?, ?, ?, ?, ?, ?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code, as_of_date, modified_duration_years, average_maturity_years, yield_to_maturity_percent, macaulay_duration_years, source_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years, average_maturity_years=excluded.average_maturity_years, yield_to_maturity_percent=excluded.yield_to_maturity_percent, macaulay_duration_years=excluded.macaulay_duration_years, source_url=excluded.source_url`);
  const clear = (table) => db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);

  let imported = 0; let debtImported = 0;
  db.transaction(() => {
    clear('scheme_factsheet_managers'); clear('scheme_debt_quant_snapshots'); clear('scheme_factsheet_snapshots');
    const seen = new Set();
    for (const document of documents) {
      const sourceFile = new URL(document.file.url).pathname.split('/').pop();
      for (const segment of document.pages) {
        if (!/Managing the scheme since|Portfolio Parameters|Exit Load/i.test(segment)) continue;
        const family = candidates.find(([key]) => segment.includes(`UTI ${key}`));
        if (!family) continue;
        const managers = managerRows(segment); const load = exitLoad(segment); const debt = debtQuants(segment);
        for (const schemeCode of family[1]) {
          if (seen.has(schemeCode)) continue;
          snapshot.run(schemeCode, date, AMC, load, document.file.url, sourceFile); deleteManagers.run(schemeCode, date);
          const uniqueManagers = [...new Map(managers.map((manager) => [manager.managerName.toUpperCase(), manager])).values()];
          uniqueManagers.forEach((manager) => addManager.run(schemeCode, date, manager.managerName, manager.managingSince, manager.experienceYears, document.file.url));
          if (debt) { quant.run(schemeCode, date, debt.modified, debt.average, debt.ytm, debt.macaulay, document.file.url); debtImported += 1; }
          seen.add(schemeCode); imported += 1;
        }
      }
    }
  })();
  console.log(`Imported UTI factsheet observations for ${imported} NAV plans (${debtImported} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
