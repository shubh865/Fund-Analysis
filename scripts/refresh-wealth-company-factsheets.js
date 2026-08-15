const db = require('../server/db');

const AMC = 'The Wealth Company Mutual Fund';
const PAGE_URL = 'https://www.wealthcompanyamc.in/literature-forms/scheme-documents/factsheets/';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function latestFactsheet() {
  const response = await fetch(PAGE_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Wealth Company factsheet page returned ${response.status}.`);
  const html = await response.text();
  const matches = [...html.matchAll(/Factsheet as on (\d{2}-\d{2}-\d{4})[\s\S]{0,1000}?\/uploads\/([^\\"]+?\.pdf)/gi)];
  if (!matches.length) throw new Error('Wealth Company did not expose an official factsheet download.');
  const latest = matches[0];
  const parsed = latest[1].match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!parsed) throw new Error('Wealth Company factsheet has no recognised disclosure date.');
  return {
    date: `${parsed[3]}-${parsed[2]}-${parsed[1]}`,
    url: new URL(`/uploads/${latest[2].replace(/\\u0026/g, '&')}`, PAGE_URL).href,
  };
}

async function readPages(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Wealth Company factsheet PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    pages.push(clean((await page.getTextContent()).items.map((item) => item.str).join(' ')));
  }
  return pages;
}

function details(page) {
  const exit = page.match(/Exit Load\s*:\s*([\s\S]{1,500}?)(?=\s+Face Value|\s+NAV \()/i);
  const managers = [...page.matchAll(/((?:Mr|Ms)\.?\s+[A-Za-z ]+?)(?:\s*\([^)]*\))?\s*,?\s*(\d{1,2})\s+Years? of [Ee]xperience,?\s*Managing since\s+([A-Za-z]+\s+\d{4})/gi)]
    .map((match) => ({ name: clean(match[1]), experience: Number(match[2]), since: clean(match[3]) }));
  return { exit: exit ? clean(exit[1]) : null, managers };
}

async function main() {
  console.log('Discovering the latest Wealth Company factsheet...');
  const { date, url } = await latestFactsheet();
  const pages = await readPages(url);
  const families = [
    ['THE WEALTH COMPANY FLEXI CAP FUND', 'The Wealth Company Flexi Cap Fund'],
    ['THE WEALTH COMPANY ETHICAL FUND', 'The Wealth Company Ethical Fund'],
    ['THE WEALTH COMPANY SMALL CAP FUND', 'The Wealth Company Small Cap Fund'],
    ['THE WEALTH COMPANY LARGE AND MID CAP FUND', 'The Wealth Company Large & Mid Cap Fund'],
    ['THE WEALTH COMPANY ARBITRAGE FUND', /THE WEALTH COMPANY ARB?ITRAGE FUND/i],
    ['THE WEALTH COMPANY MULTI ASSET ALLOCATION FUND', /THE WEALTH COMPANY MULTI ASSET ALLOCATION FUND/i],
    ['THE WEALTH COMPANY BALANCED ADVANTAGE FUND', /THE WEALTH COMPANY BALANCED ADVANTAGE FUND/i],
    ['THE WEALTH COMPANY LIQUID FUND', 'THE WEALTH COMPANY LIQUID FUND'],
    ['THE WEALTH COMPANY GOLD ETF FOF', 'THE WEALTH COMPANY GOLD ETF FOF'],
    ['THE WEALTH COMPANY GOLD ETF', /^The Wealth Company Gold ETF$/i],
  ];
  const schemes = db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC);
  const records = families.map(([pageLabel, family]) => ({
    page: pages.find((item) => item.toUpperCase().includes(pageLabel) && /Fund Features|Investment Objective/i.test(item)),
    codes: schemes.filter((scheme) => typeof family === 'string'
      ? scheme.name.toUpperCase().startsWith(family.toUpperCase())
      : family.test(scheme.name)).map((scheme) => scheme.scheme_code),
  }));
  const matched = records.filter((record) => record.page && record.codes.length);
  const count = matched.flatMap((record) => record.codes).length;
  if (count !== 41) throw new Error(`Only ${count}/41 published Wealth Company factsheet plans matched (${records.map((record, index) => `${index + 1}:${record.page ? 'page' : 'no-page'}/${record.codes.length}`).join(', ')}); aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const manager = db.prepare(`INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date,manager_name) DO UPDATE SET managing_since=excluded.managing_since,experience_years=excluded.experience_years,source_url=excluded.source_url`);
  let imported = 0;
  db.transaction(() => {
    for (const table of ['scheme_factsheet_managers', 'scheme_factsheet_snapshots']) db.prepare(`DELETE FROM ${table} WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC);
    for (const record of matched) {
      const values = details(record.page);
      for (const schemeCode of record.codes) {
        snapshot.run(schemeCode, date, AMC, values.exit, url, new URL(url).pathname.split('/').pop());
        for (const item of values.managers) manager.run(schemeCode, date, item.name, item.since, item.experience, url);
        imported += 1;
      }
    }
  })();
  console.log(`Imported Wealth Company factsheet observations for ${imported} published NAV plans as of ${date}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
