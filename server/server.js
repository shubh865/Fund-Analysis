const express = require('express');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

function growthPlanType(name) {
  const normalized = String(name || '').toLowerCase();
  if (!normalized.includes('growth') || /\b(idcw|dividend|payout|reinvestment|bonus)\b|income distribution/.test(normalized)) return null;
  return /\bdirect\b/.test(normalized) ? 'direct' : 'regular';
}

function isNonStandardPlanName(name) {
  const normalized = String(name || '').toLowerCase();
  return /\b(discontinued|defunct|segregated|institutional|retail|premium|wholesale|provident|unclaimed)\b/.test(normalized)
    || /investor education|super institutional|\bpf\b|\beco\b|\bplan\s+[bc]\b/.test(normalized);
}

function quartilePlanType(name) {
  const normalized = String(name || '').toLowerCase();
  if (!normalized.includes('growth')) return null;
  if (/\b(idcw|dividend|payout|reinvestment|bonus)\b|income distribution/.test(normalized)) return null;
  if (isNonStandardPlanName(normalized)) return null;
  return /\bdirect\b/.test(normalized) ? 'direct' : 'regular';
}

function idcwPlanType(name) {
  const normalized = String(name || '').toLowerCase();
  if (!/\b(idcw|dividend|payout|reinvestment)\b|income distribution/.test(normalized)) return null;
  if (isNonStandardPlanName(normalized)) return null;
  return /\bdirect\b/.test(normalized) ? 'direct' : 'regular';
}

function explicitPlanPreference(name, type) {
  const normalized = String(name || '').toLowerCase();
  return type === 'direct' ? (/\bdirect\b/.test(normalized) ? 2 : 1) : (/\bregular\b/.test(normalized) ? 2 : 1);
}

function eligiblePeerPlan(name, plan) {
  const growthType = quartilePlanType(name);
  const distributionType = idcwPlanType(name);
  if (plan === 'direct') return growthType === 'direct';
  if (plan === 'regular') return growthType === 'regular';
  if (plan === 'all-growth') return Boolean(growthType);
  if (plan === 'direct-idcw') return distributionType === 'direct';
  if (plan === 'regular-idcw') return distributionType === 'regular';
  return false;
}

function dedupePeerSchemes(schemes, plan) {
  const growthSelection = ['direct', 'regular', 'all-growth'].includes(plan);
  if (!growthSelection) return schemes;
  const families = new Map();
  for (const scheme of schemes) {
    const type = quartilePlanType(scheme.name);
    if (!type) continue;
    const key = `${scheme.amc || ''}|${type}|${planFamily(scheme.name)}`;
    const existing = families.get(key);
    if (!existing
      || scheme.latest_nav_date > existing.latest_nav_date
      || (scheme.latest_nav_date === existing.latest_nav_date
        && explicitPlanPreference(scheme.name, type) > explicitPlanPreference(existing.name, type))) {
      families.set(key, scheme);
    }
  }
  return [...families.values()].sort((left, right) => left.name.localeCompare(right.name));
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

function explicitTerPlan(name) {
  const normalized = String(name || '').toLowerCase();
  if (/\bdirect\s+(?:plan|option)\b/.test(normalized) || /-\s*direct\b/.test(normalized)) return 'direct';
  if (/\b(?:regular|standard)\s+(?:plan|option)\b/.test(normalized) || /-\s*regular\b/.test(normalized)) return 'regular';
  return null;
}

function daysBetween(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000);
}

function normalizedBenchmarkName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/\btotal return index\b|\btri\b|\bbenchmark\b|\bindex\b/g, ' ')
    .replace(/\b[abc][ -]?(?:i|ii|iii|iv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function benchmarkNamesMatch(mappedName, reportedName) {
  const mapped = normalizedBenchmarkName(mappedName);
  const reported = normalizedBenchmarkName(reportedName);
  return Boolean(mapped && reported && mapped === reported);
}

// Select raw, plan-specific AMFI TER observations without calculating a return.
// New NSDL identities take precedence over legacy identities on overlapping
// dates. Explicit Direct/Regular source labels must agree with the NAV plan.
function resolveTerHistory(rows, planType) {
  const candidatesByDate = new Map();
  for (const row of rows) {
    const sourcePlan = explicitTerPlan(row.scheme_name);
    if (sourcePlan && sourcePlan !== planType) continue;
    const value = planType === 'direct' ? row.direct_ter : row.regular_ter;
    if (!Number.isFinite(value) || value <= 0 || value >= 100) continue;
    const priority = String(row.source_scheme_key).startsWith('NSDL:') ? 3 : sourcePlan === planType ? 2 : 1;
    const candidates = candidatesByDate.get(row.date) || [];
    candidates.push({ value, priority });
    candidatesByDate.set(row.date, candidates);
  }

  const resolved = [];
  let ambiguousDays = 0;
  for (const [date, candidates] of [...candidatesByDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const bestPriority = Math.max(...candidates.map((candidate) => candidate.priority));
    const best = candidates.filter((candidate) => candidate.priority === bestPriority);
    const minimum = Math.min(...best.map((candidate) => candidate.value));
    const maximum = Math.max(...best.map((candidate) => candidate.value));
    if (maximum - minimum > 0.05) {
      ambiguousDays += 1;
      continue;
    }
    resolved.push({ date, value: best.reduce((sum, candidate) => sum + candidate.value, 0) / best.length });
  }

  let maxGapDays = 0;
  for (let index = 1; index < resolved.length; index += 1) {
    maxGapDays = Math.max(maxGapDays, daysBetween(resolved[index - 1].date, resolved[index].date));
  }
  const changePoints = resolved.filter((point, index) => index === 0 || Math.abs(point.value - resolved[index - 1].value) > 0.0001);
  return {
    change_points: changePoints,
    coverage: {
      first_date: resolved[0]?.date || null,
      last_date: resolved.at(-1)?.date || null,
      observation_days: resolved.length,
      max_gap_days: maxGapDays || null,
      ambiguous_days: ambiguousDays,
    },
  };
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
  const queryTerms = query.split(/\s+/).filter(Boolean).slice(0, 10);
  const nameConditions = queryTerms.length
    ? queryTerms.map(() => "s.name LIKE ? ESCAPE '\\'").join(' AND ')
    : '1 = 1';
  const closeEndedCondition = `(LOWER(s.name) LIKE '%close ended%' OR LOWER(s.name) LIKE '%closed%' OR LOWER(s.name) LIKE '%fixed maturity%' OR LOWER(s.name) LIKE '%fmp%')`;
  const structureCondition = structure === 'closed'
    ? closeEndedCondition
    : structure === 'open'
      ? `NOT ${closeEndedCondition}`
      : '1 = 1';
  const idcwCondition = `(LOWER(s.name) LIKE '%idcw%' OR LOWER(s.name) LIKE '%income distribution%' OR LOWER(s.name) LIKE '%dividend%' OR LOWER(s.name) LIKE '%payout%' OR LOWER(s.name) LIKE '%reinvestment%' OR LOWER(s.name) LIKE '%bonus%')`;
  const growthCondition = `LOWER(s.name) LIKE '%growth%' AND NOT ${idcwCondition}`;
  const standardCondition = `LOWER(s.name) NOT LIKE '%institutional%'
    AND LOWER(s.name) NOT LIKE '%retail%'
    AND LOWER(s.name) NOT LIKE '%premium%'
    AND LOWER(s.name) NOT LIKE '%wholesale%'
    AND LOWER(s.name) NOT LIKE '%provident%'
    AND LOWER(s.name) NOT LIKE '% pf %'
    AND LOWER(s.name) NOT LIKE '%discontinued%'
    AND LOWER(s.name) NOT LIKE '%defunct%'
    AND LOWER(s.name) NOT LIKE '%segregated%'
    AND LOWER(s.name) NOT LIKE '%unclaimed%'
    AND LOWER(s.name) NOT LIKE '%investor education%'
    AND LOWER(s.name) NOT LIKE '%super institutional%'
    AND LOWER(s.name) NOT LIKE '% eco %'
    AND LOWER(s.name) NOT LIKE '%eco plan%'
    AND LOWER(s.name) NOT LIKE '%plan b%'
    AND LOWER(s.name) NOT LIKE '%plan c%'`;
  const planCondition = plan === 'direct'
    ? `${growthCondition} AND LOWER(s.name) LIKE '%direct%' AND ${standardCondition}`
    : plan === 'regular'
      ? `${growthCondition} AND LOWER(s.name) NOT LIKE '%direct%' AND ${standardCondition}`
      : plan === 'growth'
        ? `${growthCondition} AND ${standardCondition}`
      : plan === 'idcw'
        ? `${idcwCondition} AND ${standardCondition}`
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
      AND EXISTS (
        SELECT 1 FROM nav_daily current_nav
        WHERE current_nav.scheme_code = s.scheme_code
          AND current_nav.date >= (SELECT date(MAX(date), '-14 days') FROM nav_daily)
      )
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
      (SELECT a.daily_aum_crore FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS total_aum_crore,
      (SELECT a.date FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS total_aum_date,
      (SELECT a.disclosure_marker FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS total_aum_disclosure_marker,
      (SELECT a.riskometer_scheme FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS riskometer_scheme,
      (SELECT a.riskometer_benchmark FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS amfi_riskometer_benchmark,
      (SELECT a.benchmark_name FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code ORDER BY a.date DESC LIMIT 1) AS amfi_benchmark_name
    FROM schemes s
    LEFT JOIN category_benchmark_defaults cbd ON cbd.category = s.category
    LEFT JOIN benchmarks b ON b.benchmark_id = cbd.benchmark_id
    WHERE s.scheme_code = ?
  `).get(request.params.schemeCode);
  if (!scheme) return response.status(404).json({ error: 'Scheme not found' });

  if (scheme.amfi_benchmark_name) {
    if (scheme.benchmark_name && benchmarkNamesMatch(scheme.benchmark_name, scheme.amfi_benchmark_name)) {
      scheme.benchmark_mapping_status = 'AMFI benchmark match';
    } else {
      scheme.benchmark_id = null;
      scheme.benchmark_name = scheme.amfi_benchmark_name;
      scheme.benchmark_mapping_status = 'AMFI reported; TRI unavailable';
    }
  }

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
      SELECT scheme_code, name, amc, category,
        (SELECT MAX(date) FROM nav_daily WHERE scheme_code = schemes.scheme_code) AS latest_nav_date
      FROM schemes
      WHERE amc = ? AND category IS ? AND scheme_code <> ? AND LOWER(name) LIKE '%growth%'
    `).all(scheme.amc, scheme.category, scheme.scheme_code);
    const wantedType = selectedPlanType === 'direct' ? 'regular' : 'direct';
    const selectedFamily = planFamily(scheme.name);
    planPair = candidates
      .filter((candidate) => (
        candidate.latest_nav_date
        && quartilePlanType(candidate.name) === wantedType
        && planFamily(candidate.name) === selectedFamily
        && daysBetween(candidate.latest_nav_date, scheme.latest_nav_date) <= 14
      ))
      .sort((left, right) => (
        right.latest_nav_date.localeCompare(left.latest_nav_date)
        || explicitPlanPreference(right.name, wantedType) - explicitPlanPreference(left.name, wantedType)
      ))[0] || null;
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
    ORDER BY as_of_date DESC
    LIMIT 1
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
  let schemes = db.prepare(`
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
  const effectiveAsOfDate = db.prepare(`
    SELECT MAX(date) AS date
    FROM nav_daily
    WHERE date <= COALESCE(date(? || '-01', '+1 month', '-1 day'), '9999-12-31')
  `).get(asOfMonth).date;
  if (plans === 'growth-direct-regular') {
    schemes = schemes.filter((scheme) => (
      quartilePlanType(scheme.name)
      && effectiveAsOfDate
      && daysBetween(scheme.latest_date, effectiveAsOfDate) >= 0
      // Historical AMFI archives can end several days before the database-wide
      // month end. Two weeks keeps valid month slices without admitting stale funds.
      && daysBetween(scheme.latest_date, effectiveAsOfDate) <= 14
    ));
  }
  if (String(request.query.includeTer || '') === '1' && schemes.length) {
    const firstStartDate = schemes.reduce((earliest, scheme) => (
      scheme.start_date && (!earliest || scheme.start_date < earliest) ? scheme.start_date : earliest
    ), null);
    const lastEndDate = schemes.reduce((latest, scheme) => (
      scheme.latest_date && (!latest || scheme.latest_date > latest) ? scheme.latest_date : latest
    ), null);
    if (firstStartDate && lastEndDate) {
      const terRows = db.prepare(`
        SELECT m.scheme_code, m.plan_type, t.date, t.source_scheme_key, t.scheme_name,
          t.regular_ter, t.direct_ter
        FROM scheme_ter_mappings m
        JOIN scheme_ter_daily t ON t.source_scheme_key = m.source_scheme_key
        WHERE m.scheme_code IN (${schemes.map(() => '?').join(', ')})
          AND t.date BETWEEN date(?, '-14 days') AND ?
        ORDER BY m.scheme_code, t.date
      `).all(...schemes.map((scheme) => scheme.scheme_code), firstStartDate, lastEndDate);
      const rowsByScheme = new Map();
      for (const row of terRows) {
        const rows = rowsByScheme.get(row.scheme_code) || [];
        rows.push(row);
        rowsByScheme.set(row.scheme_code, rows);
      }
      for (const scheme of schemes) {
        const planType = growthPlanType(scheme.name);
        scheme.ter = planType ? resolveTerHistory(rowsByScheme.get(scheme.scheme_code) || [], planType) : null;
      }
    }
  }
  response.json({ category: request.params.category, categories: requestedCategories, years, as_of_month: asOfMonth, effective_as_of_date: effectiveAsOfDate, plans, schemes });
});

app.get('/api/categories/:category/peer-nav-history', (request, response) => {
  const category = request.params.category;
  const plan = String(request.query.plan || 'direct');
  if (!['direct', 'regular', 'all-growth'].includes(plan)) {
    return response.status(400).json({ error: 'plan must be direct, regular, or all-growth' });
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
  let schemes = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category,
      (SELECT MAX(date) FROM nav_daily WHERE scheme_code = s.scheme_code) AS latest_nav_date,
      (SELECT a.benchmark_name FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key = m.source_scheme_key WHERE m.scheme_code = s.scheme_code AND TRIM(COALESCE(a.benchmark_name, '')) <> '' ORDER BY a.date DESC LIMIT 1) AS reported_benchmark_name
    FROM schemes s
    WHERE s.category IN (${requestedCategories.map(() => '?').join(', ')})
      AND ${growthCondition}
      AND EXISTS (SELECT 1 FROM nav_daily n WHERE n.scheme_code = s.scheme_code AND n.date >= '2010-01-01')
    ORDER BY s.name COLLATE NOCASE
  `).all(...requestedCategories);
  const latestPeerNavDate = db.prepare('SELECT MAX(date) AS date FROM nav_daily').get().date;
  schemes = schemes.filter((scheme) => (
    eligiblePeerPlan(scheme.name, plan)
    && scheme.latest_nav_date
    && daysBetween(scheme.latest_nav_date, latestPeerNavDate) <= 14
  ));
  let benchmarkMismatchCount = 0;
  schemes = schemes.filter((scheme) => {
    const mismatch = scheme.reported_benchmark_name && !benchmarkNamesMatch(benchmark.name, scheme.reported_benchmark_name);
    if (mismatch) benchmarkMismatchCount += 1;
    return !mismatch;
  });
  schemes = dedupePeerSchemes(schemes, plan);
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
  response.json({ category, categories: requestedCategories, plan, benchmark, benchmark_mismatch_count: benchmarkMismatchCount, schemes, histories, benchmark_history: benchmarkHistory });
});

app.get('/api/categories/:category/category-nav-history', (request, response) => {
  const category = request.params.category;
  const plan = String(request.query.plan || 'all-growth');
  const excludeScheme = String(request.query.excludeScheme || '');
  if (!['direct', 'regular', 'all-growth', 'direct-idcw', 'regular-idcw'].includes(plan)) {
    return response.status(400).json({ error: 'plan must be direct, regular, all-growth, direct-idcw, or regular-idcw' });
  }
  const growthOnly = "LOWER(s.name) LIKE '%growth%' AND LOWER(s.name) NOT LIKE '%idcw%' AND LOWER(s.name) NOT LIKE '%dividend%' AND LOWER(s.name) NOT LIKE '%payout%' AND LOWER(s.name) NOT LIKE '%reinvestment%' AND LOWER(s.name) NOT LIKE '%bonus%'";
  const idcwOnly = "(LOWER(s.name) LIKE '%idcw%' OR LOWER(s.name) LIKE '%income distribution%' OR LOWER(s.name) LIKE '%dividend%')";
  const planCondition = plan === 'direct'
    ? `${growthOnly} AND LOWER(s.name) LIKE '%direct%'`
    : plan === 'regular'
      ? `${growthOnly} AND LOWER(s.name) NOT LIKE '%direct%'`
      : plan === 'direct-idcw'
        ? `${idcwOnly} AND LOWER(s.name) LIKE '%direct%'`
        : plan === 'regular-idcw'
          ? `${idcwOnly} AND LOWER(s.name) NOT LIKE '%direct%'`
          : growthOnly;
  // Raw daily NAV observations only. Six years covers the 1/3/5Y selector,
  // while the equal-weighted peer category series is calculated in the browser.
  let schemes = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc,
      (SELECT MAX(date) FROM nav_daily WHERE scheme_code = s.scheme_code) AS latest_nav_date
    FROM schemes s
    WHERE s.category = ?
      AND s.scheme_code <> ?
      AND ${planCondition}
      AND EXISTS (
        SELECT 1 FROM nav_daily n
        WHERE n.scheme_code = s.scheme_code
          AND n.date >= (SELECT date(MAX(date), '-6 years') FROM nav_daily)
      )
  `).all(category, excludeScheme);
  const latestNavDate = db.prepare('SELECT MAX(date) AS date FROM nav_daily').get().date;
  schemes = dedupePeerSchemes(schemes.filter((scheme) => (
    eligiblePeerPlan(scheme.name, plan)
    && scheme.latest_nav_date
    && daysBetween(scheme.latest_nav_date, latestNavDate) <= 14
  )), plan);
  const navRows = schemes.length
    ? db.prepare(`
      SELECT scheme_code, date, nav
      FROM nav_daily
      WHERE scheme_code IN (${schemes.map(() => '?').join(', ')})
        AND date >= (SELECT date(MAX(date), '-6 years') FROM nav_daily)
      ORDER BY scheme_code, date
    `).all(...schemes.map((scheme) => scheme.scheme_code))
    : [];
  const histories = Object.fromEntries(schemes.map((scheme) => [scheme.scheme_code, []]));
  for (const row of navRows) histories[row.scheme_code]?.push({ date: row.date, nav: row.nav });
  response.json({ category, plan, peer_count: schemes.length, histories });
});

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
