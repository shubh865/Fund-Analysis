const db = require('../server/db');
const AMC = 'HDFC Mutual Fund';
const SOURCE_URL = 'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio';
function family(name) { return String(name || '').toUpperCase().replace(/\bHDFC\b/g, ' ').replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
const portfolios = db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?').all(AMC);
const schemes = db.prepare("SELECT scheme_code, name FROM schemes WHERE amc = ? AND LOWER(name) LIKE '%growth%'").all(AMC);
const byFamily = new Map(portfolios.map((portfolio) => [family(portfolio.name), portfolio]));
const upsert = db.prepare(`INSERT INTO scheme_portfolio_mappings (scheme_code, portfolio_id, mapping_status, source_url) VALUES (?, ?, 'provisional', ?) ON CONFLICT(scheme_code) DO UPDATE SET portfolio_id = excluded.portfolio_id, mapping_status = excluded.mapping_status, source_url = excluded.source_url, updated_at = CURRENT_TIMESTAMP`);
const mapped = db.transaction(() => schemes.reduce((count, scheme) => { const portfolio = byFamily.get(family(scheme.name)); if (!portfolio) return count; upsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_URL); return count + 1; }, 0))();
console.log(`Provisionally mapped ${mapped} HDFC Growth plans to monthly disclosure portfolios by scheme family.`);
