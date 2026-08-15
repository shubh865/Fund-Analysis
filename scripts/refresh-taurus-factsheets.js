const db = require('../server/db');

const AMC = 'Taurus Mutual Fund';
const FACTSHEET_PAGE = 'https://www.taurusmutualfund.com/factsheet?field_factsheet_item_target_id=565';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const families = [
  'Taurus ELSS Tax Saver Fund', 'Taurus Flexi Cap Fund', 'Taurus Large Cap Fund', 'Taurus Mid Cap Fund',
  'Taurus Banking & Financial Services Fund', 'Taurus Ethical Fund', 'Taurus Infrastructure Fund',
  'Taurus Nifty 50 Index Fund', 'Taurus Liquid Fund',
];

async function latestFactsheet() {
  const response = await fetch(FACTSHEET_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Taurus factsheet archive returned ${response.status}.`);
  const html = await response.text();
  const matches = [...html.matchAll(/href="([^"]*Taurus_Times_[^"]*\.pdf)"/gi)].map((match) => new URL(match[1], FACTSHEET_PAGE).href);
  if (!matches.length) throw new Error('Taurus did not expose a current factsheet PDF.');
  return matches[0];
}

async function readPages(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Taurus factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function monthEnd(text) {
  const match = text.match(/Monthly Factsheet\s*[-–]?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} 1, ${match[2]} UTC`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function numberAfter(text, label) {
  const match = text.match(new RegExp(`${label}\\s*:\\s*([\\d.-]+)\\s*%?`, 'i'));
  return match ? Number(match[1]) : null;
}

function details(page) {
  const exit = page.match(/Exit Load\s*[-–:]?\s*([\s\S]{1,450}?)(?=\s+Minimum Application Amount|\s+Net Asset Value)/i);
  const manager = page.match(/(Mr\.?\s+[A-Za-z ]+?)\s*\(w\.e\.f[^)]*\)\s*Total work experience:\s*(\d+)\s*yrs/i);
  const sharpe = numberAfter(page, 'Sharpe Ra(?:t|\u0000)o');
  const deviation = numberAfter(page, 'Standard Devia(?:t|\u0000)on');
  const beta = numberAfter(page, 'Beta');
  return {
    exit: exit ? clean(exit[1]) : null,
    manager: manager ? { name: clean(manager[1]), experience: Number(manager[2]) } : null,
    risk: [sharpe, deviation, beta].some((value) => value !== null) ? { sharpe, deviation, beta } : null,
  };
}

async function main() {
  console.log('Discovering the latest Taurus factsheet...');
  const url = await latestFactsheet();
  const pages = await readPages(url);
  const date = monthEnd(pages.join(' '));
  if (!date) throw new Error('Taurus factsheet has no recognised disclosure month.');
  const schemes = db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC);
  // The current Taurus monthly factsheet does not publish the legacy Taurus Liquid Fund.
  // Keep it uncovered rather than attaching another scheme's values to it.
  const factsheetSchemes = schemes.filter((scheme) => !scheme.name.startsWith('Taurus Liquid Fund'));
  const records = families.map((family) => {
    const page = pages.find((item) => item.toUpperCase().includes(family.toUpperCase()) && /Quan.{0,30}Data|SCHEME FEATURES/i.test(item));
    return { family, page, codes: factsheetSchemes.filter((scheme) => scheme.name.startsWith(family)).map((scheme) => scheme.scheme_code) };
  });
  const matched = records.filter((record) => record.page && record.codes.length);
  const count = matched.flatMap((record) => record.codes).length;
  if (count !== factsheetSchemes.length) throw new Error(`Only ${count}/${factsheetSchemes.length} Taurus current factsheet plans matched; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET experience_years=excluded.experience_years,source_url=excluded.source_url`);
  const risk = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_risk_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of matched) {
      const values = details(record.page);
      for (const schemeCode of record.codes) {
        snapshot.run(schemeCode, date, AMC, values.exit, url, new URL(url).pathname.split('/').pop());
        if (values.manager) manager.run(schemeCode, date, values.manager.name, null, values.manager.experience, url);
        if (values.risk) { risk.run(schemeCode, date, 'AMC methodology', values.risk.sharpe, values.risk.beta, null, null, null, values.risk.deviation, null, url); riskCount += 1; }
        imported += 1;
      }
    }
  })();
  console.log(`Imported Taurus factsheet observations for ${imported} NAV plans (${riskCount} official risk snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
