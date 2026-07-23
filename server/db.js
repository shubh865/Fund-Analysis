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

  -- Monthly portfolio disclosures are source data. Calculated views such as
  -- sector concentration, overlap and holding changes remain in the browser.
  CREATE TABLE IF NOT EXISTS holding_portfolios (
    portfolio_id INTEGER PRIMARY KEY,
    amc TEXT NOT NULL,
    source_fund_code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    UNIQUE (amc, source_fund_code)
  );

  CREATE TABLE IF NOT EXISTS holding_imports (
    import_id INTEGER PRIMARY KEY,
    amc TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_url TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (amc, as_of_date, source_file)
  );

  CREATE TABLE IF NOT EXISTS portfolio_holdings (
    portfolio_id INTEGER NOT NULL REFERENCES holding_portfolios(portfolio_id),
    as_of_date TEXT NOT NULL,
    position_order INTEGER NOT NULL,
    asset_class TEXT,
    holding_group TEXT,
    instrument_name TEXT NOT NULL,
    isin TEXT,
    industry_or_rating TEXT,
    quantity REAL,
    market_value_lakh REAL,
    weight REAL,
    yield REAL,
    yield_to_call REAL,
    PRIMARY KEY (portfolio_id, as_of_date, position_order)
  );

  CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_as_of_date
    ON portfolio_holdings(as_of_date);
  CREATE INDEX IF NOT EXISTS idx_portfolio_holdings_isin
    ON portfolio_holdings(isin);

  -- A disclosure portfolio is shared by Direct and Regular plans. This mapping
  -- will be populated only after its source-fund identity is verified.
  CREATE TABLE IF NOT EXISTS scheme_portfolio_mappings (
    scheme_code TEXT PRIMARY KEY REFERENCES schemes(scheme_code),
    portfolio_id INTEGER NOT NULL REFERENCES holding_portfolios(portfolio_id),
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
    source_url TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- AMFI publishes Average AUM (AAUM), rather than point-in-time month-end
  -- AUM.  Since 2010 the official series is normally quarterly.  Keep the
  -- source period and AMFI code intact; any relationship analysis stays in
  -- the browser.
  CREATE TABLE IF NOT EXISTS scheme_aaum_periodic (
    amfi_scheme_code TEXT NOT NULL,
    period_end TEXT NOT NULL,
    period_label TEXT NOT NULL,
    financial_year TEXT,
    reporting_frequency TEXT NOT NULL CHECK(reporting_frequency IN ('monthly', 'quarterly', 'unknown')),
    scheme_name TEXT NOT NULL,
    amc TEXT,
    category TEXT,
    aaum_excluding_domestic_fof_lakh REAL,
    aaum_domestic_fof_lakh REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (amfi_scheme_code, period_end)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_aaum_periodic_period_end
    ON scheme_aaum_periodic(period_end);

  -- AMFI's daily TER publication is at the underlying-scheme level and
  -- reports Regular and Direct values together.  Store the published NSDL
  -- identifier and components unmodified; do not derive or apply TER again
  -- because it is already reflected in NAV.
  CREATE TABLE IF NOT EXISTS scheme_ter_daily (
    source_scheme_key TEXT NOT NULL,
    date TEXT NOT NULL,
    nsdl_scheme_code TEXT,
    scheme_name TEXT NOT NULL,
    amfi_mf_id TEXT,
    scheme_type TEXT,
    category TEXT,
    regular_ber REAL,
    regular_brokerage_cost REAL,
    regular_transaction_cost REAL,
    regular_statutory_levies REAL,
    regular_ter REAL,
    direct_ber REAL,
    direct_brokerage_cost REAL,
    direct_transaction_cost REAL,
    direct_statutory_levies REAL,
    direct_ter REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (source_scheme_key, date)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_ter_daily_date
    ON scheme_ter_daily(date);

  -- TER is published once for the underlying fund with separate Direct and
  -- Regular values.  This maps each NAV scheme to that raw TER identity;
  -- calculations remain outside the database.
  CREATE TABLE IF NOT EXISTS scheme_ter_mappings (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    source_scheme_key TEXT NOT NULL,
    plan_type TEXT NOT NULL CHECK(plan_type IN ('direct', 'regular')),
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scheme_code, source_scheme_key)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_ter_mappings_scheme_code
    ON scheme_ter_mappings(scheme_code);

  CREATE INDEX IF NOT EXISTS idx_scheme_ter_mappings_source_key
    ON scheme_ter_mappings(source_scheme_key);
`);

// Keep existing portable databases compatible as the source-data model grows.
const schemeColumns = db.prepare('PRAGMA table_info(schemes)').all().map((column) => column.name);
if (!schemeColumns.includes('category')) db.exec('ALTER TABLE schemes ADD COLUMN category TEXT');

// AMFI added NSDL scheme codes to its newer TER format.  Older official TER
// records do not have them, so migrate the original table to a source-key
// primary key while preserving NSDL codes whenever they exist.
const terColumns = db.prepare('PRAGMA table_info(scheme_ter_daily)').all().map((column) => column.name);
if (!terColumns.includes('source_scheme_key')) {
  db.exec(`
    ALTER TABLE scheme_ter_daily RENAME TO scheme_ter_daily_legacy;
    CREATE TABLE scheme_ter_daily (
      source_scheme_key TEXT NOT NULL,
      date TEXT NOT NULL,
      nsdl_scheme_code TEXT,
      scheme_name TEXT NOT NULL,
      amfi_mf_id TEXT,
      scheme_type TEXT,
      category TEXT,
      regular_ber REAL,
      regular_brokerage_cost REAL,
      regular_transaction_cost REAL,
      regular_statutory_levies REAL,
      regular_ter REAL,
      direct_ber REAL,
      direct_brokerage_cost REAL,
      direct_transaction_cost REAL,
      direct_statutory_levies REAL,
      direct_ter REAL,
      source_url TEXT NOT NULL,
      PRIMARY KEY (source_scheme_key, date)
    );
    INSERT INTO scheme_ter_daily (
      source_scheme_key, date, nsdl_scheme_code, scheme_name, amfi_mf_id,
      scheme_type, category, regular_ber, regular_brokerage_cost,
      regular_transaction_cost, regular_statutory_levies, regular_ter,
      direct_ber, direct_brokerage_cost, direct_transaction_cost,
      direct_statutory_levies, direct_ter, source_url
    )
    SELECT
      'NSDL:' || nsdl_scheme_code, date, nsdl_scheme_code, scheme_name, amfi_mf_id,
      scheme_type, category, regular_ber, regular_brokerage_cost,
      regular_transaction_cost, regular_statutory_levies, regular_ter,
      direct_ber, direct_brokerage_cost, direct_transaction_cost,
      direct_statutory_levies, direct_ter, source_url
    FROM scheme_ter_daily_legacy;
    DROP TABLE scheme_ter_daily_legacy;
    CREATE INDEX IF NOT EXISTS idx_scheme_ter_daily_date ON scheme_ter_daily(date);
  `);
}

const terMappingColumns = db.prepare('PRAGMA table_info(scheme_ter_mappings)').all();
const terMappingUsesCompositeKey = terMappingColumns.some((column) => column.name === 'source_scheme_key' && column.pk === 2);
if (!terMappingUsesCompositeKey) {
  db.exec(`
    ALTER TABLE scheme_ter_mappings RENAME TO scheme_ter_mappings_legacy;
    CREATE TABLE scheme_ter_mappings (
      scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
      source_scheme_key TEXT NOT NULL,
      plan_type TEXT NOT NULL CHECK(plan_type IN ('direct', 'regular')),
      mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scheme_code, source_scheme_key)
    );
    INSERT INTO scheme_ter_mappings (scheme_code, source_scheme_key, plan_type, mapping_status, updated_at)
    SELECT scheme_code, source_scheme_key, plan_type, mapping_status, updated_at
    FROM scheme_ter_mappings_legacy;
    DROP TABLE scheme_ter_mappings_legacy;
    CREATE INDEX IF NOT EXISTS idx_scheme_ter_mappings_scheme_code ON scheme_ter_mappings(scheme_code);
    CREATE INDEX IF NOT EXISTS idx_scheme_ter_mappings_source_key ON scheme_ter_mappings(source_scheme_key);
  `);
}

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
