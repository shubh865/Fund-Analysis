const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');

const refreshers = Object.entries(packageJson.scripts)
  .filter(([name, command]) => /^refresh:.*-holdings$/.test(name)
    && name !== 'refresh:all-holdings'
    && /^node scripts\/[^ ]+\.js$/.test(command))
  .sort(([left], [right]) => left.localeCompare(right));

const failures = [];
for (let index = 0; index < refreshers.length; index += 1) {
  const [name, command] = refreshers[index];
  const scriptPath = command.replace(/^node\s+/, '');
  console.log(`\n[${index + 1}/${refreshers.length}] ${name}`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', scriptPath)], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failures.push({ name, exitCode: result.status });
    console.error(`${name} failed with exit code ${result.status}; continuing with the remaining AMCs.`);
  }
}

const db = require('../server/db');
const commandFailureCount = failures.length;
const suspectSnapshots = db.prepare(`
  SELECT hp.portfolio_id, hp.amc, ph.as_of_date
  FROM holding_portfolios hp
  JOIN portfolio_holdings ph ON ph.portfolio_id = hp.portfolio_id
  WHERE ph.as_of_date = (
    SELECT MAX(ph2.as_of_date)
    FROM portfolio_holdings ph2
    JOIN holding_portfolios hp2 ON hp2.portfolio_id = ph2.portfolio_id
    WHERE hp2.amc = hp.amc
  )
  GROUP BY hp.portfolio_id, hp.amc, ph.as_of_date
  HAVING SUM(CASE WHEN ABS(COALESCE(ph.weight, 0)) > 1.5 THEN 1 ELSE 0 END) > 0
    OR SUM(ABS(COALESCE(ph.weight, 0))) > 3
`).all();
if (suspectSnapshots.length) {
  const deleteSnapshot = db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id = ? AND as_of_date = ?');
  db.transaction(() => {
    suspectSnapshots.forEach((snapshot) => deleteSnapshot.run(snapshot.portfolio_id, snapshot.as_of_date));
  })();
  console.warn(`Quarantined ${suspectSnapshots.length} malformed portfolio snapshots instead of exposing unreliable weights.`);
}
const validation = db.prepare(`
  WITH latest AS (
    SELECT hp.amc, MAX(ph.as_of_date) AS as_of_date
    FROM holding_portfolios hp
    JOIN portfolio_holdings ph ON ph.portfolio_id = hp.portfolio_id
    GROUP BY hp.amc
  ),
  portfolio_totals AS (
    SELECT hp.amc, ph.as_of_date, hp.portfolio_id,
           SUM(ABS(COALESCE(ph.weight, 0))) AS gross_weight,
           SUM(CASE WHEN ABS(COALESCE(ph.weight, 0)) > 1.5 THEN 1 ELSE 0 END) AS extreme_weights
    FROM holding_portfolios hp
    JOIN portfolio_holdings ph ON ph.portfolio_id = hp.portfolio_id
    GROUP BY hp.amc, ph.as_of_date, hp.portfolio_id
  )
  SELECT latest.amc, latest.as_of_date,
         SUM(portfolio_totals.extreme_weights) AS extreme_weights,
         SUM(CASE WHEN portfolio_totals.gross_weight > 3 THEN 1 ELSE 0 END) AS suspect_portfolios
  FROM latest
  JOIN portfolio_totals ON portfolio_totals.amc = latest.amc
    AND portfolio_totals.as_of_date = latest.as_of_date
  GROUP BY latest.amc, latest.as_of_date
  HAVING extreme_weights > 0 OR suspect_portfolios > 0
`).all();
for (const issue of validation) {
  failures.push({
    name: `validation:${issue.amc}`,
    exitCode: `${issue.extreme_weights} extreme weights, ${issue.suspect_portfolios} suspect portfolios`,
  });
}

console.log(`\nPortfolio refresh finished: ${refreshers.length - commandFailureCount}/${refreshers.length} refreshers succeeded.`);
if (failures.length) {
  console.error(`Failures: ${failures.map((failure) => `${failure.name} (${failure.exitCode})`).join(', ')}`);
  process.exitCode = 1;
}
