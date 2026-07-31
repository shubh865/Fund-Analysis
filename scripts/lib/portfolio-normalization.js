function normalizedLabel(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normalizeHoldings(holdings, portfolioName) {
  const normalizedPortfolio = normalizedLabel(portfolioName);
  const cleaned = holdings.filter((holding) => {
    const instrument = normalizedLabel(holding.instrumentName);
    if (!instrument || /\b(?:SUB\s*)?TOTAL$/.test(instrument)) return false;
    if (/^(?:NET ASSETS?|GRAND TOTAL|BENCHMARK|NAV AS ON|NUMBER OF CONTRACTS?|GROSS NOTIONAL|AT THE END|INSTRUMENT TYPE)\b/.test(instrument)) return false;
    if (/\bRETURNS? ANNUALISED\b/.test(instrument)) return false;
    if (holding.weight != null && Math.abs(holding.weight) > 200) return false;
    return !(instrument.length >= 10 && normalizedPortfolio.startsWith(instrument));
  });

  const grossPublishedWeight = cleaned.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  const weightDivisor = grossPublishedWeight > 5 ? 100 : 1;
  const normalized = cleaned
    .map((holding) => ({
      ...holding,
      weight: holding.weight == null ? null : holding.weight / weightDivisor,
    }))
    .filter((holding) => holding.weight == null || Math.abs(holding.weight) <= 1.5);

  const grossNormalizedWeight = normalized.reduce((sum, holding) => sum + Math.abs(holding.weight || 0), 0);
  return grossNormalizedWeight <= 3 ? normalized : [];
}

module.exports = { normalizeHoldings };
