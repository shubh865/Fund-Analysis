const db = require('../server/db');

const AMC = 'Aditya Birla Sun Life Mutual Fund';
const SOURCE_URL = 'https://mutualfund.adityabirlacapital.com/forms-and-downloads/portfolio';

function portfolioFamily(name) {
  return String(name || '').toUpperCase()
    .replace(/\(ERSTWHILE[^)]*\)/g, ' ')
    .replace(/\bADITYA BIRLA SUN LIFE\b/g, ' ')
    .replace(/\bFLEXICAP\b/g, 'FLEXI CAP')
    .replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const portfolios = db.prepare('SELECT portfolio_id, name FROM holding_portfolios WHERE amc = ?').all(AMC);
const schemes = db.prepare("SELECT scheme_code, name FROM schemes WHERE amc LIKE '%Aditya Birla Sun Life%' AND LOWER(name) LIKE '%growth%'").all();
const portfoliosByFamily = new Map(portfolios.map((portfolio) => [portfolioFamily(portfolio.name), portfolio]));
const upsert = db.prepare(`
  INSERT INTO scheme_portfolio_mappings (scheme_code, portfolio_id, mapping_status, source_url)
  VALUES (?, ?, 'verified', ?)
  ON CONFLICT(scheme_code) DO UPDATE SET
    portfolio_id = excluded.portfolio_id,
    mapping_status = excluded.mapping_status,
    source_url = excluded.source_url,
    updated_at = CURRENT_TIMESTAMP
`);

const mapped = db.transaction(() => schemes.reduce((count, scheme) => {
  const portfolio = portfoliosByFamily.get(portfolioFamily(scheme.name));
  if (!portfolio) return count;
  upsert.run(scheme.scheme_code, portfolio.portfolio_id, SOURCE_URL);
  return count + 1;
}, 0))();

console.log(`Verified and mapped ${mapped} ABSL Growth plans to their monthly disclosure portfolios.`);
