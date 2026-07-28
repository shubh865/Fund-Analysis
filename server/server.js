const express = require('express');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

function growthPlanType(name) {
  const normalized = String(name || '').toLowerCase();
  if (!normalized.includes('growth') || /\b(idcw|dividend|payout|reinvestment|bonus)\b/.test(normalized)) return null;
  return /\bdirect\b/.test(normalized) ? 'direct' : 'regular';
}

function planFamily(name) {
  return String(name || '').toUpperCase()
    .replace(/\bFLEXICAP\b/g, 'FLEXI CAP')
    // AMFI plan labels are not perfectly consistent across Direct and Regular
    // records. These are name-only aliases, not investment-style changes.
    .replace(/\bMIDCAP\b/g, 'MID CAP')
    .replace(/\bOWSAL\b/g, 'OSWAL')
    .replace(/\b(DIRECT|REGULAR|STANDARD|PLAN|GROWTH|OPTION|FUND)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/schemes', (request, response) => {
  const query = String(request.query.q || '').trim();
  const structure = String(request.query.structure || 'all').toLowerCase();
  const plan = String(request.query.plan || 'all').toLowerCase();
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
  let sourceCategories = [];
  try {
    const parsed = JSON.parse(String(request.query.categories || '[]'));
    if (Array.isArray(parsed)) sourceCategories = parsed.filter((category) => typeof category === 'string').slice(0, 40);
  } catch {
    // An invalid filter must not change the search result set.
  }
  const escapeLike = (value) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const queryTerms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  const nameConditions = queryTerms.length
    ? queryTerms.map(() => "s.name LIKE ? ESCAPE '\\'").join(' AND ')
    : '1 = 1';
  const closeEndedCondition = `(LOWER(s.name) LIKE '%close ended%' OR LOWER(s.name) LIKE '%closed%' OR LOWER(s.name) LIKE '%fixed maturity%' OR LOWER(s.name) LIKE '%fmp%')`;
  const structureCondition = structure === 'closed'
    ? closeEndedCondition
    : structure === 'open'
      ? `NOT ${closeEndedCondition}`
      : '1 = 1';
  const idcwCondition = `(LOWER(s.name) LIKE '%idcw%' OR LOWER(s.name) LIKE '%dividend%' OR LOWER(s.name) LIKE '%payout%' OR LOWER(s.name) LIKE '%reinvestment%' OR LOWER(s.name) LIKE '%bonus%')`;
  const planCondition = plan === 'direct'
    ? `LOWER(s.name) LIKE '%direct%'`
    : plan === 'regular'
      ? `LOWER(s.name) NOT LIKE '%direct%' AND NOT ${idcwCondition}`
      : plan === 'idcw'
        ? idcwCondition
        : '1 = 1';
  const categoryCondition = sourceCategories.length
    ? `s.category IN (${sourceCategories.map(() => '?').join(', ')})`
    : '1 = 1';
  const parameters = [query, escapeLike(query), ...queryTerms.map(escapeLike), ...sourceCategories, limit];

  const schemes = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category, latest.nav, latest.date AS nav_date
    FROM schemes s
    LEFT JOIN nav_daily latest
      ON latest.scheme_code = s.scheme_code
      AND latest.date = (SELECT MAX(date) FROM nav_daily WHERE scheme_code = s.scheme_code)
    WHERE (? = '' OR s.scheme_code LIKE ? ESCAPE '\\' OR (${nameConditions}))
      AND ${structureCondition}
      AND ${planCondition}
      AND ${categoryCondition}
    ORDER BY s.name COLLATE NOCASE
    LIMIT ?
  `).all(...parameters);

  response.json({ schemes });
});

app.get('/api/schemes/:schemeCode/nav-history', (request, response) => {
  const scheme = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category, b.benchmark_id, b.name AS benchmark_name, cbd.mapping_status AS benchmark_mapping_status,
      (SELECT nav FROM nav_daily WHERE scheme_code = s.scheme_code ORDER BY date DESC LIMIT 1) AS latest_nav,
      (SELECT date FROM nav_daily WHERE scheme_code = s.scheme_code ORDER BY date DESC LIMIT 1) AS latest_nav_date,
      a.daily_aum_crore AS total_aum_crore,
      a.date AS total_aum_date,
      a.disclosure_marker AS total_aum_disclosure_marker,
      a.riskometer_scheme,
      a.riskometer_benchmark AS amfi_riskometer_benchmark,
      a.benchmark_name AS amfi_benchmark_name
    FROM schemes s
    LEFT JOIN category_benchmark_defaults cbd ON cbd.category = s.category
    LEFT JOIN benchmarks b ON b.benchmark_id = cbd.benchmark_id
    LEFT JOIN scheme_total_aum_mappings m ON m.scheme_code = s.scheme_code
    LEFT JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key
      AND a.date = (SELECT MAX(date) FROM scheme_total_aum_daily)
    WHERE s.scheme_code = ?
  `).get(request.params.schemeCode);
  if (!scheme) return response.status(404).json({ error: 'Scheme not found' });

  const history = db.prepare(`
    SELECT date, nav FROM nav_daily
    WHERE scheme_code = ?
    ORDER BY date ASC
  `).all(scheme.scheme_code);
  const benchmarkHistory = scheme.benchmark_id
    ? db.prepare(`
      SELECT date, value
      FROM benchmark_nav_daily
      WHERE benchmark_id = ?
      ORDER BY date ASC
    `).all(scheme.benchmark_id)
    : [];
  const riskFreeRates = db.prepare(`
    SELECT date, annual_rate_percent
    FROM risk_free_rate_daily
    ORDER BY date ASC
  `).all();
  const selectedPlanType = growthPlanType(scheme.name);
  let planPair = null;
  let planPairHistory = [];
  if (selectedPlanType && scheme.amc) {
    const candidates = db.prepare(`
      SELECT scheme_code, name, amc, category
      FROM schemes
      WHERE amc = ? AND category IS ? AND scheme_code <> ? AND LOWER(name) LIKE '%growth%'
    `).all(scheme.amc, scheme.category, scheme.scheme_code);
    const wantedType = selectedPlanType === 'direct' ? 'regular' : 'direct';
    const selectedFamily = planFamily(scheme.name);
    planPair = candidates.find((candidate) => (
      growthPlanType(candidate.name) === wantedType && planFamily(candidate.name) === selectedFamily
    )) || null;
    if (planPair) {
      planPairHistory = db.prepare(`
        SELECT date, nav FROM nav_daily
        WHERE scheme_code = ?
        ORDER BY date ASC
      `).all(planPair.scheme_code);
    }
  }
  response.json({ scheme, history, benchmark_history: benchmarkHistory, risk_free_rates: riskFreeRates, plan_pair: planPair, plan_pair_history: planPairHistory });
});

app.get('/api/schemes/:schemeCode/holdings', (request, response) => {
  const portfolio = db.prepare(`
    SELECT p.portfolio_id, p.amc, p.name, p.source_fund_code, MAX(h.as_of_date) AS as_of_date
    FROM scheme_portfolio_mappings m
    JOIN holding_portfolios p ON p.portfolio_id = m.portfolio_id
    JOIN portfolio_holdings h ON h.portfolio_id = p.portfolio_id
    WHERE m.scheme_code = ?
    GROUP BY p.portfolio_id, p.amc, p.name, p.source_fund_code
  `).get(request.params.schemeCode);
  if (!portfolio) return response.status(404).json({ error: 'No verified monthly portfolio disclosure is available for this scheme yet.' });

  // Source disclosure rows only. The browser calculates sector totals and rankings.
  const holdings = db.prepare(`
    SELECT asset_class, holding_group, instrument_name, isin, industry_or_rating,
      quantity, market_value_lakh, weight, yield, yield_to_call
    FROM portfolio_holdings
    WHERE portfolio_id = ? AND as_of_date = ?
    ORDER BY position_order
  `).all(portfolio.portfolio_id, portfolio.as_of_date);
  response.json({ portfolio, holdings });
});

app.get('/api/schemes/:schemeCode/fund-snapshot', (request, response) => {
  const scheme = db.prepare('SELECT scheme_code, name FROM schemes WHERE scheme_code = ?').get(request.params.schemeCode);
  if (!scheme) return response.status(404).json({ error: 'Scheme not found' });

  // Raw observations only. Trend and change calculations remain in the browser.
  const aaum = db.prepare(`
    SELECT a.period_end, a.period_label, a.reporting_frequency,
      aaum_excluding_domestic_fof_lakh, aaum_domestic_fof_lakh
    FROM scheme_aaum_mappings m
    JOIN scheme_aaum_periodic a ON a.amfi_scheme_code = m.source_scheme_code
    WHERE m.scheme_code = ?
    ORDER BY a.period_end ASC
  `).all(scheme.scheme_code);
  const ter = db.prepare(`
    SELECT t.date, t.regular_ter, t.direct_ter, m.plan_type, m.mapping_status
    FROM scheme_ter_mappings m
    JOIN scheme_ter_daily t ON t.source_scheme_key = m.source_scheme_key
    WHERE m.scheme_code = ?
    ORDER BY t.date ASC
  `).all(scheme.scheme_code);
  response.json({ aaum, ter });
});

app.get('/api/categories', (_request, response) => {
  const categories = db.prepare(`
    SELECT category, COUNT(*) AS scheme_count
    FROM schemes
    WHERE category IS NOT NULL
    GROUP BY category
    ORDER BY category COLLATE NOCASE
  `).all();
  const latestNavDate = db.prepare('SELECT MAX(date) AS date FROM nav_daily').get().date;
  response.json({ categories, latest_nav_date: latestNavDate });
});

app.get('/api/categories/:category/nav-snapshot', (request, response) => {
  const years = Number(request.query.years || 3);
  if (![1, 3, 5].includes(years)) return response.status(400).json({ error: 'years must be 1, 3, or 5' });
  const plans = String(request.query.plans || 'all');
  if (!['all', 'growth-direct-regular'].includes(plans)) return response.status(400).json({ error: 'plans must be all or growth-direct-regular' });
  const asOf = String(request.query.asOf || '');
  if (asOf && !/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf)) return response.status(400).json({ error: 'asOf must be a YYYY-MM month' });
  let requestedCategories = [request.params.category];
  if (request.query.categories) {
    try {
      const parsed = JSON.parse(String(request.query.categories));
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((category) => typeof category !== 'string' || !category.trim())) throw new Error('invalid category list');
      requestedCategories = [...new Set(parsed)];
    } catch {
      return response.status(400).json({ error: 'categories must be a JSON array of AMFI category names' });
    }
  }
  const asOfMonth = asOf || null;
  // This returns source NAV observations only. Return calculations and ranking
  // are intentionally performed by the browser.
  const schemes = db.prepare(`
    WITH latest AS (
      SELECT s.scheme_code, s.name, s.amc, s.category,
        (SELECT nav FROM nav_daily WHERE scheme_code = s.scheme_code AND date <= COALESCE(date(? || '-01', '+1 month', '-1 day'), '9999-12-31') ORDER BY date DESC LIMIT 1) AS latest_nav,
        (SELECT date FROM nav_daily WHERE scheme_code = s.scheme_code AND date <= COALESCE(date(? || '-01', '+1 month', '-1 day'), '9999-12-31') ORDER BY date DESC LIMIT 1) AS latest_date
      FROM schemes s
      WHERE s.category IN (${requestedCategories.map(() => '?').join(', ')})
        ${plans === 'growth-direct-regular' ? `
        AND LOWER(s.name) LIKE '%growth%'
        AND LOWER(s.name) NOT LIKE '%idcw%'
        AND LOWER(s.name) NOT LIKE '%dividend%'
        AND LOWER(s.name) NOT LIKE '%payout%'
        AND LOWER(s.name) NOT LIKE '%reinvestment%'
        AND LOWER(s.name) NOT LIKE '%bonus%'
        AND LOWER(s.name) NOT LIKE '%income distribution%'` : ''}
    )
    SELECT l.*, 
      (SELECT nav FROM nav_daily WHERE scheme_code = l.scheme_code AND date <= date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) AS start_nav,
      (SELECT date FROM nav_daily WHERE scheme_code = l.scheme_code AND date <= date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) AS start_date
    FROM latest l
    WHERE latest_nav IS NOT NULL
    ORDER BY name COLLATE NOCASE
  `).all(asOfMonth, asOfMonth, ...requestedCategories, years, years);
  response.json({ category: request.params.category, categories: requestedCategories, years, as_of_month: asOfMonth, plans, schemes });
});

app.get('/api/categories/:category/peer-nav-history', (request, response) => {
  const category = request.params.category;
  const plan = String(request.query.plan || 'direct');
  if (!['direct', 'regular', 'all-growth', 'direct-idcw', 'regular-idcw'].includes(plan)) {
    return response.status(400).json({ error: 'plan must be direct, regular, all-growth, direct-idcw, or regular-idcw' });
  }
  let requestedCategories = [category];
  if (request.query.categories) {
    try {
      const parsed = JSON.parse(String(request.query.categories));
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('invalid category list');
      requestedCategories = [...new Set(parsed)];
    } catch {
      return response.status(400).json({ error: 'categories must be a JSON array of AMFI category names' });
    }
  }
  const benchmarks = db.prepare(`
    SELECT b.benchmark_id, b.name, cbd.mapping_status
    FROM category_benchmark_defaults cbd
    JOIN benchmarks b ON b.benchmark_id = cbd.benchmark_id
    WHERE cbd.category IN (${requestedCategories.map(() => '?').join(', ')})
  `).all(...requestedCategories);
  if (benchmarks.length !== requestedCategories.length) return response.status(404).json({ error: 'No benchmark mapping is available for one or more selected categories.' });
  const uniqueBenchmarks = [...new Map(benchmarks.map((benchmark) => [benchmark.benchmark_id, benchmark])).values()];
  if (uniqueBenchmarks.length !== 1) return response.status(409).json({ error: 'The selected AMFI categories use different benchmarks and cannot be merged for peer analysis.' });
  const benchmark = uniqueBenchmarks[0];

  // Source observations only: the browser calculates all rolling metrics.
  // Ten years of raw data is enough to produce every 1Y–5Y rolling window
  // currently supported while keeping local category responses practical.
  const growthOnly = "LOWER(s.name) LIKE '%growth%' AND LOWER(s.name) NOT LIKE '%idcw%' AND LOWER(s.name) NOT LIKE '%dividend%' AND LOWER(s.name) NOT LIKE '%payout%' AND LOWER(s.name) NOT LIKE '%reinvestment%' AND LOWER(s.name) NOT LIKE '%bonus%'";
  // Older AMFI names may spell IDCW out rather than use its current abbreviation.
  const idcwOnly = "(LOWER(s.name) LIKE '%idcw%' OR LOWER(s.name) LIKE '%income distribution%' OR LOWER(s.name) LIKE '%dividend%')";
  const growthCondition = plan === 'direct'
    ? `${growthOnly} AND LOWER(s.name) LIKE '%direct%'`
    : plan === 'regular'
      ? `${growthOnly} AND LOWER(s.name) NOT LIKE '%direct%'`
      : plan === 'direct-idcw'
        ? `${idcwOnly} AND LOWER(s.name) LIKE '%direct%'`
        : plan === 'regular-idcw'
          ? `${idcwOnly} AND LOWER(s.name) NOT LIKE '%direct%'`
          : growthOnly;
  const schemes = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category
    FROM schemes s
    WHERE s.category IN (${requestedCategories.map(() => '?').join(', ')})
      AND ${growthCondition}
      AND EXISTS (SELECT 1 FROM nav_daily n WHERE n.scheme_code = s.scheme_code AND n.date >= '2010-01-01')
    ORDER BY s.name COLLATE NOCASE
  `).all(...requestedCategories);
  const navRows = schemes.length
    ? db.prepare(`
      SELECT scheme_code, date, nav
      FROM nav_daily
      WHERE scheme_code IN (${schemes.map(() => '?').join(', ')}) AND date >= '2010-01-01'
      ORDER BY scheme_code, date
    `).all(...schemes.map((scheme) => scheme.scheme_code))
    : [];
  const benchmarkHistory = db.prepare(`
    SELECT date, value
    FROM benchmark_nav_daily
    WHERE benchmark_id = ? AND date >= '2010-01-01'
    ORDER BY date
  `).all(benchmark.benchmark_id);

  const histories = Object.fromEntries(schemes.map((scheme) => [scheme.scheme_code, []]));
  for (const row of navRows) histories[row.scheme_code]?.push({ date: row.date, nav: row.nav });
  response.json({ category, categories: requestedCategories, plan, benchmark, schemes, histories, benchmark_history: benchmarkHistory });
});

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
