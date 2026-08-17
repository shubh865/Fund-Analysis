const db = require('../server/db');

const AMC = 'PGIM India Mutual Fund';
const ARCHIVE_URL = 'https://www.pgimindia.com/api/v1/brochure/published/form';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// These are the scheme-specific pages in PGIM's consolidated official
// factsheet. Keeping the source-page relationship explicit prevents a chart,
// index or summary page from ever being mistaken for a fund disclosure.
const PAGE_SCHEMES = [
  [10, 'PGIM India Large Cap Fund'], [11, 'PGIM India Flexi Cap Fund'],
  [12, 'PGIM India Large and Midcap Fund'], [13, 'PGIM India Multi Cap Fund'],
  [14, 'PGIM India Midcap Fund'], [15, 'PGIM India Small Cap Fund'],
  [16, 'PGIM India ELSS Tax Saver Fund'], [17, 'PGIM India Healthcare Fund'],
  [18, 'PGIM India Retirement Fund'], [19, 'PGIM India Emerging Markets Equity Fund of Fund'],
  [20, 'PGIM India Global Equity Opportunities Fund of Fund'], [21, 'PGIM India Global Select Real Estate Securities Fund of Fund'],
  [22, 'PGIM India Aggressive Hybrid Equity Fund'],
  [23, 'PGIM India Arbitrage Fund'], [24, 'PGIM India Equity Savings Fund'],
  [25, 'PGIM India Balanced Advantage Fund'], [26, 'PGIM India Multi Asset Allocation Fund'],
  [29, 'PGIM India Overnight Fund'], [30, 'PGIM India Liquid Fund'],
  [31, 'PGIM India Ultra Short Duration Fund'], [32, 'PGIM India Money Market Fund'],
  [33, 'PGIM India Dynamic Bond Fund'], [34, 'PGIM India Corporate Bond Fund'],
  [35, 'PGIM India Gilt Fund'], [36, 'PGIM India CRISIL IBX Gilt Index - Apr 2028 Fund'],
];

function familyKey(value) {
  return clean(value).toUpperCase()
    .replace(/\b(?:DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|BONUS|WEALTH|PREMIUM|PLUS|MAIN|PORTFOLIO|SEGREGATED)\b/g, ' ')
    .replace(/[-–—,()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsedDate(value) {
  const match = String(value || '').match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const date = new Date(`${match[1]} 1, ${match[2]} UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

async function latestFactsheet() {
  const response = await fetch(ARCHIVE_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`PGIM archive returned ${response.status}.`);
  const payload = await response.json();
  const forms = payload?.data?.tab_0007;
  if (!Array.isArray(forms)) throw new Error('PGIM did not expose its factsheet archive in the expected official tab.');
  const candidates = forms
    .filter((item) => item?.displayStatus && /^Factsheet\s*-\s*[A-Za-z]+\s+\d{4}$/i.test(item?.formName || '') && /^https:\/\/www\.pgimindia\.com\/api\/v1\/brochure\/about-us\/image\//.test(item?.pdfPath || ''))
    .map((item) => ({ ...item, asOf: parsedDate(item.monthYear) }))
    .filter((item) => item.asOf);
  candidates.sort((left, right) => right.asOf.localeCompare(left.asOf));
  if (!candidates[0]) throw new Error('PGIM did not expose a usable current official factsheet PDF.');
  return candidates[0];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`PGIM factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function durationInYears(text, label) {
  const match = text.match(new RegExp(`${label}:\\s*([\\d.]+)\\s*(yrs?|years?|months?)`, 'i'));
  if (!match) return null;
  const value = Number(match[1]);
  return /month/i.test(match[2]) ? value / 12 : value;
}

function managers(text) {
  const section = text.match(/Fund Manager:\s*([\s\S]*?)(?=\s+Benchmark:)/i)?.[1] || '';
  const rows = [];
  const pattern = /\(w\.e\.f\.\s*([^)]+)\)\s*(?:Mr\.?|Ms\.?)\s+([A-Z][A-Za-z. ]+?)(?:\s*\([^)]*\))?\s*\(Over\s+([\d.]+)\s+years?[^)]*\)/gi;
  for (const match of section.matchAll(pattern)) rows.push({ name: clean(match[2]), since: clean(match[1]), experience: Number(match[3]) });
  return [...new Map(rows.map((row) => [row.name.toUpperCase(), row])).values()];
}

function risk(text) {
  const section = text.match(/Volatility Measures\s*\(\s*3\s*Years\s*\):\s*([\s\S]*?)(?=\s+NAV\s+Regular Plan|\s+Load Structure:)/i)?.[1] || '';
  const number = (label) => {
    const match = section.match(new RegExp(`${label}\\*{0,3}\\s*:\\s*([\\d.]+)%?`, 'i'));
    return match ? Number(match[1]) : null;
  };
  const standardDeviation = number('Standard Deviation of Fund \\(Annual\\)');
  const beta = number('Beta');
  const sharpe = number('Sharpe Ratio');
  return [standardDeviation, beta, sharpe].every((value) => value === null) ? null : { standardDeviation, beta, sharpe };
}

function debtQuants(text) {
  const average = durationInYears(text, 'Average Maturity');
  const modified = durationInYears(text, 'Modified Duration');
  const macaulay = durationInYears(text, 'Macaulay Duration');
  // PGIM labels the other yield measure "Portfolio Yield", not YTM. Do not
  // relabel it as Yield to Maturity when the source does not do so.
  return [average, modified, macaulay].every((value) => value === null)
    ? null : { average, modified, macaulay };
}

function exitLoad(text) {
  const match = text.match(/Load Structure:\s*Entry Load:\s*NA\.\s*Exit Load:\s*([\s\S]*?)(?=\s+(?:##\s*For rating methodology|Details as on|This product is suitable|Performance \(CAGR\)|Portfolio|Potential Risk Class))/i);
  return match ? clean(match[1]) : null;
}

function benchmark(text) {
  return clean(text.match(/Benchmark:\s*([\s\S]*?)(?=\s+Option:)/i)?.[1]) || null;
}

async function main() {
  console.log('Discovering the latest PGIM official factsheet...');
  const source = await latestFactsheet();
  const pages = await pagesFrom(source.pdfPath);
  if (pages.length < 35) throw new Error(`PGIM factsheet only has ${pages.length} pages; expected its full scheme disclosure document.`);

  const latestNavDate = db.prepare('SELECT MAX(date) AS value FROM nav_daily').get().value;
  const activeCutoff = new Date(`${latestNavDate}T00:00:00Z`);
  activeCutoff.setUTCDate(activeCutoff.getUTCDate() - 31);
  const cutoff = activeCutoff.toISOString().slice(0, 10);
  const activeSchemes = db.prepare(`SELECT s.scheme_code, s.name
    FROM schemes s JOIN nav_daily n ON n.scheme_code=s.scheme_code
    WHERE s.amc=? GROUP BY s.scheme_code HAVING MAX(n.date)>=?`).all(AMC, cutoff);
  const families = new Map();
  for (const scheme of activeSchemes) {
    const key = familyKey(scheme.name);
    families.set(key, [...(families.get(key) || []), scheme.scheme_code]);
  }

  const records = PAGE_SCHEMES.map(([pageNumber, family]) => {
    const text = pages[pageNumber - 1];
    if (!/Fund Details\s+Investment Objective:/.test(text) || !/Fund Manager:/.test(text) || !/Benchmark:/.test(text)) {
      throw new Error(`PGIM page ${pageNumber} did not contain a complete scheme disclosure for ${family}.`);
    }
    const codes = families.get(familyKey(family)) || [];
    return { family, pageNumber, text, codes, exit: exitLoad(text), managers: managers(text), risk: risk(text), debt: debtQuants(text), benchmark: benchmark(text) };
  });
  const matchedCodes = new Set(records.flatMap((record) => record.codes));
  if (matchedCodes.size < 90) throw new Error(`Only ${matchedCodes.size} active PGIM NAV plans matched the official factsheet; aborting without changing data.`);
  if (records.some((record) => !record.codes.length)) throw new Error('At least one PGIM source page could not be matched to an active scheme family.');

  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const riskInsert = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,benchmark_name=excluded.benchmark_name,source_url=excluded.source_url`);
  const debtInsert = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);

  let imported = 0; let riskCount = 0; let debtCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_risk_snapshots', 'scheme_debt_quant_snapshots', 'scheme_factsheet_snapshots']) {
      db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(source.asOf, AMC);
    }
    for (const record of records) for (const code of record.codes) {
      snapshot.run(code, source.asOf, AMC, record.exit, source.pdfPath, source.formName);
      for (const person of record.managers) manager.run(code, source.asOf, person.name, person.since, person.experience, source.pdfPath);
      if (record.risk) {
        riskInsert.run(code, source.asOf, '3Y', record.risk.sharpe, record.risk.beta, null, null, null, record.risk.standardDeviation, record.benchmark, source.pdfPath);
        riskCount += 1;
      }
      if (record.debt) {
        debtInsert.run(code, source.asOf, record.debt.modified, record.debt.average, null, null, record.debt.macaulay, record.risk?.standardDeviation ?? null, source.pdfPath);
        debtCount += 1;
      }
      imported += 1;
    }
  })();
  console.log(`Imported PGIM factsheet observations for ${imported} active NAV plans (${riskCount} official risk snapshots; ${debtCount} debt-quant snapshots) as of ${source.asOf}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
