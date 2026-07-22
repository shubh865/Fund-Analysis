const express = require('express');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/schemes', (request, response) => {
  const query = String(request.query.q || '').trim();
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
  const escapeLike = (value) => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const queryTerms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  const nameConditions = queryTerms.length
    ? queryTerms.map(() => "s.name LIKE ? ESCAPE '\\'").join(' AND ')
    : '1 = 1';
  const parameters = [query, escapeLike(query), ...queryTerms.map(escapeLike), limit];

  const schemes = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category, latest.nav, latest.date AS nav_date
    FROM schemes s
    LEFT JOIN nav_daily latest
      ON latest.scheme_code = s.scheme_code
      AND latest.date = (SELECT MAX(date) FROM nav_daily WHERE scheme_code = s.scheme_code)
    WHERE (? = '' OR s.scheme_code LIKE ? ESCAPE '\\' OR (${nameConditions}))
    ORDER BY s.name COLLATE NOCASE
    LIMIT ?
  `).all(...parameters);

  response.json({ schemes });
});

app.get('/api/schemes/:schemeCode/nav-history', (request, response) => {
  const scheme = db.prepare(`
    SELECT s.scheme_code, s.name, s.amc, s.category, b.benchmark_id, b.name AS benchmark_name, cbd.mapping_status AS benchmark_mapping_status,
      (SELECT nav FROM nav_daily WHERE scheme_code = s.scheme_code ORDER BY date DESC LIMIT 1) AS latest_nav,
      (SELECT date FROM nav_daily WHERE scheme_code = s.scheme_code ORDER BY date DESC LIMIT 1) AS latest_nav_date
    FROM schemes s
    LEFT JOIN category_benchmark_defaults cbd ON cbd.category = s.category
    LEFT JOIN benchmarks b ON b.benchmark_id = cbd.benchmark_id
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
  response.json({ scheme, history, benchmark_history: benchmarkHistory });
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
  const asOf = String(request.query.asOf || '');
  if (asOf && !/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf)) return response.status(400).json({ error: 'asOf must be a YYYY-MM month' });
  const asOfMonth = asOf || null;
  // This returns source NAV observations only. Return calculations and ranking
  // are intentionally performed by the browser.
  const schemes = db.prepare(`
    WITH latest AS (
      SELECT s.scheme_code, s.name, s.amc, s.category,
        (SELECT nav FROM nav_daily WHERE scheme_code = s.scheme_code AND date <= COALESCE(date(? || '-01', '+1 month', '-1 day'), '9999-12-31') ORDER BY date DESC LIMIT 1) AS latest_nav,
        (SELECT date FROM nav_daily WHERE scheme_code = s.scheme_code AND date <= COALESCE(date(? || '-01', '+1 month', '-1 day'), '9999-12-31') ORDER BY date DESC LIMIT 1) AS latest_date
      FROM schemes s
      WHERE s.category = ?
    )
    SELECT l.*, 
      (SELECT nav FROM nav_daily WHERE scheme_code = l.scheme_code AND date <= date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) AS start_nav,
      (SELECT date FROM nav_daily WHERE scheme_code = l.scheme_code AND date <= date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) AS start_date
    FROM latest l
    WHERE latest_nav IS NOT NULL
    ORDER BY name COLLATE NOCASE
  `).all(asOfMonth, asOfMonth, request.params.category, years, years);
  response.json({ category: request.params.category, years, as_of_month: asOfMonth, schemes });
});

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
