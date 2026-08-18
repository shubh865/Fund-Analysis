const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const marketNewsCache = new Map();
const sessions = new Map();
const sessionMaxAgeMs = 12 * 60 * 60 * 1000;

function loadLocalEnvironment() {
  const environmentPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(environmentPath)) return;
  for (const rawLine of fs.readFileSync(environmentPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnvironment();
const localLlmBaseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const localLlmModel = process.env.LOCAL_LLM_MODEL || 'gemma3:4b';
const authUsername = process.env.AUTH_USERNAME || '';
const authPassword = process.env.AUTH_PASSWORD || '';
if (!validConfiguredAdmin(authUsername, authPassword)) {
  throw new Error('Set AUTH_USERNAME and a private AUTH_PASSWORD (at least 10 characters) in .env before starting the internal-access server. Copy .env.example to .env first.');
}

function validConfiguredAdmin(username, password) {
  return /^[a-zA-Z0-9._-]{3,48}$/.test(username) && password.length >= 10 && password !== 'change-me';
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validUsername(value) {
  return /^[a-zA-Z0-9._-]{3,48}$/.test(value);
}

function createInitialSuperAdmin() {
  const existing = db.prepare('SELECT user_id FROM app_users WHERE role=\'super_admin\' LIMIT 1').get();
  if (existing) return;
  const credentials = passwordRecord(authPassword);
  db.prepare(`INSERT INTO app_users
    (username, full_name, password_salt, password_hash, role, status, approved_at)
    VALUES (?, ?, ?, ?, 'super_admin', 'approved', CURRENT_TIMESTAMP)`)
    .run(authUsername, 'Super Admin', credentials.salt, credentials.hash);
  console.log(`Created the initial Super Admin account for ${authUsername}.`);
}

createInitialSuperAdmin();

app.use(express.json());

function readCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((item) => {
    const separator = item.indexOf('=');
    return separator < 0 ? [] : [item.slice(0, separator).trim(), decodeURIComponent(item.slice(separator + 1).trim())];
  }).filter((item) => item.length));
}

function activeSession(request) {
  const token = readCookies(request).fund_analysis_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = db.prepare('SELECT user_id,username,full_name,role,status FROM app_users WHERE user_id=?').get(session.userId);
  if (!user || user.status !== 'approved') {
    sessions.delete(token);
    return null;
  }
  return { token, ...session, user };
}

function sessionCookie(token, maxAgeSeconds = sessionMaxAgeMs / 1000) {
  return `fund_analysis_session=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function requestStatusCookie(token, maxAgeSeconds = 30 * 24 * 60 * 60) {
  return `fund_analysis_request_status=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

app.get('/api/auth/session', (request, response) => {
  const session = activeSession(request);
  response.json({ authenticated: Boolean(session), username: session?.user.username || null, role: session?.user.role || null });
});

app.post('/api/auth/login', (request, response) => {
  const username = String(request.body?.username || '').trim();
  const password = String(request.body?.password || '');
  const user = db.prepare('SELECT user_id,username,password_salt,password_hash,role,status FROM app_users WHERE username=?').get(username);
  if (!user || !password || !passwordMatches(password, user.password_salt, user.password_hash)) {
    return response.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (user.status === 'pending') return response.status(403).json({ error: 'Your access request is awaiting Super Admin approval.' });
  if (user.status !== 'approved') return response.status(403).json({ error: 'This account does not have access. Contact the Super Admin.' });
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.user_id, expiresAt: Date.now() + sessionMaxAgeMs });
  logUsage(user.user_id, 'login');
  response.setHeader('Set-Cookie', sessionCookie(token));
  response.json({ authenticated: true, username: user.username, role: user.role });
});

app.post('/api/auth/request-access', (request, response) => {
  const fullName = String(request.body?.fullName || '').trim().replace(/\s+/g, ' ');
  const username = String(request.body?.username || '').trim();
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = String(request.body?.password || '');
  if (fullName.length < 2 || fullName.length > 100) return response.status(400).json({ error: 'Enter your full name.' });
  if (!validUsername(username)) return response.status(400).json({ error: 'Username must be 3–48 characters: letters, numbers, dot, dash, or underscore.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
  if (password.length < 10) return response.status(400).json({ error: 'Choose a password with at least 10 characters.' });
  const credentials = passwordRecord(password);
  const requestStatusToken = crypto.randomBytes(24).toString('base64url');
  try {
    db.prepare(`INSERT INTO app_users (username,full_name,email,password_salt,password_hash,request_status_token,role,status)
      VALUES (?, ?, ?, ?, ?, ?, 'user', 'pending')`).run(username, fullName, email || null, credentials.salt, credentials.hash, requestStatusToken);
  } catch (error) {
    if (/unique/i.test(error.message)) return response.status(409).json({ error: 'That username is already requested or in use.' });
    throw error;
  }
  response.setHeader('Set-Cookie', requestStatusCookie(requestStatusToken));
  response.status(201).json({ message: 'Sign-up complete. Your account is pending Super Admin approval.', status: 'pending', username });
});

app.get('/api/auth/access-status', (request, response) => {
  const token = readCookies(request).fund_analysis_request_status;
  if (!token) return response.json({ status: null });
  const user = db.prepare('SELECT username,full_name,status FROM app_users WHERE request_status_token=?').get(token);
  if (!user) {
    response.setHeader('Set-Cookie', requestStatusCookie('', 0));
    return response.json({ status: null });
  }
  return response.json({ status: user.status, username: user.username, fullName: user.full_name });
});

app.post('/api/auth/logout', (request, response) => {
  const session = activeSession(request);
  if (session) {
    logUsage(session.user.user_id, 'logout');
    sessions.delete(session.token);
  }
  response.setHeader('Set-Cookie', sessionCookie('', 0));
  response.status(204).end();
});

function requireSuperAdmin(request, response, next) {
  const session = activeSession(request);
  if (!session || session.user.role !== 'super_admin') return response.status(403).json({ error: 'Super Admin access is required.' });
  request.superAdmin = session.user;
  return next();
}

function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) if (session.userId === userId) sessions.delete(token);
}

function logUsage(userId, eventType, eventValue = null) {
  db.prepare('INSERT INTO app_usage_events (user_id,event_type,event_value) VALUES (?, ?, ?)').run(userId, eventType, eventValue);
}

// All analytics data stays behind the local authenticated session.
app.use('/api', (request, response, next) => {
  if (request.path === '/health') return next();
  if (!activeSession(request)) return response.status(401).json({ error: 'Please sign in to access the analytics.' });
  return next();
});

app.post('/api/usage/page-view', (request, response) => {
  const session = activeSession(request);
  const section = String(request.body?.section || '').trim().toLowerCase();
  const allowedSections = new Set(['schemes', 'quartiles', 'peers', 'overlap', 'changes', 'drivers', 'assistant', 'admin']);
  if (!allowedSections.has(section)) return response.status(400).json({ error: 'Unknown dashboard section.' });
  logUsage(session.user.user_id, 'page_view', section);
  response.status(204).end();
});

function assistantDateYearsEarlier(dateString, years) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function assistantLatestOnOrBefore(points, dateString) {
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index].date <= dateString) return points[index];
  return null;
}

function assistantPreviousPoint(points, dateString) {
  const index = points.findIndex((point) => point.date === dateString);
  return index > 0 ? points[index - 1] : null;
}

function assistantReturn(points, years) {
  const end = points.at(-1);
  const start = end && assistantLatestOnOrBefore(points, assistantDateYearsEarlier(end.date, years));
  if (!end || !start || end.date === start.date || start.value <= 0 || end.value <= 0) return null;
  const days = daysBetween(start.date, end.date);
  const total = end.value / start.value;
  const value = years === 1 ? (total - 1) * 100 : (Math.pow(total, 365.2425 / days) - 1) * 100;
  return Number.isFinite(value) ? { percent: value, start_date: start.date, end_date: end.date } : null;
}

function assistantConsistency(fundHistory, benchmarkHistory) {
  const benchmarkByDate = new Map(benchmarkHistory.map((point) => [point.date, point.value]));
  const metrics = {};
  for (const years of [1, 2, 3, 4, 5]) {
    const fundReturns = [];
    const benchmarkReturns = [];
    let wins = 0;
    for (const end of fundHistory) {
      const benchmarkEnd = benchmarkByDate.get(end.date);
      if (!Number.isFinite(benchmarkEnd)) continue;
      let start = assistantLatestOnOrBefore(fundHistory, assistantDateYearsEarlier(end.date, years));
      while (start && !benchmarkByDate.has(start.date)) start = assistantPreviousPoint(fundHistory, start.date);
      if (!start || start.date === end.date || start.nav <= 0) continue;
      const days = daysBetween(start.date, end.date);
      if (days <= 0) continue;
      const annualisation = 365.2425 / days;
      const fundReturn = (Math.pow(end.nav / start.nav, annualisation) - 1) * 100;
      const benchmarkReturn = (Math.pow(benchmarkEnd / benchmarkByDate.get(start.date), annualisation) - 1) * 100;
      if (!Number.isFinite(fundReturn) || !Number.isFinite(benchmarkReturn)) continue;
      fundReturns.push(fundReturn); benchmarkReturns.push(benchmarkReturn);
      if (fundReturn > benchmarkReturn) wins += 1;
    }
    if (fundReturns.length) metrics[`${years}y`] = {
      average_fund_percent: fundReturns.reduce((sum, value) => sum + value, 0) / fundReturns.length,
      average_benchmark_percent: benchmarkReturns.reduce((sum, value) => sum + value, 0) / benchmarkReturns.length,
      consistency_percent: (wins / fundReturns.length) * 100,
      observations: fundReturns.length,
    };
  }
  return metrics;
}

function assistantPortfolioChange(schemeCode) {
  const portfolio = db.prepare(`SELECT p.portfolio_id FROM scheme_portfolio_mappings m JOIN holding_portfolios p ON p.portfolio_id=m.portfolio_id WHERE m.scheme_code=? LIMIT 1`).get(schemeCode);
  if (!portfolio) return null;
  const dates = db.prepare('SELECT DISTINCT as_of_date FROM portfolio_holdings WHERE portfolio_id=? ORDER BY as_of_date DESC LIMIT 2').all(portfolio.portfolio_id).map((row) => row.as_of_date);
  if (dates.length < 2) return null;
  const rows = db.prepare('SELECT as_of_date,instrument_name,isin,weight,asset_class FROM portfolio_holdings WHERE portfolio_id=? AND as_of_date IN (?,?) AND isin IS NOT NULL AND weight IS NOT NULL').all(portfolio.portfolio_id, dates[0], dates[1]);
  const current = new Map(rows.filter((row) => row.as_of_date === dates[0]).map((row) => [row.isin, row]));
  const previous = new Map(rows.filter((row) => row.as_of_date === dates[1]).map((row) => [row.isin, row]));
  const additions = [...current.entries()].filter(([isin]) => !previous.has(isin)).map(([, row]) => row).sort((a, b) => b.weight - a.weight);
  const exits = [...previous.entries()].filter(([isin]) => !current.has(isin)).map(([, row]) => row).sort((a, b) => b.weight - a.weight);
  return { current_date: dates[0], previous_date: dates[1], new_holding_count: additions.length, exited_holding_count: exits.length, largest_additions: additions.slice(0, 5), largest_exits: exits.slice(0, 5) };
}

function assistantPortfolioOverlap(schemes) {
  if (schemes.length !== 2) return null;
  const snapshots = schemes.map((scheme) => db.prepare(`SELECT h.as_of_date,h.instrument_name,h.isin,h.weight,h.industry_or_rating FROM scheme_portfolio_mappings m JOIN portfolio_holdings h ON h.portfolio_id=m.portfolio_id WHERE m.scheme_code=? AND h.as_of_date=(SELECT MAX(h2.as_of_date) FROM portfolio_holdings h2 WHERE h2.portfolio_id=m.portfolio_id) AND h.isin IS NOT NULL AND h.weight IS NOT NULL`).all(scheme.scheme_code));
  if (!snapshots[0].length || !snapshots[1].length) return null;
  const right = new Map(snapshots[1].map((row) => [row.isin, row]));
  const common = snapshots[0].filter((row) => right.has(row.isin)).map((row) => ({ holding: row.instrument_name, isin: row.isin, first_weight: row.weight, second_weight: right.get(row.isin).weight, common_weight: Math.min(row.weight, right.get(row.isin).weight) })).sort((a, b) => b.common_weight - a.common_weight);
  return { first_fund: schemes[0].name, second_fund: schemes[1].name, common_holding_overlap_percent: common.reduce((sum, row) => sum + row.common_weight, 0) * 100, common_holdings: common.slice(0, 10) };
}

function assistantNavMovement(schemeCode) {
  const priceDate = db.prepare('SELECT MAX(p.date) AS date FROM nse_equity_price_daily p JOIN nav_daily n ON n.scheme_code=? AND n.date=p.date').get(schemeCode)?.date;
  if (!priceDate) return null;
  const portfolio = db.prepare(`SELECT m.portfolio_id,MAX(h.as_of_date) AS as_of_date FROM scheme_portfolio_mappings m JOIN portfolio_holdings h ON h.portfolio_id=m.portfolio_id WHERE m.scheme_code=? AND h.as_of_date<=? GROUP BY m.portfolio_id ORDER BY as_of_date DESC LIMIT 1`).get(schemeCode, priceDate);
  if (!portfolio) return null;
  const rows = db.prepare(`SELECT h.instrument_name,h.isin,h.weight,px.close_price,px.previous_close_price FROM portfolio_holdings h JOIN nse_equity_price_daily px ON px.isin=UPPER(TRIM(h.isin)) AND px.date=? WHERE h.portfolio_id=? AND h.as_of_date=? AND h.weight IS NOT NULL AND px.previous_close_price>0`).all(priceDate, portfolio.portfolio_id, portfolio.as_of_date)
    .map((row) => ({ ...row, stock_return_percent: ((row.close_price / row.previous_close_price) - 1) * 100, estimated_nav_impact_pp: row.weight * ((row.close_price / row.previous_close_price) - 1) * 100 }))
    .filter((row) => Number.isFinite(row.estimated_nav_impact_pp));
  return { date: priceDate, disclosure_date: portfolio.as_of_date, positive_drivers: rows.filter((row) => row.estimated_nav_impact_pp > 0).sort((a, b) => b.estimated_nav_impact_pp - a.estimated_nav_impact_pp).slice(0, 8), negative_drivers: rows.filter((row) => row.estimated_nav_impact_pp < 0).sort((a, b) => a.estimated_nav_impact_pp - b.estimated_nav_impact_pp).slice(0, 8) };
}

function assistantQuartileLabel(category) {
  return String(category || '').replace(/^(Equity|Debt|Hybrid) Schemes? - /i, '').replace(/^Index Funds - (Equity|Debt) - /i, '').trim();
}

function assistantQuartile(scheme, years) {
  const label = assistantQuartileLabel(scheme.category);
  if (!label) return null;
  const categories = db.prepare('SELECT DISTINCT category FROM schemes WHERE category IS NOT NULL').all().map((row) => row.category).filter((category) => assistantQuartileLabel(category) === label);
  if (!categories.length) return null;
  const rows = db.prepare(`WITH latest AS (SELECT s.scheme_code,s.name,s.amc,s.category,(SELECT nav FROM nav_daily WHERE scheme_code=s.scheme_code ORDER BY date DESC LIMIT 1) latest_nav,(SELECT date FROM nav_daily WHERE scheme_code=s.scheme_code ORDER BY date DESC LIMIT 1) latest_date FROM schemes s WHERE s.category IN (${categories.map(() => '?').join(',')})) SELECT l.*,(SELECT nav FROM nav_daily WHERE scheme_code=l.scheme_code AND date<=date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) start_nav,(SELECT date FROM nav_daily WHERE scheme_code=l.scheme_code AND date<=date(l.latest_date, printf('-%d years', ?)) ORDER BY date DESC LIMIT 1) start_date FROM latest l WHERE latest_nav IS NOT NULL`).all(...categories, years, years)
    .filter((row) => quartilePlanType(row.name) && row.start_nav > 0 && row.start_date)
    .map((row) => ({ ...row, value: years === 1 ? ((row.latest_nav / row.start_nav) - 1) * 100 : (Math.pow(row.latest_nav / row.start_nav, 365.2425 / daysBetween(row.start_date, row.latest_date)) - 1) * 100 }))
    .filter((row) => Number.isFinite(row.value));
  const families = new Map();
  for (const row of rows) {
    const type = quartilePlanType(row.name); const key = `${row.amc}|${planFamily(row.name)}`; const entry = families.get(key) || { direct: null, regular: null };
    if (!entry[type] || row.latest_date > entry[type].latest_date || (row.latest_date === entry[type].latest_date && explicitPlanPreference(row.name, type) > explicitPlanPreference(entry[type].name, type))) entry[type] = row;
    families.set(key, entry);
  }
  const ranked = [...families.values()].map((entry) => ({ ...entry, name: (entry.direct || entry.regular).name, amc: (entry.direct || entry.regular).amc, ranking_value: (entry.direct || entry.regular).value })).sort((a, b) => b.ranking_value - a.ranking_value);
  const displayed = []; const amcs = new Set();
  for (const entry of ranked) if (entry.amc && !amcs.has(entry.amc) && displayed.length < 20) { displayed.push(entry); amcs.add(entry.amc); }
  const base = Math.floor(displayed.length / 4); const remainder = displayed.length % 4; let offset = 0;
  for (let index = 0; index < 4; index += 1) { const size = base + (index < remainder ? 1 : 0); const group = displayed.slice(offset, offset + size); offset += size; if (group.some((entry) => entry.direct?.scheme_code === scheme.scheme_code || entry.regular?.scheme_code === scheme.scheme_code)) return { period: years === 1 ? '1Y return' : `${years}Y CAGR`, basis: 'Net return', subcategory: label, quartile: `Q${index + 1}`, displayed_amcs: displayed.length, fund_return_percent: group.find((entry) => entry.direct?.scheme_code === scheme.scheme_code || entry.regular?.scheme_code === scheme.scheme_code).ranking_value }; }
  return null;
}

function assistantSchemeMetrics(scheme, includeHoldings) {
  const navHistory = db.prepare('SELECT date,nav FROM nav_daily WHERE scheme_code=? ORDER BY date').all(scheme.scheme_code);
  const points = navHistory.map((row) => ({ date: row.date, value: row.nav }));
  const reportedBenchmark = db.prepare(`SELECT a.benchmark_name FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key=m.source_scheme_key WHERE m.scheme_code=? AND TRIM(COALESCE(a.benchmark_name,''))<>'' ORDER BY a.date DESC LIMIT 1`).get(scheme.scheme_code)?.benchmark_name || null;
  const mappedBenchmark = db.prepare(`SELECT b.benchmark_id,b.name FROM category_benchmark_defaults d JOIN benchmarks b ON b.benchmark_id=d.benchmark_id WHERE d.category=? LIMIT 1`).get(scheme.category) || null;
  const benchmarkHistory = mappedBenchmark ? db.prepare('SELECT date,value FROM benchmark_nav_daily WHERE benchmark_id=? ORDER BY date').all(mappedBenchmark.benchmark_id) : [];
  const benchmarkIsUsable = Boolean(mappedBenchmark && benchmarkHistory.length && (!reportedBenchmark || benchmarkNamesMatch(mappedBenchmark.name, reportedBenchmark)));
  const planType = growthPlanType(scheme.name);
  return {
    latest_nav: points.at(-1) ? { nav: points.at(-1).value, date: points.at(-1).date } : null,
    point_to_point_returns: { one_year: assistantReturn(points, 1), three_year_cagr: assistantReturn(points, 3), five_year_cagr: assistantReturn(points, 5) },
    benchmark: mappedBenchmark ? { name: mappedBenchmark.name, usable_for_comparison: benchmarkIsUsable, reported_name: reportedBenchmark } : null,
    consistency: benchmarkIsUsable ? assistantConsistency(navHistory, benchmarkHistory) : null,
    latest_factsheet: db.prepare('SELECT as_of_date,exit_load_text FROM scheme_factsheet_snapshots WHERE scheme_code=? ORDER BY as_of_date DESC LIMIT 1').get(scheme.scheme_code) || null,
    latest_factsheet_risk: db.prepare('SELECT as_of_date,metric_window,sharpe_ratio,beta,tracking_error_percent,upside_capture_percent,downside_capture_percent,standard_deviation_percent,benchmark_name FROM scheme_factsheet_risk_snapshots WHERE scheme_code=? ORDER BY as_of_date DESC LIMIT 1').get(scheme.scheme_code) || null,
    latest_debt_quants: db.prepare('SELECT as_of_date,modified_duration_years,average_maturity_years,residual_maturity_years,yield_to_maturity_percent,macaulay_duration_years,standard_deviation_percent FROM scheme_debt_quant_snapshots WHERE scheme_code=? ORDER BY as_of_date DESC LIMIT 1').get(scheme.scheme_code) || null,
    latest_aum: db.prepare(`SELECT a.date,a.daily_aum_crore FROM scheme_total_aum_mappings m JOIN scheme_total_aum_daily a ON a.source_scheme_key=m.source_scheme_key WHERE m.scheme_code=? ORDER BY a.date DESC LIMIT 1`).get(scheme.scheme_code) || null,
    latest_ter: planType ? db.prepare(`SELECT t.date,${planType}_ter AS ter_percent FROM scheme_ter_mappings m JOIN scheme_ter_daily t ON t.source_scheme_key=m.source_scheme_key WHERE m.scheme_code=? ORDER BY t.date DESC LIMIT 1`).get(scheme.scheme_code) || null : null,
    latest_holdings: includeHoldings ? db.prepare(`SELECT h.as_of_date,h.instrument_name,h.asset_class,h.weight,h.industry_or_rating FROM portfolio_holdings h JOIN scheme_portfolio_mappings m ON m.portfolio_id=h.portfolio_id WHERE m.scheme_code=? AND h.as_of_date=(SELECT MAX(h2.as_of_date) FROM portfolio_holdings h2 WHERE h2.portfolio_id=m.portfolio_id) ORDER BY h.weight DESC LIMIT 10`).all(scheme.scheme_code) : [],
    portfolio_change: includeHoldings ? assistantPortfolioChange(scheme.scheme_code) : null,
  };
}

function schemeContextForAssistant(question) {
  const words = [...new Set(String(question || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter((word) => !new Set(['what', 'which', 'where', 'when', 'with', 'from', 'have', 'does', 'fund', 'scheme', 'about', 'tell', 'explain', 'please', 'return', 'returns']).has(word))
    .slice(0, 6);
  if (!words.length) return [];
  // Questions naturally contain ordinary words such as “information” or
  // “available”. Match any meaningful name fragment rather than requiring
  // every fragment to occur in the official scheme title.
  const clauses = words.map(() => 'lower(s.name) LIKE ?').join(' OR ');
  const candidates = db.prepare(`SELECT s.scheme_code,s.name,s.amc,s.category,
      (SELECT n.nav FROM nav_daily n WHERE n.scheme_code=s.scheme_code ORDER BY n.date DESC LIMIT 1) AS latest_nav,
      (SELECT n.date FROM nav_daily n WHERE n.scheme_code=s.scheme_code ORDER BY n.date DESC LIMIT 1) AS latest_nav_date
    FROM schemes s WHERE ${clauses}`).all(...words.map((word) => `%${word}%`));
  const requiredMatches = Math.min(words.length, 2);
  const isComparison = /\b(vs|versus|compare|better|consistency|than|or|overlap|common)\b/i.test(question);
  const includeHoldings = /\b(holding|holdings|portfolio|stock|sector|bond|credit|change|added|exit|exited|increase|decrease)\b/i.test(question);
  const ranked = candidates
    .map((scheme) => ({ ...scheme, assistant_match_score: words.filter((word) => scheme.name.toLowerCase().includes(word)).length, assistant_plan_score: /\bgrowth\b/i.test(scheme.name) ? (/\bdirect\b/i.test(scheme.name) ? 2 : 1) : 0 }))
    .filter((scheme) => scheme.assistant_match_score >= requiredMatches)
    .sort((left, right) => right.assistant_match_score - left.assistant_match_score || right.assistant_plan_score - left.assistant_plan_score || String(right.latest_nav_date || '').localeCompare(String(left.latest_nav_date || '')));
  const schemes = [];
  const amcs = new Set();
  for (const candidate of ranked) {
    if (isComparison && amcs.has(candidate.amc)) continue;
    schemes.push(candidate); amcs.add(candidate.amc);
    if (schemes.length >= (isComparison ? 2 : 1)) break;
  }
  const selected = schemes.map(({ assistant_match_score, assistant_plan_score, ...scheme }) => ({ ...scheme, verified_metrics: assistantSchemeMetrics(scheme, includeHoldings) }));
  const quartileYears = /\b5\s*(?:year|yr)|5y\b/i.test(question) ? 5 : /\b3\s*(?:year|yr)|3y\b/i.test(question) ? 3 : 1;
  const asksQuartile = /\b(quartile|q[1-4]|rank)\b/i.test(question);
  const asksGrossQuartile = /\b(gross|before ter)\b/i.test(question);
  return { schemes: selected, overlap: /\b(overlap|common holding|common holdings)\b/i.test(question) ? assistantPortfolioOverlap(selected) : null, nav_movement: /\b(nav movement|nav driver|moved nav|why.*nav|nav.*why)\b/i.test(question) && selected[0] ? assistantNavMovement(selected[0].scheme_code) : null, quartiles: asksQuartile ? (asksGrossQuartile ? { status: 'unavailable', reason: 'Gross-before-TER quartile coverage is not yet connected to the assistant.' } : selected.map((scheme) => ({ scheme_code: scheme.scheme_code, name: scheme.name, result: assistantQuartile(scheme, quartileYears) }))) : null };
}

app.post('/api/assistant/chat', async (request, response) => {
  const session = activeSession(request);
  const question = String(request.body?.question || '').trim().replace(/\s+/g, ' ');
  const language = request.body?.language === 'gu' ? 'Gujarati' : 'English';
  if (question.length < 3 || question.length > 800) return response.status(400).json({ error: 'Ask one question between 3 and 800 characters.' });
  const assistantData = schemeContextForAssistant(question);
  const schemeContext = assistantData.schemes;
  const context = JSON.stringify({
    retrieved_at: new Date().toISOString(),
    matched_schemes: schemeContext,
    verified_pair_analysis: assistantData.overlap,
    verified_nav_movement: assistantData.nav_movement,
    verified_quartiles: assistantData.quartiles,
    note: 'Only the supplied records are verified dashboard data. A missing field means it is not available in the dashboard.',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const ollamaResponse = await fetch(`${localLlmBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: localLlmModel,
        stream: false,
        options: { temperature: 0.2, num_predict: 220 },
        messages: [
          { role: 'system', content: `You are the internal Fund Insights assistant. Answer only from the supplied dashboard context. Never invent a number, source, date, holding, fact, or calculation. The verified_metrics field contains exact calculations from the local dashboard: use those values directly whenever they answer the question. If context does not contain what is needed, say that clearly and suggest the relevant dashboard section. Do not give buy, sell, or investment recommendations. Keep answers concise, explain financial terms simply, and retain numeric values exactly. Your response language is strictly ${language}: write every explanatory word in ${language}, with no mixture of another language. Numbers, dates, ISINs, scheme codes and tickers may remain in English characters.` },
          { role: 'user', content: `Question: ${question}\n\nDashboard context: ${context}` },
        ],
      }),
    });
    const payload = await ollamaResponse.json().catch(() => ({}));
    if (!ollamaResponse.ok || !payload?.message?.content) throw new Error(payload?.error || `Local AI returned HTTP ${ollamaResponse.status}`);
    const answer = String(payload.message.content).trim();
    db.prepare("DELETE FROM app_assistant_chats WHERE created_at < datetime('now', '-90 days')").run();
    db.prepare('INSERT INTO app_assistant_chats (user_id,question,answer,language,verified_data_json) VALUES (?,?,?,?,?)')
      .run(session.user.user_id, question, answer, language === 'Gujarati' ? 'gu' : 'en', JSON.stringify(assistantData));
    logUsage(session.user.user_id, 'page_view', 'assistant');
    response.json({ answer, matchedSchemes: schemeContext.map(({ scheme_code, name }) => ({ scheme_code, name })), verified: assistantData });
  } catch (error) {
    const unavailable = error.name === 'AbortError'
      ? 'The local AI took too long to respond. Please try again.'
      : `The local AI is unavailable. Make sure Ollama is running and model ${localLlmModel} is installed.`;
    response.status(503).json({ error: unavailable });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/api/assistant/history', (request, response) => {
  const session = activeSession(request);
  db.prepare("DELETE FROM app_assistant_chats WHERE created_at < datetime('now', '-90 days')").run();
  const chats = db.prepare(`SELECT chat_id,question,answer,language,verified_data_json,created_at
    FROM app_assistant_chats WHERE user_id=? ORDER BY chat_id DESC LIMIT 50`).all(session.user.user_id).reverse().map((chat) => ({
    ...chat,
    verified: chat.verified_data_json ? JSON.parse(chat.verified_data_json) : null,
  }));
  response.json({ retention_days: 90, chats });
});

app.get('/api/admin/users', requireSuperAdmin, (request, response) => {
  const users = db.prepare(`SELECT user_id,username,full_name,email,role,status,requested_at,approved_at,updated_at
    FROM app_users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, requested_at DESC`).all();
  response.json({ users });
});

app.get('/api/admin/usage', requireSuperAdmin, (request, response) => {
  const rawDays = Number(request.query.days || 30);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 90) : 30;
  const cutoff = `-${days - 1} days`;
  const query = String(request.query.q || '').trim().slice(0, 100);
  const userFilter = query ? `AND (lower(u.username) LIKE lower(?) OR lower(u.full_name) LIKE lower(?) OR lower(COALESCE(u.email,'')) LIKE lower(?))` : '';
  const userParams = query ? [cutoff, `%${query}%`, `%${query}%`, `%${query}%`] : [cutoff];
  const totals = db.prepare(`SELECT
      COUNT(*) AS events,
      COUNT(DISTINCT e.user_id) AS active_users,
      SUM(CASE WHEN e.event_type='login' THEN 1 ELSE 0 END) AS logins
    FROM app_usage_events e JOIN app_users u ON u.user_id=e.user_id
    WHERE e.created_at >= datetime('now', ?) AND u.role <> 'super_admin'`)
    .get(cutoff);
  const daily = db.prepare(`SELECT date(e.created_at) AS date, COUNT(DISTINCT e.user_id) AS active_users,
      SUM(CASE WHEN e.event_type='login' THEN 1 ELSE 0 END) AS logins
    FROM app_usage_events e JOIN app_users u ON u.user_id=e.user_id
    WHERE e.created_at >= datetime('now', ?) AND u.role <> 'super_admin'
    GROUP BY date(e.created_at) ORDER BY date ASC`).all(cutoff);
  const events = db.prepare(`SELECT e.event_type,e.event_value,e.created_at,u.username,u.full_name
    FROM app_usage_events e JOIN app_users u ON u.user_id=e.user_id
    WHERE e.created_at >= datetime('now', ?) AND u.role <> 'super_admin' ${userFilter}
    ORDER BY e.event_id DESC LIMIT 300`).all(...userParams);
  const grouped = { login: [], logout: [], page_view: [] };
  for (const event of events) grouped[event.event_type]?.push(event);
  response.json({ days, query, totals: { events: Number(totals.events || 0), active_users: Number(totals.active_users || 0), logins: Number(totals.logins || 0) }, daily, events: grouped });
});

app.post('/api/admin/users/:userId/approve', requireSuperAdmin, (request, response) => {
  const userId = Number(request.params.userId);
  const user = db.prepare('SELECT user_id,role,status FROM app_users WHERE user_id=?').get(userId);
  if (!user) return response.status(404).json({ error: 'User not found.' });
  if (user.role === 'super_admin') return response.status(400).json({ error: 'The Super Admin account cannot be changed here.' });
  db.prepare(`UPDATE app_users SET status='approved',approved_at=CURRENT_TIMESTAMP,approved_by_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(request.superAdmin.user_id, userId);
  response.json({ message: 'User approved.' });
});

app.post('/api/admin/users/:userId/reject', requireSuperAdmin, (request, response) => {
  const userId = Number(request.params.userId);
  const user = db.prepare('SELECT user_id,role FROM app_users WHERE user_id=?').get(userId);
  if (!user) return response.status(404).json({ error: 'User not found.' });
  if (user.role === 'super_admin') return response.status(400).json({ error: 'The Super Admin account cannot be changed here.' });
  db.prepare(`UPDATE app_users SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(userId);
  invalidateUserSessions(userId);
  response.json({ message: 'Request rejected.' });
});

app.post('/api/admin/users/:userId/suspend', requireSuperAdmin, (request, response) => {
  const userId = Number(request.params.userId);
  const user = db.prepare('SELECT user_id,role FROM app_users WHERE user_id=?').get(userId);
  if (!user) return response.status(404).json({ error: 'User not found.' });
  if (user.role === 'super_admin') return response.status(400).json({ error: 'The Super Admin account cannot be changed here.' });
  db.prepare(`UPDATE app_users SET status='suspended',updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(userId);
  invalidateUserSessions(userId);
  response.json({ message: 'User suspended.' });
});

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function xmlField(xml, field) {
  return decodeXml(new RegExp(`<${field}(?:\\s[^>]*)?>([\\s\\S]*?)</${field}>`, 'i').exec(xml)?.[1]);
}

async function sectorHeadlines(indexName, date) {
  const cacheKey = `${indexName}|${date}`;
  const cached = marketNewsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.articles;
  const start = new Date(`${date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  const search = `${indexName} India stock market after:${start.toISOString().slice(0, 10)} before:${end.toISOString().slice(0, 10)}`;
  const sourceUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(search)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'Fund-Analysis/0.1 (local)' } });
  if (!response.ok) throw new Error(`News feed returned HTTP ${response.status}`);
  const xml = await response.text();
  const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 2).map((match) => {
    const item = match[1];
    return { title: xmlField(item, 'title'), url: xmlField(item, 'link'), published_at: xmlField(item, 'pubDate'), publisher: xmlField(item, 'source') || 'News source' };
  }).filter((article) => article.title && article.url);
  marketNewsCache.set(cacheKey, { expiresAt: Date.now() + (30 * 60 * 1000), articles });
  return articles;
}

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

app.get('/api/schemes/:schemeCode/holdings/history', (request, response) => {
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

  const dates = db.prepare(`
    SELECT DISTINCT as_of_date
    FROM portfolio_holdings
    WHERE portfolio_id = ?
    ORDER BY as_of_date DESC
    LIMIT 2
  `).all(portfolio.portfolio_id).map((row) => row.as_of_date);
  const positions = db.prepare(`
    SELECT asset_class, holding_group, instrument_name, isin, industry_or_rating,
      quantity, market_value_lakh, weight, yield, yield_to_call
    FROM portfolio_holdings
    WHERE portfolio_id = ? AND as_of_date = ?
    ORDER BY position_order
  `);
  // Raw snapshots only. All change calculations remain in the browser.
  response.json({
    portfolio,
    snapshots: dates.map((as_of_date) => ({ as_of_date, holdings: positions.all(portfolio.portfolio_id, as_of_date) })),
  });
});

app.get('/api/schemes/:schemeCode/nav-drivers', (request, response) => {
  const scheme = db.prepare('SELECT scheme_code, name, amc FROM schemes WHERE scheme_code = ?').get(request.params.schemeCode);
  if (!scheme) return response.status(404).json({ error: 'Scheme not found.' });
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.date || '')) ? String(request.query.date) : null;
  const priceDate = requestedDate || db.prepare(`
    SELECT MAX(p.date) AS date FROM nse_equity_price_daily p
    JOIN nav_daily n ON n.scheme_code = ? AND n.date = p.date
  `).get(scheme.scheme_code).date;
  if (!priceDate) return response.status(404).json({ error: 'No aligned NSE price and fund NAV date is available yet.' });
  const navPoints = db.prepare(`SELECT date, nav FROM nav_daily WHERE scheme_code = ? AND date <= ? ORDER BY date DESC LIMIT 2`).all(scheme.scheme_code, priceDate);
  if (navPoints.length < 2 || navPoints[0].date !== priceDate) return response.status(404).json({ error: 'Fund NAV is unavailable for the selected price date.' });
  const portfolio = db.prepare(`
    SELECT p.portfolio_id, p.amc, p.name, MAX(h.as_of_date) AS as_of_date
    FROM scheme_portfolio_mappings m JOIN holding_portfolios p ON p.portfolio_id = m.portfolio_id
    JOIN portfolio_holdings h ON h.portfolio_id = p.portfolio_id
    WHERE m.scheme_code = ? AND h.as_of_date <= ?
    GROUP BY p.portfolio_id, p.amc, p.name ORDER BY as_of_date DESC LIMIT 1
  `).get(scheme.scheme_code, priceDate);
  if (!portfolio) return response.status(404).json({ error: 'No portfolio disclosure preceding this NAV date is available.' });
  const positions = db.prepare(`
    SELECT h.instrument_name, h.isin, h.weight, h.asset_class, h.holding_group, h.industry_or_rating,
      px.symbol, px.close_price, px.previous_close_price
    FROM portfolio_holdings h LEFT JOIN nse_equity_price_daily px ON px.isin = UPPER(TRIM(h.isin)) AND px.date = ?
    WHERE h.portfolio_id = ? AND h.as_of_date = ? ORDER BY h.position_order
  `).all(priceDate, portfolio.portfolio_id, portfolio.as_of_date);
  response.json({ scheme, date: priceDate, nav: navPoints[0], previous_nav: navPoints[1], portfolio, positions });
});

app.get('/api/market-sector-pulse', (request, response) => {
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.date || '')) ? String(request.query.date) : null;
  const date = requestedDate || db.prepare('SELECT MAX(date) AS date FROM nse_index_close_daily').get().date;
  if (!date) return response.status(404).json({ error: 'No NSE sector-index report has been imported yet.' });
  const rows = db.prepare(`
    SELECT index_name, date, close_value, points_change, percent_change, source_url
    FROM nse_index_close_daily WHERE date = ? ORDER BY percent_change DESC
  `).all(date);
  if (!rows.length) return response.status(404).json({ error: 'No NSE sector-index report is available for this date.' });
  response.json({ date, sectors: rows });
});

app.get('/api/market-sector-news', async (request, response) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.date || '')) ? String(request.query.date) : db.prepare('SELECT MAX(date) AS date FROM nse_index_close_daily').get().date;
  if (!date) return response.status(404).json({ error: 'No NSE sector-index report has been imported yet.' });
  const rows = db.prepare(`SELECT index_name, percent_change FROM nse_index_close_daily WHERE date = ? ORDER BY percent_change DESC`).all(date);
  if (!rows.length) return response.status(404).json({ error: 'No NSE sector-index report is available for this date.' });
  const selected = [...rows.slice(0, 3), ...rows.slice(-3).reverse()].filter((row, index, items) => items.findIndex((item) => item.index_name === row.index_name) === index);
  const sectors = await Promise.all(selected.map(async (sector) => ({
    ...sector,
    articles: await sectorHeadlines(sector.index_name, date).catch(() => []),
  })));
  response.json({ date, sectors });
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
  const factsheet = db.prepare(`
    SELECT as_of_date, source_amc, exit_load_text, source_url
    FROM scheme_factsheet_snapshots
    WHERE scheme_code = ?
    ORDER BY as_of_date DESC
    LIMIT 1
  `).get(scheme.scheme_code);
  const managers = factsheet ? db.prepare(`
    SELECT manager_name, managing_since, experience_years
    FROM scheme_factsheet_managers
    WHERE scheme_code = ? AND as_of_date = ?
    ORDER BY manager_name COLLATE NOCASE
  `).all(scheme.scheme_code, factsheet.as_of_date) : [];
  const debtQuants = factsheet ? db.prepare(`
    SELECT modified_duration_years, average_maturity_years, residual_maturity_years,
      yield_to_maturity_percent, macaulay_duration_years,
      standard_deviation_percent
    FROM scheme_debt_quant_snapshots
    WHERE scheme_code = ? AND as_of_date = ?
  `).get(scheme.scheme_code, factsheet.as_of_date) : null;
  const factsheetRisk = db.prepare(`
    SELECT as_of_date, metric_window, sharpe_ratio, beta, tracking_error_percent,
      upside_capture_percent, downside_capture_percent, standard_deviation_percent,
      benchmark_name, source_url
    FROM scheme_factsheet_risk_snapshots
    WHERE scheme_code = ?
    ORDER BY as_of_date DESC,
      CASE WHEN metric_window LIKE '3Y%' THEN 0 ELSE 1 END,
      metric_window
  `).all(scheme.scheme_code);

  response.json({
    aaum,
    ter,
    factsheet: factsheet ? { ...factsheet, managers, debt_quants: debtQuants, risk_metrics: factsheetRisk } : null,
  });
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
    // Growth NAV should be continuous. A very large one-day move is not an
    // investment return; it indicates a historical source/mapping break (for
    // example, two differently scaled NAV series joined under one scheme code).
    // Do not allow such a series to distort a category quartile.
    if (schemes.length) {
      const startDateByCode = new Map(schemes.map((scheme) => [scheme.scheme_code, scheme.start_date]));
      const discontinuousCodes = new Set(db.prepare(`
        WITH ordered_nav AS (
          SELECT scheme_code, date, nav,
            LAG(nav) OVER (PARTITION BY scheme_code ORDER BY date) AS prior_nav
          FROM nav_daily
          WHERE scheme_code IN (${schemes.map(() => '?').join(', ')})
        )
        SELECT ordered_nav.scheme_code, ordered_nav.date
        FROM ordered_nav
        WHERE ordered_nav.date <= ?
          AND prior_nav > 0
          AND (nav / prior_nav > 1.5 OR nav / prior_nav < (1.0 / 1.5))
      `).all(
        ...schemes.map((scheme) => scheme.scheme_code),
        effectiveAsOfDate,
      ).filter((row) => row.date > startDateByCode.get(row.scheme_code)).map((row) => row.scheme_code));
      schemes = schemes.filter((scheme) => !discontinuousCodes.has(scheme.scheme_code));
    }
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
  const excludedSchemes = [];
  schemes = schemes.filter((scheme) => {
    const mismatch = scheme.reported_benchmark_name && !benchmarkNamesMatch(benchmark.name, scheme.reported_benchmark_name);
    if (mismatch) {
      benchmarkMismatchCount += 1;
      excludedSchemes.push({
        ...scheme,
        exclusion_reason: 'different_reported_benchmark',
      });
    }
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
  response.json({ category, categories: requestedCategories, plan, benchmark, benchmark_mismatch_count: benchmarkMismatchCount, excluded_schemes: dedupePeerSchemes(excludedSchemes, plan), schemes, histories, benchmark_history: benchmarkHistory });
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
