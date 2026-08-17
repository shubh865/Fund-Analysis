const db = require('../server/db');

const AMC = '360 ONE Mutual Fund';
const DOWNLOADS_URL = 'https://www.360.one/asset/mutual-funds/downloads/';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// These page-to-scheme links are intentional. 360 ONE publishes a combined
// factsheet, so we refuse to infer a scheme from a page that has no heading.
const PAGE_SCHEMES = [
  [7, '360 ONE Focused Fund'], [8, '360 ONE Flexicap Fund'], [9, '360 ONE Quant Fund'],
  [10, '360 ONE ELSS Tax Saver Nifty 50 Index Fund'], [11, '360 ONE Balanced Hybrid Fund'],
  [13, '360 ONE Multi Asset Allocation Fund'], [15, '360 ONE Dynamic Bond Fund'],
  [16, '360 ONE Liquid Fund'], [17, '360 ONE Overnight Fund'], [18, '360 ONE Gold ETF'],
  [19, '360 ONE Silver ETF'], [20, '360 ONE MSCI India ETF'],
];

function familyKey(value) {
  return clean(value).toUpperCase()
    .replace(/\b(?:DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|DAILY|WEEKLY|MONTHLY|QUARTERLY|HALF|YEARLY|BONUS|INCOME|DISTRIBUTION|CUM|CAPITAL|WITHDRAWAL|SEPARATED)\b/g, ' ')
    .replace(/HYRBRID/g, 'HYBRID').replace(/[-–—,()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateAtMonthEnd(month, year) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
}

async function latestFactsheet() {
  const response = await fetch(DOWNLOADS_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`360 ONE downloads page returned ${response.status}.`);
  // The public page serializes the page data as an escaped JSON string.
  const html = (await response.text()).split(String.fromCharCode(92, 34)).join('"');
  const start = html.indexOf('"factSheets":');
  if (start < 0) throw new Error('360 ONE did not expose its factsheet archive on the official downloads page.');
  const end = html.indexOf('"year":"2025"', start);
  const currentYear = html.slice(start, end > start ? end : undefined);
  const matches = [...currentYear.matchAll(/"month":"(\d{2})"[\s\S]{0,1200}?"title":"Factsheet - Fund","documents":\[\{"fileName":"([^"]+)","fileUrl":"([^"]+\.pdf)"/g)];
  const latest = matches.at(-1);
  if (!latest) throw new Error('360 ONE did not expose a current fund factsheet PDF.');
  return { month: latest[1], name: latest[2], url: latest[3] };
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`360 ONE factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function numberAfter(text, label) {
  const match = text.match(new RegExp(`${label}\\s*:?\\s*([\\d.]+)%?`, 'i'));
  return match ? Number(match[1]) : null;
}

function risk(text) {
  // The PDF's visual columns extract before the "Volatility Measures" label,
  // so parse the explicitly labelled rows rather than their visual section.
  const standardDeviation = numberAfter(text, 'Std\\.?\\s*Dev\\.?\\s*\\(?Annualised\\)?');
  const sharpe = numberAfter(text, 'Sharpe Ratio');
  const beta = numberAfter(text, 'Portfolio Beta');
  return [standardDeviation, sharpe, beta].every((value) => value === null) ? null : { standardDeviation, sharpe, beta };
}

function debtQuants(text) {
  const ytm = numberAfter(text, 'Annualised Portfolio YTM');
  const average = numberAfter(text, 'Average Maturity');
  const modified = numberAfter(text, 'Modified Duration');
  const macaulay = numberAfter(text, 'Macaulay Duration');
  const residual = numberAfter(text, 'Residual Maturity');
  return [ytm, average, modified, macaulay, residual].every((value) => value === null)
    ? null : { ytm, average, modified, macaulay, residual };
}

function exitLoad(text) {
  const match = text.match(/Exit Load\s*:\s*([\s\S]*?)(?=\s+Dematerialization\s*:|\s+Asset Allocation\s*:|\s+Fund Details)/i);
  return match ? clean(match[1]) : null;
}

function benchmark(text) {
  return clean(text.match(/Benchmark Index\s*:\s*([\s\S]*?)(?=\s+Plans Offered\s*:)/i)?.[1]) || null;
}

function managers(text) {
  // The visual manager box extracts after its label, while manager biographies
  // occur before it. Read names from the box and experience from the biography.
  const details = text.match(/Fund Details\s+([\s\S]{0,400}?)(?=\s+Portfolio as on)/i)?.[1] || '';
  const inline = text.match(/Fund Manager\s+((?:Mr|Ms)\.\s+[A-Z][A-Za-z.' ]{2,80}?)(?=\s+(?:Scheme Performance|NAV as on|Regular Plan|Investment Objective))/i)?.[1] || '';
  const names = [...`${details} ${inline}`.matchAll(/\b(?:Mr|Ms)\.\s+([A-Z][a-z]+(?:\s+(?!(?:Mr|Ms)\.?\b)[A-Z][a-z]+){1,3})/g)].map((match) => clean(match[1]));
  return [...new Set(names)].map((name) => {
    const experience = Number(text.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]{0,100}?(?:over|more than|has)\\s+(\\d+(?:\\.\\d+)?)\\s+years`, 'i'))?.[1]) || null;
    const since = clean(text.match(new RegExp(`Managed by the fund manager Since\\s+([^.;]+)`, 'i'))?.[1]) || null;
    return { name, experience, since };
  });
}

async function main() {
  console.log('Discovering the latest 360 ONE official factsheet...');
  const source = await latestFactsheet();
  const pages = await pagesFrom(source.url);
  if (pages.length < 20) throw new Error(`360 ONE factsheet only has ${pages.length} pages; expected its combined fund disclosure.`);
  const asOfMatch = pages.find((page) => /NAV as on [A-Za-z]+ \d{1,2}, \d{4}/i.test(page))?.match(/NAV as on ([A-Za-z]+ \d{1,2}, \d{4})/i);
  const asOf = asOfMatch ? new Date(`${asOfMatch[1]} UTC`).toISOString().slice(0, 10) : dateAtMonthEnd(source.month, '2026');

  const latestNavDate = db.prepare('SELECT MAX(date) AS value FROM nav_daily').get().value;
  const cutoffDate = new Date(`${latestNavDate}T00:00:00Z`); cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 31);
  const active = db.prepare(`SELECT s.scheme_code,s.name FROM schemes s JOIN nav_daily n ON n.scheme_code=s.scheme_code
    WHERE s.amc=? GROUP BY s.scheme_code HAVING MAX(n.date)>=?`).all(AMC, cutoffDate.toISOString().slice(0, 10));
  const families = new Map();
  for (const scheme of active) {
    const key = familyKey(scheme.name);
    families.set(key, [...(families.get(key) || []), scheme.scheme_code]);
  }
  const records = PAGE_SCHEMES.map(([pageNumber, family]) => {
    const text = pages[pageNumber - 1];
    if (!text || !new RegExp(family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) throw new Error(`360 ONE page ${pageNumber} no longer maps to ${family}; aborting.`);
    return { codes: families.get(familyKey(family)) || [], text, exit: exitLoad(text), risk: risk(text), debt: debtQuants(text), managers: managers(text), benchmark: benchmark(text) };
  });
  const matched = new Set(records.flatMap((record) => record.codes));
  if (matched.size < 40 || records.some((record) => !record.codes.length)) throw new Error(`Only ${matched.size} active 360 ONE plans mapped to official pages; aborting without changes.`);

  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?)
    ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)
    ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const riskInsert = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,benchmark_name=excluded.benchmark_name,source_url=excluded.source_url`);
  const debtInsert = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_risk_snapshots', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(asOf, AMC);
    for (const record of records) for (const code of record.codes) {
      snapshot.run(code, asOf, AMC, record.exit, source.url, source.name);
      for (const person of record.managers) manager.run(code, asOf, person.name, person.since, person.experience, source.url);
      if (record.risk) { riskInsert.run(code, asOf, '3Y', record.risk.sharpe, record.risk.beta, null, null, null, record.risk.standardDeviation, record.benchmark, source.url); riskCount += 1; }
      if (record.debt) { debtInsert.run(code, asOf, record.debt.modified, record.debt.average, record.debt.residual, record.debt.ytm, record.debt.macaulay, record.risk?.standardDeviation ?? null, source.url); debtCount += 1; }
      imported += 1;
    }
  })();
  console.log(`Imported 360 ONE factsheet observations for ${imported} active NAV plans (${riskCount} official risk snapshots; ${debtCount} debt-quant snapshots) as of ${asOf}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
