const { spawn } = require('node:child_process');
const path = require('node:path');
const db = require('../server/db');

const importer = path.join(__dirname, 'import-nifty-tri.js');
const today = new Date().toISOString().slice(0, 10);

function isoDaysBefore(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function runImport(benchmarkId, from) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [importer, benchmarkId, '--from', from, '--to', today], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${benchmarkId} refresher exited with code ${code}.`)));
  });
}

const benchmarks = db.prepare(`
  SELECT b.benchmark_id, b.name, MAX(n.date) AS latest_date
  FROM benchmarks b
  JOIN benchmark_nav_daily n ON n.benchmark_id = b.benchmark_id
  WHERE b.name LIKE 'NIFTY%'
  GROUP BY b.benchmark_id, b.name
  ORDER BY b.name
`).all();

(async () => {
  const failures = [];
  for (const benchmark of benchmarks) {
    const from = isoDaysBefore(benchmark.latest_date, 7);
    console.log(`\nRefreshing ${benchmark.name}: ${from} to ${today}`);
    try {
      await runImport(benchmark.benchmark_id, from);
    } catch (error) {
      failures.push({ benchmark: benchmark.name, error: error.message });
      console.error(`Continuing after ${benchmark.name}: ${error.message}`);
    }
  }
  db.close();
  if (failures.length) {
    failures.forEach(({ benchmark, error }) => console.error(`- ${benchmark}: ${error}`));
    process.exitCode = 1;
  }
})();
