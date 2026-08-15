const db = require('../server/db');

const AMC = 'Quantum Mutual Fund';
const SOURCE_PAGE = 'https://www.quantumamc.com/factsheets/combined/-1/0/0';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/\bTERM\b/g, 'DYNAMIC')
  .replace(/\b(?:QUANTUM|DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|ANNUAL|MONTHLY|WEEKLY|DAILY|QUARTERLY|FUND|CUM|INCOME|DISTRIBUTION|CAPITAL|WITHDRAWAL)\b/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(SOURCE_PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Quantum factsheet page returned ${response.status}.`);
  const html = await response.text();
  const match = html.match(/href="(https:\/\/www\.quantumamc\.com\/FileCDN\/FactSheet\/[^"?]+\.pdf)"[^>]*>[\s\S]{0,250}?July\s+2026\s*-\s*All\s+Funds/i)
    || html.match(/href="(https:\/\/www\.quantumamc\.com\/FileCDN\/FactSheet\/[^"?]+\.pdf)"/i);
  if (!match) throw new Error('Quantum did not expose a current combined factsheet PDF.');
  return match[1];
}

async function pagesFrom(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Quantum factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function asOfDate(pages) {
  const match = pages.join(' ').match(/(?:Portfolio|Performance) as on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function matchingCodes(page, families) {
  const candidates = [...page.matchAll(/\b(Quantum\s+[A-Za-z0-9 &-]+?(?:Fund|ETF))\b/gi)].map((match) => match[1]);
  const title = candidates.find((candidate) => families.has(key(candidate)));
  return title ? families.get(key(title)) : [];
}

function officialRisk(page) {
  // Quantum labels these three values together and specifies the methodology
  // in the same published factsheet. Parse only the unambiguous ordering.
  const threeYear = page.match(/Quantitative Indicators as on[^]{0,800}?([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s+(?:[\d.]+\s+)?\^\^Standard Deviation\s+\^\^Sharpe Ratio\s+\^\^Beta/i);
  const tracking = page.match(/Tracking Error:\s*([\d.]+)%/i);
  if (!threeYear && !tracking) return null;
  return {
    standardDeviation: threeYear ? Number(threeYear[1]) : null,
    sharpe: threeYear ? Number(threeYear[2]) : null,
    beta: threeYear ? Number(threeYear[3]) : null,
    trackingError: tracking ? Number(tracking[1]) : null,
    window: tracking && !threeYear ? '1Y daily' : '3Y monthly',
  };
}

async function main() {
  console.log('Discovering the latest Quantum combined factsheet...');
  const url = await latestFactsheet(); const pages = await pagesFrom(url); const date = asOfDate(pages);
  if (!date) throw new Error('Quantum factsheet has no recognised as-of date.');
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 4) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const records = pages.map((page) => ({ codes: matchingCodes(page, families), risk: officialRisk(page) })).filter((record) => record.codes.length);
  // A scheme can be mentioned on introductory or disclosure pages before its
  // own factsheet page. Process the page carrying official risk values first.
  records.sort((left, right) => Number(Boolean(right.risk)) - Number(Boolean(left.risk)));
  const expectedCodes = new Set(records.flatMap((record) => record.codes));
  if (expectedCodes.size < 20) throw new Error(`Only ${expectedCodes.size} Quantum NAV plans matched the official factsheet; aborting without changing data.`);

  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET source_url=excluded.source_url,source_file=excluded.source_file`);
  const risk = db.prepare(`INSERT INTO scheme_factsheet_risk_snapshots (scheme_code,as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,metric_window) DO UPDATE SET sharpe_ratio=excluded.sharpe_ratio,beta=excluded.beta,tracking_error_percent=excluded.tracking_error_percent,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let riskCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_risk_snapshots', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    const seen = new Set();
    for (const record of records) for (const code of record.codes) {
      if (seen.has(code)) continue;
      snapshot.run(code, date, AMC, null, url, new URL(url).pathname.split('/').pop());
      if (record.risk) { risk.run(code, date, record.risk.window, record.risk.sharpe, record.risk.beta, record.risk.trackingError, null, null, record.risk.standardDeviation, null, url); riskCount += 1; }
      seen.add(code); imported += 1;
    }
  })();
  console.log(`Imported Quantum factsheet observations for ${imported} NAV plans (${riskCount} official risk snapshots) as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
