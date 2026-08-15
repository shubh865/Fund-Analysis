const db = require('../server/db');
const AMC = 'Abakkus Mutual Fund';
const PAGE = 'https://www.abakkusmf.com/factsheet.html';
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const families = ['Abakkus Flexi Cap Fund', 'Abakkus Small Cap Fund', 'Abakkus Liquid Fund'];
async function main() {
  console.log('Discovering the latest Abakkus factsheet...');
  const page = await fetch(PAGE, { headers: { 'user-agent': 'Mozilla/5.0' } }); if (!page.ok) throw new Error(`Abakkus factsheet page returned ${page.status}.`);
  const html = await page.text(); const match = html.match(/href="([^"]*Abakkus_Mutual_Fund_Factsheet_[^"]*\.pdf)"/i); if (!match) throw new Error('No current Abakkus factsheet PDF found.');
  const url = new URL(match[1], PAGE).href; const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } }); if (!response.ok) throw new Error(`Abakkus PDF returned ${response.status}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise; const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) { const p = await pdf.getPage(n); pages.push(clean((await p.getTextContent()).items.map((x) => x.str).join(' '))); }
  const joined = pages.join(' '); const dateMatch = joined.match(/July\s+(\d{4})\s+Monthly Factsheet/i); if (!dateMatch) throw new Error('Abakkus factsheet has no recognised disclosure month.'); const date = `${dateMatch[1]}-07-31`;
  const schemes = db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC); const factsheetSchemes = schemes.filter((s) => !s.name.startsWith('Abakkus Large & Mid Cap Fund')); const records = families.map((family) => ({ family, codes: factsheetSchemes.filter((s) => s.name.startsWith(family)).map((s) => s.scheme_code), page: pages.find((p) => p.toUpperCase().includes(family.toUpperCase()) && /Exit Load/i.test(p)) })); const matched = records.filter((r) => r.page && r.codes.length); const count = matched.flatMap((r) => r.codes).length; if (count !== factsheetSchemes.length) throw new Error(`Only ${count}/${factsheetSchemes.length} Abakkus published NAV plans matched; aborting without changes.`);
  const insert = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`); let imported = 0;
  db.transaction(() => { db.prepare(`DELETE FROM scheme_factsheet_snapshots WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(date, AMC); for (const r of matched) { const exit = (r.page.match(/Exit Load\s*[:\-]?\s*([\s\S]{0,300}?)(?=\s+(?:Fund Manager|Benchmark|Expense|AUM|NAV))/i) || [])[1] || null; for (const code of r.codes) { insert.run(code, date, AMC, clean(exit) || null, url, new URL(url).pathname.split('/').pop()); imported += 1; } } })();
  console.log(`Imported Abakkus factsheet observations for ${imported} NAV plans as of ${date}.`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
