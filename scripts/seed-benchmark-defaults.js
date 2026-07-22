const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');

const sourceUrl = 'https://www.amfiindia.com/circulars';
const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'amfi-tier1-benchmark-defaults.json'), 'utf8'));

const upsertBenchmark = db.prepare(`
  INSERT INTO benchmarks (benchmark_id, name, source, source_url)
  VALUES (@id, @benchmark, 'AMFI tier-1 benchmark list', @sourceUrl)
  ON CONFLICT(benchmark_id) DO UPDATE SET name = excluded.name, source = excluded.source, source_url = excluded.source_url
`);
const upsertDefault = db.prepare(`
  INSERT INTO category_benchmark_defaults (category, benchmark_id, mapping_status, source_url)
  VALUES (@category, @id, 'provisional', @sourceUrl)
  ON CONFLICT(category) DO UPDATE SET benchmark_id = excluded.benchmark_id, mapping_status = excluded.mapping_status, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP
`);

db.transaction((records) => records.forEach((record) => {
  const mapped = { ...record, sourceUrl };
  upsertBenchmark.run(mapped);
  upsertDefault.run(mapped);
}))(defaults);
console.log(`Seeded ${defaults.length} provisional category benchmark defaults.`);
