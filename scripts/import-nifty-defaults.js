const { spawn } = require('node:child_process');
const path = require('node:path');
const db = require('../server/db');

const importer = path.join(__dirname, 'import-nifty-tri.js');
const onlyArgument = process.argv.find((argument) => argument.startsWith('--only='));
const only = onlyArgument ? new Set(onlyArgument.slice('--only='.length).split(',').filter(Boolean)) : null;
const benchmarks = db.prepare(`
  SELECT DISTINCT b.benchmark_id, b.name
  FROM category_benchmark_defaults d
  JOIN benchmarks b ON b.benchmark_id = d.benchmark_id
  WHERE b.name LIKE 'NIFTY%'
  ORDER BY b.name
`).all();
const countStored = db.prepare('SELECT COUNT(*) AS count FROM benchmark_nav_daily WHERE benchmark_id = ?');

function runImport(benchmarkId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [importer, benchmarkId], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${benchmarkId} importer exited with code ${code}.`)));
  });
}

(async () => {
  const selected = only ? benchmarks.filter((benchmark) => only.has(benchmark.benchmark_id)) : benchmarks;
  if (only && selected.length !== only.size) {
    const found = new Set(selected.map((benchmark) => benchmark.benchmark_id));
    throw new Error(`Unknown or non-Nifty benchmark id(s): ${[...only].filter((id) => !found.has(id)).join(', ')}`);
  }
  const pending = selected.filter((benchmark) => countStored.get(benchmark.benchmark_id).count === 0);
  console.log(`${benchmarks.length} mapped Nifty benchmarks found; ${pending.length} need an initial historical import.`);
  const failures = [];
  for (let index = 0; index < pending.length; index += 1) {
    const benchmark = pending[index];
    console.log(`\n[${index + 1}/${pending.length}] ${benchmark.name}`);
    try {
      await runImport(benchmark.benchmark_id);
    } catch (error) {
      failures.push({ benchmark, error: error.message });
      console.error(`Continuing after ${benchmark.name}: ${error.message}`);
    }
  }
  if (failures.length) {
    console.error(`\nCompleted with ${failures.length} benchmark(s) requiring review:`);
    failures.forEach(({ benchmark, error }) => console.error(`- ${benchmark.name}: ${error}`));
    process.exitCode = 1;
  } else {
    console.log(`\nCompleted ${pending.length} benchmark imports successfully.`);
  }
})();
