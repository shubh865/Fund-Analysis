function normalizedLabel(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normalizeDebtRate(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  return normalized >= 0.001 && normalized <= 0.5 ? normalized : null;
}

function isSectionTotalHolding(holding) {
  const instrument = normalizedLabel(holding.instrumentName);
  if (holding.isin || holding.industryOrRating) return false;
  return /^(?:GOVERNMENT SECURITIES|NON CONVERTIBLE DEBENTURES BONDS|CORPORATE DEBT SECURITIES|COMMERCIAL PAPER|CERTIFICATES? OF DEPOSIT|TREASURY BILLS?|MONEY MARKET INSTRUMENTS|PASS THROUGH CERTIFICATES|SECURITI[ZS]ED DEBT|FLOATING RATE NOTES|EQUITY SHARES|MUTUAL FUND UNITS|INTEREST RATE SWAPS?(?: AT NOTIONAL VALUE)?)$/.test(instrument);
}

function isDerivativeHolding(holding) {
  const label = [holding.assetClass, holding.holdingGroup, holding.instrumentName]
    .map(normalizedLabel).join(' ');
  return /\b(?:DERIVATIVES?|FUTURES?|OPTIONS?|SWAPS?|IRS|FORWARD CONTRACTS?)\b/.test(label);
}

function isMetadataHolding(holding) {
  const instrument = normalizedLabel(holding.instrumentName);
  if (!instrument) return true;
  const emptyEconomicRow = !holding.isin
    && !holding.quantity
    && !holding.marketValueLakh
    && !holding.weight;
  if (emptyEconomicRow) return true;
  return /^(?:NET ASSETS?|GRAND TOTAL|BENCHMARK|NAV AS ON|AS ON |NUMBER OF CONTRACTS?|GROSS NOTIONAL|AT THE END|INSTRUMENT TYPE|AGGREGATE DIVIDEND|PLAN OPTION)\b/.test(instrument)
    || /\bRETURNS? ANNUALISED\b/.test(instrument)
    || /\b(?:STANDARD DEVIATION|SHARPE RATIO|RISKOMETER|PORTFOLIO TURNOVER)\b/.test(instrument);
}

function normalizeHoldings(holdings, portfolioName) {
  const normalizedPortfolio = normalizedLabel(portfolioName);
  const cleaned = holdings.filter((holding) => {
    const instrument = normalizedLabel(holding.instrumentName);
    if (isMetadataHolding(holding) || isSectionTotalHolding(holding) || /\b(?:SUB\s*)?TOTAL$/.test(instrument)) return false;
    if (holding.weight != null && Math.abs(holding.weight) > 200) return false;
    return !(instrument.length >= 10 && normalizedPortfolio.startsWith(instrument));
  });

  const invalidDuplicateIsins = new Set();
  const byIsin = new Map();
  for (const holding of cleaned) {
    if (!/^IN[A-Z0-9]{10}$/i.test(String(holding.isin || ''))) continue;
    const rows = byIsin.get(holding.isin) || [];
    rows.push(holding);
    byIsin.set(holding.isin, rows);
  }
  for (const [isin, rows] of byIsin) {
    const gross = rows.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
    if (rows.length > 1 && gross > 1.2) invalidDuplicateIsins.add(isin);
  }
  const withoutInvalidBlocks = cleaned.filter((holding) => {
    if (/^NAME OF INSTRUMENT$/i.test(String(holding.holdingGroup || '').trim())) return false;
    return !invalidDuplicateIsins.has(holding.isin);
  });
  const hasDatedReverseRepo = withoutInvalidBlocks.some((holding) => /^REVERSE REPO\s*\([^)]+\)$/i.test(String(holding.instrumentName || '').trim()));
  const economicHoldings = withoutInvalidBlocks.filter((holding) => !(hasDatedReverseRepo
    && /^REVERSE REPO$/i.test(String(holding.instrumentName || '').trim())));

  const grossPublishedWeight = economicHoldings.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  const weightDivisor = grossPublishedWeight > 5 ? 100 : 1;
  const normalized = economicHoldings
    .map((holding) => ({
      ...holding,
      weight: holding.weight == null ? null : holding.weight / weightDivisor,
      yield: normalizeDebtRate(holding.yield),
      yieldToCall: normalizeDebtRate(holding.yieldToCall),
    }))
    .filter((holding) => holding.weight == null || Math.abs(holding.weight) <= 1.5);

  let grossNormalizedWeight = normalized.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  const validIsinCount = normalized.filter((holding) => /^IN[A-Z0-9]{10}$/i.test(String(holding.isin || ''))).length;
  if (grossNormalizedWeight >= 0.005 && grossNormalizedWeight <= 0.05 && validIsinCount >= 10) {
    for (const holding of normalized) {
      if (!isDerivativeHolding(holding) && holding.weight != null) holding.weight *= 100;
    }
    grossNormalizedWeight = normalized.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  }
  return grossNormalizedWeight <= 3 ? normalized : [];
}

module.exports = { isDerivativeHolding, isMetadataHolding, isSectionTotalHolding, normalizeDebtRate, normalizeHoldings };
