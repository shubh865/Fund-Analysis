const { spawnSync } = require('node:child_process');
const path = require('node:path');
const db = require('../server/db');

const date = db.prepare('SELECT MAX(date) AS date FROM nav_daily').get().date;
if (!date) throw new Error('No NAV date is available. Import daily NAV before refreshing NSE market data.');

for (const script of ['import-nse-equity-prices.js', 'import-nse-index-closes.js']) {
  console.log(`Refreshing ${script} for ${date}…`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), date], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`NSE market data refreshed for ${date}.`);
