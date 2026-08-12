const db = require('../server/db');

const AMC = 'Motilal Oswal Mutual Fund';
const SITEMAP_URL = 'https://www.motilaloswalmf.com/sitemap.xml';
const clean = (value) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:#x3C|#60);/gi, '<').replace(/&amp;/gi, '&').replace(/&#x3C;/gi, '<').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toUpperCase()
  .replace(/MOTILAL\s+OSWAL/g, '')
  .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, '')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

async function pageUrls() {
  const response = await fetch(SITEMAP_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Motilal sitemap returned ${response.status}.`);
  return [...(await response.text()).matchAll(/<loc>(https:\/\/www\.motilaloswalmf\.com\/mutual-funds\/[^<]+)<\/loc>/gi)].map((match) => match[1]);
}

function field(html, name) {
  const pattern = new RegExp(`<strong>${name}:<\\/strong>\\s*(?:<\\/p>)?\\s*<p>([\\s\\S]*?)<\\/p>`, 'i');
  const fallback = new RegExp(`<strong>${name}:<\\/strong>\\s*([^<]+)`, 'i');
  return clean(html.match(pattern)?.[1] || html.match(fallback)?.[1]);
}

function asOfDate(value) {
  const match = clean(value).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;
  const date = new Date(`${match[2]} ${match[1]}, ${match[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function load(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  const html = await response.text();
  return { url, title: field(html, 'schemeName'), asOfDate: asOfDate(field(html, 'dateAsOn')), exitLoad: field(html, 'exitLoad') };
}

async function main() {
  console.log('Discovering Motilal Oswal scheme pages from its official sitemap...');
  const urls = await pageUrls(); const records = [];
  for (let index = 0; index < urls.length; index += 5) {
    const batch = await Promise.all(urls.slice(index, index + 5).map(async (url) => {
      try { return await load(url); } catch (error) { console.warn(`Skipping ${url}: ${error.message}`); return null; }
    }));
    records.push(...batch.filter((record) => record?.title && record.asOfDate));
  }
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const matched = records.map((record) => ({ ...record, codes: families.get(key(record.title)) || [] })).filter((record) => record.codes.length);
  const codes = new Set(matched.flatMap((record) => record.codes));
  if (codes.size < 100) throw new Error(`Only ${codes.size} Motilal NAV plans matched official scheme pages; aborting without changing data.`);
  const snapshot = db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const imported = new Set();
  db.transaction(() => {
    const dates = [...new Set(matched.map((record) => record.asOfDate))];
    // The public page exposes an AMC-wide roster, not scheme-specific manager assignments.
    // Remove only the earlier experimental rows from this source; do not infer manager links.
    db.prepare("DELETE FROM scheme_factsheet_managers WHERE source_url LIKE 'https://www.motilaloswalmf.com/mutual-funds/%'").run();
    for (const date of dates) db.prepare('DELETE FROM scheme_factsheet_snapshots WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)').run(date, AMC);
    for (const record of matched) for (const code of record.codes) {
      if (imported.has(`${code}:${record.asOfDate}`)) continue;
      snapshot.run(code, record.asOfDate, AMC, record.exitLoad || null, record.url, new URL(record.url).pathname.split('/').pop());
      imported.add(`${code}:${record.asOfDate}`);
    }
  })();
  console.log(`Imported Motilal official exit-load details for ${imported.size} NAV plans across ${[...new Set(matched.map((record) => record.asOfDate))].join(', ')}.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
