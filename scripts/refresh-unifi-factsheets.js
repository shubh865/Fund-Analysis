const db = require('../server/db');

const AMC = 'Unifi Mutual Fund';
const SOURCES = [
  ['Unifi Dynamic Asset Allocation Fund', 'https://unifimf.com/wp-content/uploads/fund-sheets/Unifi-DAAF-Factsheet-July-2026.pdf'],
  ['Unifi Liquid Fund', 'https://unifimf.com/our-funds/liquid-fund/'],
  ['Unifi Flexi Cap Fund', 'https://unifimf.com/our-funds/flexi-cap-fund/'],
];
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function currentPdf(source) {
  if (source.endsWith('.pdf')) return source;
  const response = await fetch(source, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Unifi scheme page returned ${response.status}: ${source}`);
  const html = await response.text();
  const candidates = [...html.matchAll(/https?:[^"']+Factsheet[^"']+\.pdf[^"']*/gi)]
    .map((match) => match[0].replace(/&amp;/g, '&'));
  if (!candidates.length) throw new Error(`No current factsheet PDF was exposed by ${source}`);
  return candidates[0];
}

async function readPdf(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Unifi factsheet PDF returned ${response.status}: ${url}`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages.join(' ');
}

function monthEnd(text) {
  const match = text.match(/Factsheet\s*[-–]?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
    || text.match(/Factsheet\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!match) return null;
  const date = new Date(`${match[1]} 1, ${match[2]} UTC`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function between(text, start, end) {
  const match = text.match(new RegExp(`${start}([\\s\\S]{0,700}?)(?=${end})`, 'i'));
  return match ? clean(match[1]) : null;
}

function numberBefore(text, label) {
  const match = text.match(new RegExp(`${label}[^\\d]{0,80}([\\d.]+)\\s*(?:%|years?)`, 'i'));
  return match ? Number(match[1]) : null;
}

function debtQuant(text) {
  return {
    ytm: numberBefore(text, 'Yield to Maturity of the debt portfolio'),
    modifiedDuration: numberBefore(text, 'Modified Duration of debt portfolio'),
    macaulayDuration: numberBefore(text, 'Macaulay duration of debt portfolio'),
    averageMaturity: numberBefore(text, 'Weighted avg maturity of the debt portfolio'),
  };
}

function exitLoad(text) {
  return between(text, 'Exit Load \\(In case of units are redeemed/switched out\\)', 'Base Expense Ratio')
    || between(text, 'Exit Load', 'Base Expense Ratio');
}

function managerNames(text) {
  const area = between(text, 'Fund Manager', 'Tier I Benchmark Index') || '';
  return [...area.matchAll(/(?:^|\s)([A-Z][A-Za-z. ]{2,}(?:Saravanan|Lakhani|Srinivas)[A-Za-z. ]*)/g)]
    .map((match) => clean(match[1].replace(/[–-].*$/, '')))
    .filter((name, index, values) => name && values.indexOf(name) === index);
}

async function main() {
  console.log('Discovering the latest Unifi factsheets...');
  const docs = [];
  for (const [family, source] of SOURCES) {
    const url = await currentPdf(source);
    const text = await readPdf(url);
    const asOfDate = monthEnd(text);
    if (!asOfDate) throw new Error(`Unifi factsheet has no recognised disclosure month: ${url}`);
    docs.push({ family, url, text, asOfDate });
  }
  const schemes = db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC);
  const matched = docs.map((doc) => ({ ...doc, codes: schemes.filter((scheme) => scheme.name.startsWith(doc.family)).map((scheme) => scheme.scheme_code) }));
  const codeCount = matched.flatMap((doc) => doc.codes).length;
  if (codeCount !== schemes.length || codeCount < 6) throw new Error(`Only ${codeCount}/${schemes.length} Unifi NAV plans matched; aborting without changing data.`);
  const latestDate = matched.map((doc) => doc.asOfDate).sort().at(-1);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET source_url=excluded.source_url`);
  const quant = db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent,source_url)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,residual_maturity_years=excluded.residual_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,standard_deviation_percent=excluded.standard_deviation_percent,source_url=excluded.source_url`);
  let imported = 0; let quantCount = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_snapshots', 'scheme_debt_quant_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(latestDate, AMC);
    for (const doc of matched) for (const schemeCode of doc.codes) {
      snapshot.run(schemeCode, doc.asOfDate, AMC, exitLoad(doc.text), doc.url, new URL(doc.url).pathname.split('/').pop());
      for (const name of managerNames(doc.text)) manager.run(schemeCode, doc.asOfDate, name, null, null, doc.url);
      const values = debtQuant(doc.text);
      if (Object.values(values).some((value) => value !== null)) {
        quant.run(schemeCode, doc.asOfDate, values.modifiedDuration, values.averageMaturity, null, values.ytm, values.macaulayDuration, null, doc.url);
        quantCount += 1;
      }
      imported += 1;
    }
  })();
  console.log(`Imported Unifi factsheet observations for ${imported} NAV plans (${quantCount} debt-quant snapshots) as of ${latestDate}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
