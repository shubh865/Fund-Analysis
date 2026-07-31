const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://taurusmutualfund.com/index.php/monthly-portfolio';
async function fetchItems() {
  const response = await fetch(SOURCE_PAGE);
  if (!response.ok) throw new Error(`Taurus portfolio page returned ${response.status}.`);
  const html = await response.text();
  const yearOptions = new Map([...html.matchAll(/value="(\d+)">\s*(20\d{2})\s*<\/option>/gi)]
    .map((match) => [Number(match[2]), match[1]]));
  const monthOptions = new Map([...html.matchAll(/value="(\d+)">\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*<\/option>/gi)]
    .map((match) => [new Date(`${match[2]} 1, 2000 UTC`).getUTCMonth(), match[1]]));
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const yearId = yearOptions.get(year);
    const monthId = monthOptions.get(month);
    if (yearId && monthId) {
      const filteredUrl = `${SOURCE_PAGE}?field_monthly_portfolio_target_id=${yearId}&field_month_target_id=${monthId}`;
      const filteredResponse = await fetch(filteredUrl);
      if (filteredResponse.ok) {
        const filteredHtml = await filteredResponse.text();
        const asOfDate = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
        const items = [...filteredHtml.matchAll(/href="\s*([^"]+Monthly_Portfolio_Report_Performance_[A-Za-z]+_\d{4}\.xlsx)"/gi)]
          .map((match) => ({
            sourceUrl: new URL(match[1].trim(), SOURCE_PAGE).href,
            asOfDate,
          }));
        if (items.length) return [...new Map(items.map((item) => [item.sourceUrl, item])).values()];
      }
    }
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return [];
}

async function main() {
  console.log('Fetching Taurus monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Taurus Mutual Fund',
    amcWords: ['TAURUS', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `taurus-portfolios-${date}.xlsx`,
    description: 'Taurus monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight / 100,
    nameFromRows: (rows, headerIndex, sheetName) => {
      const schemeRow = rows.slice(0, headerIndex).find((row) => row.some((cell) => /scheme name/i.test(text(cell))));
      if (schemeRow) {
        const labelIndex = schemeRow.findIndex((cell) => /scheme name/i.test(text(cell)));
        return text(schemeRow.slice(labelIndex + 1).find((cell) => text(cell)));
      }
      return sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Taurus portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
