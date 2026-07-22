const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(path.join(dataDirectory, 'mutual-funds.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schemes (
    scheme_code TEXT PRIMARY KEY,
    isin_div_payout TEXT,
    isin_growth TEXT,
    name TEXT NOT NULL,
    amc TEXT,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS nav_daily (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    date TEXT NOT NULL,
    nav REAL NOT NULL CHECK(nav > 0),
    PRIMARY KEY (scheme_code, date)
  );

  CREATE INDEX IF NOT EXISTS idx_schemes_name ON schemes(name);
  CREATE INDEX IF NOT EXISTS idx_schemes_category ON schemes(category);

  CREATE TABLE IF NOT EXISTS import_progress (
    source TEXT PRIMARY KEY,
    last_rowid INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS benchmarks (
    benchmark_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT
  );

  CREATE TABLE IF NOT EXISTS category_benchmark_defaults (
    category TEXT PRIMARY KEY,
    benchmark_id TEXT NOT NULL REFERENCES benchmarks(benchmark_id),
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
    source_url TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Source observations only.  Returns, ratios and comparisons remain
  -- browser-calculated, just like the mutual-fund analytics.
  CREATE TABLE IF NOT EXISTS benchmark_nav_daily (
    benchmark_id TEXT NOT NULL REFERENCES benchmarks(benchmark_id),
    date TEXT NOT NULL,
    value REAL NOT NULL CHECK(value > 0),
    source_url TEXT NOT NULL,
    PRIMARY KEY (benchmark_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_benchmark_nav_daily_date
    ON benchmark_nav_daily(date);
`);

// Keep existing portable databases compatible as the source-data model grows.
const schemeColumns = db.prepare('PRAGMA table_info(schemes)').all().map((column) => column.name);
if (!schemeColumns.includes('category')) db.exec('ALTER TABLE schemes ADD COLUMN category TEXT');

// The historical seed loader deliberately defers this secondary index. SQLite
// can then bulk-load millions of source NAV rows much faster and rebuild it
// once at the end.
const historyImportPending = db.prepare(`
  SELECT 1 FROM import_progress
  WHERE source = 'captn3m0-historical-mf-data' AND completed_at IS NULL
`).get();
if (process.env.SKIP_NAV_DATE_INDEX !== '1' && !historyImportPending) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_nav_daily_date ON nav_daily(date)');
}

module.exports = db;
