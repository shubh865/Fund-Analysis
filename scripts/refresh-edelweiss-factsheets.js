const db = require('../server/db');

const AMC = 'Edelweiss Mutual Fund';
const SOURCE_PAGE = 'https://www.edelweissmf.com/downloads/factsheets';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/EDELWEISS/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const valueBefore = (text, label) => {
  const match = text.match(new RegExp(`([\\d.]+)(?:%|\\s+Years?)\\s+${label}`, 'i'));
  return match ? Number(match[1]) : null;
};

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Edelweiss factsheet page returned ${response.status}.`);
  const links = [...(await response.text()).matchAll(/href=["']([^"']+\.pdf[^"']*)/gi)]
    .map((match) => new URL(match[1].replace(/&amp;/g, '&'), SOURCE_PAGE).href)
    .filter((url) => /factsheet/i.test(url));
  if (!links.length) throw new Error('Edelweiss did not publish a linked monthly factsheet PDF.');
  return links[0];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Edelweiss factsheet PDF returned ${response.status}.`);
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
  const match = pages.join(' ').match(/Data as on\s+(?:[A-Za-z]+\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function titleFrom(page) {
  const match = page.match(/\b(Edelweiss\s+.+?)\s+An open(?:-ended| ended)/i);
  const title = clean(match?.[1]);
  // The factsheet places some disclaimer text before a repeated title on
  // performance pages. Those are deliberately rejected rather than guessed.
  return title && title.length <= 100 && !/Notes:|Mutual Fund investments/i.test(title) ? title : null;
}

function exitLoad(text) {
  const match = text.match(/Exit Load\s+([\s\S]*?)(?=\s+(?:Notes:|About the Scheme|Quantitative Indicators|Market Capitalization))/i);
  return match ? clean(match[1]) : null;
}

function managers(text) {
  const block = text.match(/Fund Manager\s+Fund Managers\s+Experience\s+Managing Since\s+([\s\S]*?)(?=\s+Minimum Investment Amount\b)/i)?.[1] || '';
  return [...block.matchAll(/((?:Mr|Ms|Mrs)\.\s*[A-Z][A-Za-z. ]+?)\s+(\d+(?:\.\d+)?)\s+years?\s+(\d{1,2}-[A-Za-z]{3}-\d{2})/gi)]
    .map((match) => ({ name: clean(match[1]), experience: Number(match[2]), since: match[3] }));
}

function debtQuants(text) {
  const ytm = valueBefore(text, 'Yield to maturity\\s*\\(YTM\\)');
  const modified = valueBefore(text, 'Modified Duration');
  const average = valueBefore(text, 'Average Maturity');
  const macaulay = valueBefore(text, 'Macaulay Duration');
  return [ytm, modified, average, macaulay].every(Number.isFinite) ? { ytm, modified, average, macaulay } : null;
}

async function main() {
  console.log('Discovering the latest Edelweiss monthly factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url); const date = asOfDate(pages);
  if (!date) throw new Error('Edelweiss factsheet has no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name); if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = [];
  for (const page of pages) {
    const title = titleFrom(page); if (!title || !/Fund Manager\s+Fund Managers\s+Experience\s+Managing Since/i.test(page)) continue;
    const codes = families.get(key(title)); if (!codes) continue;
    records.push({ codes, exit: exitLoad(page), managerRows: managers(page), debt: debtQuants(page) });
  }
  const codes = new Set(records.flatMap((record) => record.codes));
  if (codes.size < 100) throw new Error(`Only ${codes.size} Edelweiss NAV plans matched explicit official scheme titles; aborting without changing data.`);
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
  console.log(`Imported Edelweiss factsheet observations for ${matched} NAV plans (${debtCount} debt-plan quant snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
