const db = require('../server/db');
const { normalizeDebtRate, isSectionTotalHolding } = require('./lib/portfolio-normalization');

const debtPortfolioIds = db.prepare(`
  SELECT DISTINCT p.portfolio_id
  FROM schemes s
  JOIN scheme_portfolio_mappings m ON m.scheme_code = s.scheme_code
  JOIN holding_portfolios p ON p.portfolio_id = m.portfolio_id
  WHERE s.category LIKE 'Debt Scheme%'
     OR s.category LIKE 'Income/Debt Oriented Schemes%'
     OR s.category IN ('Income', 'Gilt', 'Money Market')
`).all().map((row) => row.portfolio_id);

const selectRows = db.prepare(`
  SELECT portfolio_id, as_of_date, position_order, asset_class, holding_group,
    instrument_name, isin, industry_or_rating, quantity, market_value_lakh,
    weight, yield, yield_to_call
  FROM portfolio_holdings
  WHERE portfolio_id = ?
`);
const updateRates = db.prepare(`
  UPDATE portfolio_holdings
  SET yield = ?, yield_to_call = ?
  WHERE portfolio_id = ? AND as_of_date = ? AND position_order = ?
`);
const deleteRow = db.prepare(`
  DELETE FROM portfolio_holdings
  WHERE portfolio_id = ? AND as_of_date = ? AND position_order = ?
`);
const scaleNonDerivativeWeights = db.prepare(`
  UPDATE portfolio_holdings
  SET weight = weight * 100
  WHERE portfolio_id = ? AND as_of_date = ? AND weight IS NOT NULL
    AND UPPER(COALESCE(asset_class, '')) NOT LIKE '%DERIVATIVE%'
`);
const scaleSelectedWeights = db.prepare(`
  UPDATE portfolio_holdings
  SET weight = weight * 100
  WHERE portfolio_id = ? AND as_of_date = ? AND weight IS NOT NULL
    AND ABS(weight) <= 0.01
`);
const selectPortfolio = db.prepare('SELECT amc, name FROM holding_portfolios WHERE portfolio_id = ?');

function normalizedName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function isStoredMetadataRow(row) {
  const name = normalizedName(row.instrument_name);
  const emptyEconomicRow = !row.isin && !row.quantity && !row.market_value_lakh && !row.weight;
  if (!name || emptyEconomicRow) return true;
  return /^(?:NET ASSETS?|GRAND TOTAL|BENCHMARK|NAV AS ON|NUMBER OF CONTRACTS?|GROSS NOTIONAL|AT THE END|INSTRUMENT TYPE)\b/.test(name)
    || /\bRETURNS? ANNUALISED\b/.test(name)
    || /\b(?:STANDARD DEVIATION|SHARPE RATIO|RISKOMETER|PORTFOLIO TURNOVER)\b/.test(name);
}

function holdingShape(row) {
  return {
    instrumentName: row.instrument_name,
    isin: row.isin,
    industryOrRating: row.industry_or_rating,
    quantity: row.quantity,
    marketValueLakh: row.market_value_lakh,
    weight: row.weight,
  };
}

function isCorruptPortfolioLabelRow(row, portfolioName) {
  return normalizedName(row.isin) === normalizedName(portfolioName)
    && /^\d+(?:\.\d+)?$/.test(String(row.industry_or_rating || '').trim());
}

function isGenericHeaderBlock(row) {
  return /^NAME OF INSTRUMENT$/i.test(String(row.holding_group || '').trim());
}

const result = db.transaction(() => {
  let inspected = 0;
  let deleted = 0;
  let rateUpdates = 0;
  let sectionTotalsDeleted = 0;
  let scaledSnapshots = 0;
  for (const portfolioId of debtPortfolioIds) {
    const portfolio = selectPortfolio.get(portfolioId);
    const rows = selectRows.all(portfolioId);
    const snapshots = new Map();
    for (const row of rows) {
      inspected += 1;
      const sectionTotal = isSectionTotalHolding(holdingShape(row));
      if (isStoredMetadataRow(row) || sectionTotal || isCorruptPortfolioLabelRow(row, portfolio.name) || isGenericHeaderBlock(row)) {
        deleted += deleteRow.run(row.portfolio_id, row.as_of_date, row.position_order).changes;
        if (sectionTotal) sectionTotalsDeleted += 1;
        continue;
      }
      const normalizedYield = normalizeDebtRate(row.yield);
      const normalizedYieldToCall = normalizeDebtRate(row.yield_to_call);
      if (normalizedYield !== row.yield || normalizedYieldToCall !== row.yield_to_call) {
        rateUpdates += updateRates.run(normalizedYield, normalizedYieldToCall,
          row.portfolio_id, row.as_of_date, row.position_order).changes;
      }
      const snapshot = snapshots.get(row.as_of_date) || [];
      snapshot.push(row);
      snapshots.set(row.as_of_date, snapshot);
    }
    for (const [asOfDate, snapshotRows] of snapshots) {
      const byIsin = new Map();
      for (const row of snapshotRows) {
        if (!/^IN[A-Z0-9]{10}$/i.test(String(row.isin || ''))) continue;
        const rows = byIsin.get(row.isin) || [];
        rows.push(row);
        byIsin.set(row.isin, rows);
      }
      for (const duplicateRows of byIsin.values()) {
        const gross = duplicateRows.reduce((sum, row) => sum + Math.abs(row.weight || 0), 0);
        if (duplicateRows.length <= 1 || gross <= 1.2) continue;
        for (const row of duplicateRows) deleted += deleteRow.run(row.portfolio_id, row.as_of_date, row.position_order).changes;
      }
      const datedReverseRepos = snapshotRows.filter((row) => /^REVERSE REPO\s*\([^)]+\)$/i.test(String(row.instrument_name || '').trim()));
      if (datedReverseRepos.length) {
        for (const row of snapshotRows.filter((candidate) => /^REVERSE REPO$/i.test(String(candidate.instrument_name || '').trim()))) {
          deleted += deleteRow.run(row.portfolio_id, row.as_of_date, row.position_order).changes;
        }
      }
    }
    for (const [asOfDate, snapshotRows] of snapshots) {
      const economicRows = snapshotRows.filter((row) => !/DERIVATIVE/i.test(String(row.asset_class || '')));
      const gross = economicRows.reduce((sum, row) => sum + Math.abs(row.weight || 0), 0);
      const validIsinCount = economicRows.filter((row) => /^IN[A-Z0-9]{10}$/i.test(String(row.isin || ''))).length;
      if (gross >= 0.005 && gross <= 0.05 && validIsinCount >= 10) {
        scaledSnapshots += scaleNonDerivativeWeights.run(portfolioId, asOfDate).changes > 0 ? 1 : 0;
      }
      if (portfolio.amc === 'Sundaram Mutual Fund' && gross >= 0.1 && gross <= 0.3) {
        const smallGross = economicRows.filter((row) => Math.abs(row.weight || 0) <= 0.01)
          .reduce((sum, row) => sum + Math.abs(row.weight || 0), 0);
        if (smallGross >= 0.005 && smallGross <= 0.02) {
          scaledSnapshots += scaleSelectedWeights.run(portfolioId, asOfDate).changes > 0 ? 1 : 0;
        }
      }
    }
  }
  return { portfolios: debtPortfolioIds.length, inspected, deleted, sectionTotalsDeleted, rateUpdates, scaledSnapshots };
})();

console.log(`Normalized ${result.portfolios} debt portfolios: inspected ${result.inspected} rows, updated ${result.rateUpdates} rate rows, removed ${result.deleted} invalid rows (${result.sectionTotalsDeleted} section totals), and corrected ${result.scaledSnapshots} weight snapshots.`);
