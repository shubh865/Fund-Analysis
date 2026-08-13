#!/usr/bin/env node

// ICICI Prudential publishes its current scheme factsheets through an official
// digital catalogue. The scheme PDFs currently contain several tables as
// images, so this connector intentionally records only the verifiable
// catalogue-level snapshot (scheme, date, and official source link). It does
// not infer exit loads, managers, or risk metrics from an image.
const db = require('../server/db');

const AMC = 'ICICI Prudential Mutual Fund';
const ROOT = 'https://digitalfactsheet.icicipruamc.com/fact/';

function clean(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).toUpperCase()
    .replace(/\bICICI\s+PRUDENTIAL\b/g, '')
    .replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT|FUND)\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateFromCatalogue(html) {
  const dates = [...html.matchAll(/Prudent\s+Fact\s+Sheet\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/gi)];
  const latest = dates.at(-1);
  if (!latest) return null;
  const date = new Date(`${latest[1]} ${latest[2]}, ${latest[3]} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function main() {
  console.log('Fetching the official ICICI Prudential digital factsheet catalogue...');
  const response = await fetch(ROOT, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`ICICI factsheet catalogue returned ${response.status}.`);
  const html = await response.text();
  const asOfDate = dateFromCatalogue(html);
  if (!asOfDate) throw new Error('ICICI catalogue did not expose a recognised factsheet date.');

  const published = [...html.matchAll(/<a\s+href=["']([^"']+\.php)["'][^>]*?(?:class=["']sub-item["'])?[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      name: clean(match[2]),
      sourceUrl: new URL(match[1], ROOT).href,
    }))
    .filter((record) => /^ICICI\s+Prudential\s+/i.test(record.name));
  const families = new Map();
  for (const scheme of db.prepare('SELECT scheme_code, name FROM schemes WHERE amc=?').all(AMC)) {
    const familyKey = key(scheme.name);
    if (familyKey.length >= 5) families.set(familyKey, [...(families.get(familyKey) || []), scheme.scheme_code]);
  }
  const imported = new Map();
  for (const record of published) {
    const codes = families.get(key(record.name)) || [];
    for (const schemeCode of codes) imported.set(schemeCode, record);
  }
  if (imported.size < 100) {
    throw new Error(`Only ${imported.size} ICICI NAV plans matched the official catalogue; aborting without changing data.`);
  }

  const upsert = db.prepare(`
    INSERT INTO scheme_factsheet_snapshots (scheme_code, as_of_date, source_amc, exit_load_text, source_url, source_file)
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(scheme_code, as_of_date) DO UPDATE SET
      source_amc=excluded.source_amc, source_url=excluded.source_url, source_file=excluded.source_file
  `);
  db.transaction(() => {
    db.prepare(`DELETE FROM scheme_factsheet_snapshots
      WHERE as_of_date=? AND scheme_code IN (SELECT scheme_code FROM schemes WHERE amc=?)`).run(asOfDate, AMC);
    for (const [schemeCode, record] of imported) {
      upsert.run(schemeCode, asOfDate, AMC, record.sourceUrl, new URL(record.sourceUrl).pathname.split('/').pop());
    }
  })();
  console.log(`Imported ${imported.size} ICICI official catalogue snapshots as of ${asOfDate}.`);
  console.log('No exit load, manager, or risk metric was inferred because the relevant tables are image-based in the current published PDFs.');
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
