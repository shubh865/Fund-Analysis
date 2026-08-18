const fs = require('node:fs');
const path = require('node:path');
const { SQLiteDatabase } = require('./sqlite');

const dataDirectory = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new SQLiteDatabase(path.join(dataDirectory, 'mutual-funds.db'));
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

  -- AMFI's AAUM feed sometimes publishes a single underlying-fund identity
  -- while the NAV feed contains separate Growth and IDCW variants. Keep that
  -- relationship explicit instead of copying AAUM into NAV scheme records.
  CREATE TABLE IF NOT EXISTS scheme_aaum_mappings (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    source_scheme_code TEXT NOT NULL,
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scheme_code, source_scheme_code)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_aaum_mappings_scheme_code
    ON scheme_aaum_mappings(scheme_code);

  -- AMFI's Fund Performance service provides the latest disclosed, point-in-
  -- time scheme AUM in crore.  This is distinct from the periodic AAUM feed.
  CREATE TABLE IF NOT EXISTS scheme_total_aum_daily (
    source_scheme_key TEXT NOT NULL,
    date TEXT NOT NULL,
    scheme_name TEXT NOT NULL,
    maturity_type TEXT,
    category TEXT,
    subcategory TEXT,
    daily_aum_crore REAL,
    riskometer_scheme TEXT,
    riskometer_benchmark TEXT,
    benchmark_name TEXT,
    disclosure_marker TEXT,
    source_url TEXT NOT NULL,
    PRIMARY KEY (source_scheme_key, date)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_total_aum_daily_date
    ON scheme_total_aum_daily(date);

  -- Fund Performance combines Direct and Regular plans at the underlying-
  -- fund level. Keep the relationship explicit rather than copying AUM into
  -- NAV scheme records.
  CREATE TABLE IF NOT EXISTS scheme_total_aum_mappings (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    source_scheme_key TEXT NOT NULL,
    mapping_status TEXT NOT NULL CHECK(mapping_status IN ('provisional', 'verified')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scheme_code, source_scheme_key)
  );

  CREATE INDEX IF NOT EXISTS idx_scheme_total_aum_mappings_scheme_code
    ON scheme_total_aum_mappings(scheme_code);

  -- Official RBI policy-rate observations used as the risk-free baseline for
  -- browser-calculated risk measures such as Sharpe ratio.
  CREATE TABLE IF NOT EXISTS risk_free_rate_daily (
    date TEXT PRIMARY KEY,
    annual_rate_percent REAL NOT NULL,
    rate_name TEXT NOT NULL,
    source_url TEXT NOT NULL
  );

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

  -- Official AMC factsheet observations. Exit-load wording, manager tenure and
  -- debt quants are reported values, so retain them with the factsheet date.
  CREATE TABLE IF NOT EXISTS scheme_factsheet_snapshots (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    as_of_date TEXT NOT NULL,
    source_amc TEXT NOT NULL,
    exit_load_text TEXT,
    source_url TEXT NOT NULL,
    source_file TEXT,
    PRIMARY KEY (scheme_code, as_of_date)
  );

  CREATE TABLE IF NOT EXISTS scheme_factsheet_managers (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    as_of_date TEXT NOT NULL,
    manager_name TEXT NOT NULL,
    managing_since TEXT,
    experience_years REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (scheme_code, as_of_date, manager_name)
  );

  CREATE TABLE IF NOT EXISTS scheme_debt_quant_snapshots (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    as_of_date TEXT NOT NULL,
    modified_duration_years REAL,
    average_maturity_years REAL,
    residual_maturity_years REAL,
    yield_to_maturity_percent REAL,
    macaulay_duration_years REAL,
    standard_deviation_percent REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (scheme_code, as_of_date)
  );

  -- Risk statistics reported directly by an AMC in its monthly factsheet.
  -- Keep these separate from browser-calculated analytics: publishers can use
  -- different benchmarks, windows and methodologies, all of which belong to
  -- the reported observation rather than an inferred calculation.
  CREATE TABLE IF NOT EXISTS scheme_factsheet_risk_snapshots (
    scheme_code TEXT NOT NULL REFERENCES schemes(scheme_code),
    as_of_date TEXT NOT NULL,
    metric_window TEXT,
    sharpe_ratio REAL,
    beta REAL,
    tracking_error_percent REAL,
    upside_capture_percent REAL,
    downside_capture_percent REAL,
    standard_deviation_percent REAL,
    benchmark_name TEXT,
    source_url TEXT NOT NULL,
    PRIMARY KEY (scheme_code, as_of_date, metric_window)
  );

  -- Official NSE source observations for daily equity-price attribution.
  -- Holding-to-security matching uses the published ISIN, while estimated
  -- NAV-driver calculations stay in the browser.
  CREATE TABLE IF NOT EXISTS nse_equity_securities (
    isin TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    company_name TEXT,
    series TEXT,
    source_url TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_nse_equity_securities_symbol
    ON nse_equity_securities(symbol);

  CREATE TABLE IF NOT EXISTS nse_equity_price_daily (
    isin TEXT NOT NULL REFERENCES nse_equity_securities(isin),
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    series TEXT,
    open_price REAL,
    high_price REAL,
    low_price REAL,
    close_price REAL NOT NULL CHECK(close_price > 0),
    previous_close_price REAL,
    volume REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (isin, date)
  );

  CREATE INDEX IF NOT EXISTS idx_nse_equity_price_daily_date
    ON nse_equity_price_daily(date);

  -- Official NSE daily index close report. Market-sector interpretation is
  -- calculated in the browser; these are the unchanged source observations.
  CREATE TABLE IF NOT EXISTS nse_index_close_daily (
    index_name TEXT NOT NULL,
    date TEXT NOT NULL,
    close_value REAL NOT NULL,
    points_change REAL,
    percent_change REAL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (index_name, date)
  );
  CREATE INDEX IF NOT EXISTS idx_nse_index_close_daily_date
    ON nse_index_close_daily(date);

  -- Local internal-access accounts. Public registration creates a pending
  -- account only; only the seeded Super Admin can approve a user.
  CREATE TABLE IF NOT EXISTS app_users (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    full_name TEXT NOT NULL,
    email TEXT,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    request_status_token TEXT UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('super_admin', 'user')) DEFAULT 'user',
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'suspended')) DEFAULT 'pending',
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TEXT,
    approved_by_user_id INTEGER REFERENCES app_users(user_id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status);

  -- Basic internal product-usage audit.  Deliberately excludes passwords,
  -- search terms, selected schemes, and network-address data.
  CREATE TABLE IF NOT EXISTS app_usage_events (
    event_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_users(user_id),
    event_type TEXT NOT NULL CHECK(event_type IN ('login', 'logout', 'page_view')),
    event_value TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_app_usage_events_created_at ON app_usage_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_app_usage_events_user_id ON app_usage_events(user_id);

  -- Private local assistant history. Conversations remain on this database
  -- and are retained only for a limited internal-review period.
  CREATE TABLE IF NOT EXISTS app_assistant_chats (
    chat_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_users(user_id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    language TEXT NOT NULL CHECK(language IN ('en', 'gu')),
    verified_data_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_app_assistant_chats_user_created
    ON app_assistant_chats(user_id, created_at DESC);
`);

const debtQuantColumns = db.prepare('PRAGMA table_info(scheme_debt_quant_snapshots)').all().map((column) => column.name);
if (!debtQuantColumns.includes('residual_maturity_years')) db.exec('ALTER TABLE scheme_debt_quant_snapshots ADD COLUMN residual_maturity_years REAL');

// Keep existing portable databases compatible as the source-data model grows.
const schemeColumns = db.prepare('PRAGMA table_info(schemes)').all().map((column) => column.name);
if (!schemeColumns.includes('category')) db.exec('ALTER TABLE schemes ADD COLUMN category TEXT');

const totalAumColumns = db.prepare('PRAGMA table_info(scheme_total_aum_daily)').all().map((column) => column.name);
if (!totalAumColumns.includes('riskometer_scheme')) db.exec('ALTER TABLE scheme_total_aum_daily ADD COLUMN riskometer_scheme TEXT');
if (!totalAumColumns.includes('riskometer_benchmark')) db.exec('ALTER TABLE scheme_total_aum_daily ADD COLUMN riskometer_benchmark TEXT');
if (!totalAumColumns.includes('benchmark_name')) db.exec('ALTER TABLE scheme_total_aum_daily ADD COLUMN benchmark_name TEXT');

const appUserColumns = db.prepare('PRAGMA table_info(app_users)').all().map((column) => column.name);
if (!appUserColumns.includes('request_status_token')) db.exec('ALTER TABLE app_users ADD COLUMN request_status_token TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_request_status_token ON app_users(request_status_token)');

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
