import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const workspace = process.cwd();
const outputPath = path.join(
  workspace,
  'outputs',
  '2026-07-22-aditya-birla-nav-tri',
  'source-data.json'
);
const db = new Database(path.join(workspace, 'data', 'mutual-funds.db'), { readonly: true });

const scheme = db.prepare(`
  SELECT s.scheme_code, s.name, s.amc, s.category, b.name AS benchmark_name, b.source_url AS benchmark_source_url
  FROM schemes s
  LEFT JOIN category_benchmark_defaults d ON d.category = s.category
  LEFT JOIN benchmarks b ON b.benchmark_id = d.benchmark_id
  WHERE s.scheme_code = '120564'
`).get();
if (!scheme) throw new Error('Expected Aditya Birla Sun Life Flexi Cap scheme was not found.');

const rows = db.prepare(`
  SELECT n.date, n.nav, b.value AS benchmark_tri, b.date AS benchmark_date
  FROM nav_daily n
  LEFT JOIN benchmark_nav_daily b ON b.benchmark_id = 'nifty-500' AND b.date = n.date
  WHERE n.scheme_code = '120564' AND n.date >= '2016-01-01'
  ORDER BY n.date
`).all();
db.close();

await fs.writeFile(outputPath, JSON.stringify({ scheme, rows }));
console.log(`Extracted ${rows.length} daily NAV records to ${outputPath}`);
