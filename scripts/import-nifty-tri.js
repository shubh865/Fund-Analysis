const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');

const HISTORY_PAGE = 'https://niftyindices.com/reports/historical-data';
const ENDPOINT = 'https://niftyindices.com/BackPage/getTotalReturnIndexString';
const DAY_MS = 24 * 60 * 60 * 1000;

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.log('Usage: node scripts/import-nifty-tri.js <benchmark-id> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
  process.exit(message ? 1 : 0);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function parseIso(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) usage(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) usage(`${label} is not a valid date.`);
  return date;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function displayDate(date) {
  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', year: '2-digit',
  }).replace(/ /g, '-');
}

function parseNiftyDate(value) {
  const parsed = new Date(`${value} UTC`);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Could not parse Nifty date: ${value}`);
  return iso(parsed);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const benchmarkId = process.argv[2];
if (!benchmarkId || benchmarkId.startsWith('--')) usage('A benchmark id is required.');
const benchmark = db.prepare('SELECT benchmark_id, name FROM benchmarks WHERE benchmark_id = ?').get(benchmarkId);
if (!benchmark) usage(`Unknown benchmark id: ${benchmarkId}. Run npm run seed:benchmark-defaults first.`);

const from = parseIso(argument('--from') || '2013-01-01', '--from');
const to = parseIso(argument('--to') || iso(new Date()), '--to');
if (from > to) usage('--from cannot be after --to.');

const outputDirectory = path.join(__dirname, '..', 'raw', 'benchmarks', 'nifty', benchmarkId);
fs.mkdirSync(outputDirectory, { recursive: true });

const upsert = db.prepare(`
  INSERT INTO benchmark_nav_daily (benchmark_id, date, value, source_url)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(benchmark_id, date) DO UPDATE SET
    value = excluded.value,
    source_url = excluded.source_url
`);
const saveRows = db.transaction((rows) => {
  for (const row of rows) upsert.run(benchmarkId, row.date, row.value, HISTORY_PAGE);
});

async function fetchWindow(start, end) {
  const cinfo = `{\'name\':\'${benchmark.name.toUpperCase()}\',\'startDate\':\'${displayDate(start)}\',\'endDate\':\'${displayDate(end)}\',\'indexName\':\'${benchmark.name}\'}`;
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      referer: HISTORY_PAGE,
      'user-agent': 'MutualFundAnalytics/0.1 (self-hosted research use)',
    },
    body: JSON.stringify({ cinfo }),
  });
  if (!response.ok) throw new Error(`Nifty returned HTTP ${response.status} for ${iso(start)} to ${iso(end)}.`);
  const raw = await response.text();
  const rawPath = path.join(outputDirectory, `${iso(start)}_${iso(end)}.json`);
  fs.writeFileSync(rawPath, raw);
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error(`Unexpected Nifty response for ${iso(start)} to ${iso(end)}.`);
  return records.map((record) => ({
    date: parseNiftyDate(record.Date),
    value: Number(record.TotalReturnsIndex),
  })).filter((record) => Number.isFinite(record.value) && record.value > 0);
}

(async () => {
  let cursor = new Date(from);
  let windows = 0;
  let imported = 0;
  while (cursor <= to) {
    const end = new Date(Math.min(cursor.valueOf() + 365 * DAY_MS, to.valueOf()));
    process.stdout.write(`Downloading ${benchmark.name}: ${iso(cursor)} to ${iso(end)}... `);
    const rows = await fetchWindow(cursor, end);
    saveRows(rows);
    imported += rows.length;
    windows += 1;
    console.log(`${rows.length} values`);
    cursor = new Date(end.valueOf() + DAY_MS);
    if (cursor <= to) await sleep(600);
  }
  const total = db.prepare('SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM benchmark_nav_daily WHERE benchmark_id = ?').get(benchmarkId);
  if (imported === 0 && total.count === 0) {
    throw new Error(`Nifty returned no Total Return Index values for ${benchmark.name}. This benchmark needs a different approved source or mapping.`);
  }
  console.log(`Imported ${imported} source values across ${windows} request windows. Stored ${total.count} ${benchmark.name} TRI values (${total.first_date} to ${total.last_date}).`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
