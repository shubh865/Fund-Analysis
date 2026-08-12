const db = require('../server/db');

const SCALE_FACTORS = [10, 100];
const TOLERANCE = 0.015;

function nearScale(value) {
  return SCALE_FACTORS.find((factor) => Math.abs((value / factor) - 1) <= TOLERANCE) || null;
}

function main({ apply = process.argv.includes('--apply') } = {}) {
  // A scale conversion is a source-presentation change, not a return. Require
  // the same near-exact conversion across at least two schemes of one AMC on
  // one date. This intentionally leaves one-off market losses, recoveries and
  // IDCW effects untouched.
  const rows = db.prepare(`
    WITH ordered_nav AS (
      SELECT s.scheme_code, s.amc, n.date, n.nav,
        LAG(n.nav) OVER (PARTITION BY s.scheme_code ORDER BY n.date) AS prior_nav
      FROM schemes s
      JOIN nav_daily n ON n.scheme_code = s.scheme_code
      WHERE s.category LIKE 'Debt Scheme%'
    )
    SELECT scheme_code, amc, date, nav / prior_nav AS ratio
    FROM ordered_nav
    WHERE prior_nav > 0
      AND (nav / prior_nav BETWEEN 9.85 AND 10.15 OR nav / prior_nav BETWEEN 98.5 AND 101.5)
  `).all();

  const candidates = new Map();
  for (const row of rows) {
    const factor = nearScale(row.ratio);
    if (!factor) continue;
    const key = `${row.amc}\u0000${row.date}\u0000${factor}`;
    const group = candidates.get(key) || { amc: row.amc, date: row.date, factor, codes: [] };
    group.codes.push(row.scheme_code);
    candidates.set(key, group);
  }
  const repairs = [...candidates.values()]
    .filter((group) => group.codes.length >= 2)
    .sort((left, right) => left.date.localeCompare(right.date) || left.amc.localeCompare(right.amc));

  if (!repairs.length) {
    console.log('No repeated debt NAV scale conversions require normalisation.');
    return;
  }
  console.log(`${apply ? 'Applying' : 'Detected'} ${repairs.length} repeated debt NAV scale conversion groups:`);
  for (const repair of repairs) console.log(`${repair.date} | ${repair.amc} | ${repair.factor}x | ${repair.codes.length} schemes`);
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to normalise the pre-conversion NAV observations.');
    return;
  }

  const update = db.prepare('UPDATE nav_daily SET nav = nav * ? WHERE scheme_code = ? AND date < ?');
  let changed = 0;
  db.transaction(() => {
    for (const repair of repairs) {
      for (const schemeCode of repair.codes) changed += update.run(repair.factor, schemeCode, repair.date).changes;
    }
  })();
  console.log(`Normalised ${changed.toLocaleString()} historical debt NAV observations across ${repairs.length} source scale-conversion groups.`);
}

module.exports = main;

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
