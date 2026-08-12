const db = require('../server/db');

const AMC = 'Baroda BNP Paribas Mutual Fund';
const SOURCE_PAGE = 'https://www.barodabnpparibasmf.in/downloads/monthly-factsheet';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/BARODA|BNP|PARIBAS/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const numeric = (text, label) => text.match(label)?.[1] ? Number(text.match(label)[1]) : null;

async function sourceUrl() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Baroda BNP Paribas factsheet page returned ${response.status}.`);
  const links = [...(await response.text()).matchAll(/href=["']([^"']+\.pdf[^"']*)/gi)]
    .map((match) => new URL(match[1].replace(/&amp;/g, '&'), SOURCE_PAGE).href)
    .filter((url) => /fund[_ -]?facts/i.test(url));
  if (!links.length) throw new Error('Baroda BNP Paribas did not publish a linked monthly fund-facts PDF.');
  return links[0];
}

async function extractPdf(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Baroda BNP Paribas factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function asOfDate(pages) {
  const match = pages.join(' ').match(/As on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function pageIndex(contents) {
  const matches = [...contents.matchAll(/Baroda BNP Paribas\s+(.+?)\s+(\d+)(?=\s+(?:Baroda BNP Paribas|SIP Performance|Performance of Schemes|Fund Managers|Distribution History|How to Read|Glossary|$))/gi)];
  return new Map(matches.map((match) => [Number(match[2]), clean(`Baroda BNP Paribas ${match[1]}`)]));
}

function exitLoad(text) {
  const match = text.match(/Exit Load:\s*([\s\S]*?)(?=\s+Expense Ratio\s*&\s*Quantitative Data\b)/i);
  return match ? clean(match[1]) : null;
}

function managers(text) {
  const block = text.match(/Fund Manager(?:\s+Category)?\s+Fund Manager\s+Managing fund since\s+Experience\s+([\s\S]*?)(?=\s+Load Structure\b)/i)?.[1] || '';
  return [...block.matchAll(/((?:Mr|Ms|Mrs)\.\s*[A-Z][A-Za-z. ]+?)\s+(\d{1,2}-[A-Za-z]{3}-\d{2})\s+(\d+(?:\.\d+)?)\s+years?/gi)]
    .map((match) => ({ name: clean(match[1]), since: match[2], experience: Number(match[3]) }));
}

function debtQuants(text) {
  const normalized = text.replace(/Modi\s+fi\s+ed/g, 'Modified').replace(/Macaulay Duration[^A-Za-z0-9]*/gi, 'Macaulay Duration ');
  const average = numeric(normalized, /Average Maturity\s*\(years\)\s*:\s*([\d.]+)/i);
  const modified = numeric(normalized, /Modified Duration\s*\(years\)\s*:\s*([\d.]+)/i);
  const ytm = numeric(normalized, /YTM\s*\(%\)\s*:\s*([\d.]+)/i);
  // The dagger after this label is not consistently exposed by the PDF text
  // layer, so accept both "(years)" and the flattened "years)" form.
  const macaulay = numeric(normalized, /Macaulay Duration\s*(?:\(?years\)?\s*)?:\s*([\d.]+)/i);
  return [average, modified, ytm, macaulay].every(Number.isFinite) ? { average, modified, ytm, macaulay } : null;
}

async function main() {
  console.log('Discovering the latest Baroda BNP Paribas monthly factsheet...');
  const url = await sourceUrl(); const pages = await extractPdf(url); const date = asOfDate(pages);
  if (!date) throw new Error('Baroda BNP Paribas factsheet has no recognised as-of date.');
  const indexedPages = pageIndex(pages[1]);
  if (indexedPages.size < 20) throw new Error('Baroda BNP Paribas factsheet index could not be read safely.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name); if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  const records = [];
  for (const [pageNumber, title] of indexedPages) {
    const text = pages[pageNumber - 1]; if (!text || !/NAV Details/i.test(text)) continue;
    const family = families.get(key(title)); if (!family) continue;
    records.push({ codes: family, exit: exitLoad(text), managerRows: managers(text), debt: debtQuants(text) });
  }
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 20) throw new Error(`Only ${codes.size} Baroda BNP Paribas NAV plans matched the official scheme index; aborting without changing data.`);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of records) for (const code of record.codes) {
      snapshot.run(code, date, AMC, record.exit, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, date);
      [...new Map(record.managerRows.map((row) => [row.name.toUpperCase(), row])).values()].forEach((row) => manager.run(code, date, row.name, row.since, row.experience, url));
      if (record.debt) { quant.run(code, date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      matched += 1;
    }
  })();
  console.log(`Imported Baroda BNP Paribas factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
