const db = require('../server/db');

const AMC = 'Tata Mutual Fund';
const SOURCE_PAGE = 'https://www.tatamutualfund.com/information-documents/factsheets';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/TATA/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Tata factsheet page returned ${response.status}.`);
  const html = await response.text();
  const matches = html.match(/https:[^"\\]+TataMF[^"\\]+\.pdf/gi) || [];
  if (!matches.length) throw new Error('Tata did not expose a current monthly factsheet PDF on its official factsheet page.');
  return matches.at(-1).replace(/\\u0026/g, '&');
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Tata factsheet PDF returned ${response.status}.`);
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
  const match = pages.join(' ').match(/As on\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function titleFrom(page, families) {
  const candidates = [...page.slice(0, 1800).matchAll(/\b(Tata\s+.{1,115}?)\s+\(?An\s+open/gi)]
    .map((match) => clean(match[1]))
    .filter((title) => !/(?:Ltd\.|website|Mutual Fund investments)/i.test(title));
  return candidates.find((title) => families.has(key(title))) || null;
}

function managers(text) {
  const section = text.match(/FUND MANAGER\s+([\s\S]*?)(?=\s+BENCHMARK\b)/i)?.[1] || '';
  return [...section.matchAll(/([A-Z][A-Za-z. ]+?)\s*\(Managing Since\s+(\d{1,2}-[A-Za-z]{3}-\d{2})\s+and overall experience of\s+(\d+(?:\.\d+)?)\s+years\)/gi)]
    .map((match) => ({ name: clean(match[1]).replace(/^ASSISTANT FUND MANAGER\s+/i, ''), since: match[2], experience: Number(match[3]) }));
}

function exitLoad(text) {
  const match = text.match(/Exit Load:\s*([\s\S]*?)(?=\s+Please refer to our Tata Mutual Fund website|\s+\d+(?:\.\d+)?%\s+(?:Ncd|Certificate|Government|Commercial))/i);
  return match ? clean(match[1]) : null;
}

function debtQuants(text) {
  const macaulay = text.match(/Portfolio Macaulay Duration\s*:\s*([\d.]+)\s+Years/i)?.[1];
  const modified = text.match(/Modified Duration\s*:\s*([\d.]+)\s+Years/i)?.[1];
  const average = text.match(/Average Maturity\s*:\s*([\d.]+)\s+Years/i)?.[1];
  const ytm = text.match(/Annualized Yield to Maturity[\s\S]{0,180}?([\d.]+)%/i)?.[1];
  return [macaulay, modified, average, ytm].every((value) => value !== undefined)
    ? { macaulay: Number(macaulay), modified: Number(modified), average: Number(average), ytm: Number(ytm) }
    : null;
}

async function main() {
  console.log('Discovering the latest Tata monthly factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url); const date = asOfDate(pages);
  if (!date) throw new Error('Tata factsheet has no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name); if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = [];
  for (const page of pages) {
    const title = titleFrom(page, families); if (!title || !/FUND MANAGER\b/i.test(page)) continue;
    records.push({ codes: families.get(key(title)), exit: exitLoad(page), managerRows: managers(page), debt: debtQuants(page) });
  }
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 150) throw new Error(`Only ${codes.size} Tata NAV plans matched explicit official scheme pages; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const clearManagers = db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const manager = db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  let matched = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    const imported = new Set();
    for (const record of records) for (const code of record.codes) {
      if (imported.has(code)) continue;
      snapshot.run(code, date, AMC, record.exit, url, new URL(url).pathname.split('/').pop());
      clearManagers.run(code, date);
      [...new Map(record.managerRows.map((row) => [row.name.toUpperCase(), row])).values()].forEach((row) => manager.run(code, date, row.name, row.since, row.experience, url));
      if (record.debt) { quant.run(code, date, record.debt.modified, record.debt.average, record.debt.average, record.debt.ytm, record.debt.macaulay, url); debtCount += 1; }
      imported.add(code); matched += 1;
    }
  })();
  console.log(`Imported Tata factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
