const db = require('../server/db');

const AMC = 'Samco Mutual Fund';
const DOWNLOADS = 'https://www.samcomf.com/downloads';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\b(?:SAMCO|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(DOWNLOADS, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Samco downloads page returned ${response.status}.`);
  const html = await response.text();
  const choices = [...html.matchAll(/href="([^"]*Factsheet[^"?]*\.pdf[^"]*)"/gi)].map((match) => match[1]);
  const absolute = choices.map((item) => new URL(item, DOWNLOADS).href);
  if (!absolute.length) throw new Error('Samco did not expose a monthly factsheet PDF.');
  return absolute[0];
}

async function readPages(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Samco factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function asOfDate(text) {
  const match = text.match(/(?:Computed for the\s+3-yr\s+period ended|Portfolio as on|as on)\s+([A-Za-z]+)\s+(\d{1,2})(?:\s*(?:st|nd|rd|th))?,?\s*(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function documentMonthEnd(text) {
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (!match) return null;
  const date = new Date(`${match[1]} 1, ${match[2]} UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function family(text) {
  const match = text.match(/\b(Samco\s+[A-Za-z& -]+?\s+Fund)\s*\(/i);
  return match ? match[1] : null;
}

function exitLoad(text) {
  const match = text.match(/Exit Load\s*:\s*([\s\S]{1,500}?)(?=\s+Total\s+Expense Ratio|\s+Fund Manager|\s+Benchmark|\s+NAV as on)/i);
  return match ? clean(match[1]) : null;
}

function managers(text) {
  const output = [];
  const pattern = /((?:Mr\.?|Ms\.?|Mrs\.?)\s+[A-Za-z][A-Za-z .'-]+?)\s*,?\s*(?:[^.]{0,100}?)?\(Managing this scheme since\s+([^)]*)\)\s*(?:Total Experience\s*:\s*(?:Over\s*)?([\d.]+)\s*years?)?/gi;
  for (const match of text.matchAll(pattern)) output.push({ name: clean(match[1]), since: clean(match[2]), experience: match[3] ? Number(match[3]) : null });
  return output;
}

function numberAfter(text, label) {
  const match = text.match(new RegExp(`${label}[\\s:^]*([\\d.]+)%?`, 'i'));
  return match ? Number(match[1]) : null;
}

function risk(text) {
  const standardDeviation = numberAfter(text, 'Standard Deviation');
  const beta = numberAfter(text, 'Beta');
  const sharpe = numberAfter(text, 'Sharpe Ratio');
  if ([standardDeviation, beta, sharpe].every((value) => value === null)) return null;
  return { standardDeviation, beta, sharpe, window: /Computed for the\s+3-yr/i.test(text) ? '3Y monthly' : 'AMC methodology' };
}

async function main() {
  console.log('Discovering the latest Samco factsheet...');
  const url = await latestFactsheet();
  const pages = await readPages(url);
  const documentDate = documentMonthEnd(pages[0]);
  if (!documentDate) throw new Error('Samco factsheet has no recognised disclosure month.');
  const schemes = db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC);
  const byFamily = new Map();
  for (const scheme of schemes) {
    const schemeKey = key(scheme.name);
    if (!byFamily.has(schemeKey)) byFamily.set(schemeKey, []);
    byFamily.get(schemeKey).push(scheme.scheme_code);
  }
  const results = pages.map((page) => {
    const title = family(page); const date = asOfDate(page);
    return title ? { title, date: date || documentDate, page, codes: byFamily.get(key(title)) || [] } : null;
  }).filter((record) => record?.codes.length);
  const expected = new Set(results.flatMap((record) => record.codes));
  if (expected.size < 25) throw new Error(`Only ${expected.size} Samco NAV plans matched its official factsheet; aborting without changing data.`);
  const latestDate = [...new Set(results.map((record) => record.date))].sort().at(-1);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const riskInsert = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_risk_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(latestDate, AMC);
    for (const record of results) for (const code of record.codes) {
      const recordRisk = risk(record.page);
      snapshot.run(code, record.date, AMC, exitLoad(record.page), url, new URL(url).pathname.split('/').pop());
      for (const person of managers(record.page)) manager.run(code, record.date, person.name, person.since, person.experience, url);
      if (recordRisk) { riskInsert.run(code, record.date, recordRisk.window, recordRisk.sharpe, recordRisk.beta, null, null, null, recordRisk.standardDeviation, null, url); riskCount += 1; }
      imported += 1;
    }
  })();
  console.log(`Imported Samco factsheet observations for ${imported} NAV plans (${riskCount} official risk snapshots) as of ${latestDate}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
