#!/usr/bin/env node

const db = require('../server/db');

const apply = process.argv.includes('--apply');
const includeStale = process.argv.includes('--include-stale');
const staleDays = 90;
const latestNavDate = db.prepare('SELECT MAX(date) AS date FROM nav_daily').get().date;
const unwantedNameCondition = `(
  LOWER(name) LIKE '%discontinued%'
  OR LOWER(name) LIKE '%defunct%'
  OR LOWER(name) LIKE '%segregated%'
  OR LOWER(name) LIKE '%unclaimed redemption%'
  OR LOWER(name) LIKE '%investor education%'
)`;

const candidates = db.prepare(`
  SELECT scheme_code, name, amc, category
  FROM schemes
  WHERE ${unwantedNameCondition}
    ${includeStale ? `OR (
      EXISTS (SELECT 1 FROM nav_daily n WHERE n.scheme_code = schemes.scheme_code)
      AND NOT EXISTS (
        SELECT 1 FROM nav_daily n
        WHERE n.scheme_code = schemes.scheme_code
          AND n.date >= date(?, '-${staleDays} days')
      )
    )` : ''}
  ORDER BY amc COLLATE NOCASE, name COLLATE NOCASE
`).all(...(includeStale ? [latestNavDate] : []));

const codes = candidates.map((scheme) => scheme.scheme_code);
db.exec('DROP TABLE IF EXISTS temp.cleanup_scheme_candidates; CREATE TEMP TABLE cleanup_scheme_candidates (scheme_code TEXT PRIMARY KEY)');
const addCandidate = db.prepare('INSERT INTO cleanup_scheme_candidates (scheme_code) VALUES (?)');
db.transaction((items) => items.forEach((code) => addCandidate.run(code)))(codes);
const countRows = (table) => {
  if (!codes.length) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE scheme_code IN (SELECT scheme_code FROM cleanup_scheme_candidates)`).get().count;
};

const affected = {
  schemes: candidates.length,
  nav_daily: countRows('nav_daily'),
  scheme_portfolio_mappings: countRows('scheme_portfolio_mappings'),
  scheme_aaum_mappings: countRows('scheme_aaum_mappings'),
  scheme_total_aum_mappings: countRows('scheme_total_aum_mappings'),
  scheme_ter_mappings: countRows('scheme_ter_mappings'),
};

console.log(`${apply ? 'Applying' : 'Dry run for'} discontinued/non-investment${includeStale ? ` and NAV-stale (> ${staleDays} days as of ${latestNavDate})` : ''} scheme cleanup:`);
console.table(affected);

if (!apply || !codes.length) {
  if (!apply) console.log('No data changed. Re-run with --apply after reviewing the counts.');
  process.exit(0);
}

const remove = db.transaction(() => {
  for (const table of [
    'scheme_portfolio_mappings',
    'scheme_aaum_mappings',
    'scheme_total_aum_mappings',
    'scheme_ter_mappings',
    'nav_daily',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE scheme_code IN (SELECT scheme_code FROM cleanup_scheme_candidates)`).run();
  }
  db.prepare('DELETE FROM schemes WHERE scheme_code IN (SELECT scheme_code FROM cleanup_scheme_candidates)').run();
});

remove();
console.log(`Removed ${codes.length.toLocaleString('en-IN')} verified scheme identities. Raw AMFI source tables were retained.`);
