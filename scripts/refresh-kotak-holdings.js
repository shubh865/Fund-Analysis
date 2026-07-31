const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.kotakmf.com/Information/forms-and-downloads';
const FACTSHEET_ROOT = 'https://vatseelabs-s3.kotakmf.com/FormsDownloads/Factsheet';
const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const number = (value) => {
  const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

function priorMonths(count = 4) {
  const values = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let index = 0; index < count; index += 1) {
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    values.push({ month: cursor.getUTCMonth(), year: cursor.getUTCFullYear() });
  }
  return values;
}

function lastDay(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

async function fetchItems() {
  for (const period of priorMonths()) {
    const monthName = months[period.month];
    const sourceUrl = `${FACTSHEET_ROOT}/Factsheet-for-${monthName}-${period.year}/KotakMFFactsheet${monthName}${period.year}.pdf`;
    const response = await fetch(sourceUrl, { method: 'HEAD' });
    if (response.ok) {
      return [{ sourceUrl, asOfDate: lastDay(period.year, period.month) }];
    }
  }
  throw new Error('Kotak published no factsheet in the latest four completed months.');
}

function groupedRows(items, columnStart, columnEnd, headerY, lowerY) {
  const rows = [];
  for (const item of items) {
    const value = text(item.str);
    const x = item.transform[4];
    const y = item.transform[5];
    if (!value || x < columnStart || x >= columnEnd || y >= headerY - 2 || y < lowerY) continue;
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 0.7);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ value, x, fontName: item.fontName });
  }
  return rows.sort((left, right) => right.y - left.y)
    .map((row) => ({ ...row, items: row.items.sort((left, right) => left.x - right.x) }));
}

function parseColumn(items, header, columnEnd, ratingStart, weightStart, lowerY) {
  const records = [];
  for (const row of groupedRows(items, header.transform[4] - 2, columnEnd, header.transform[5], lowerY)) {
    const numericItems = row.items.filter((item) => /^<?-?\d+(?:\.\d+)?(?:\*)?$/.test(item.value));
    const numeric = numericItems.sort((left, right) => (
      Math.abs(left.x - weightStart) - Math.abs(right.x - weightStart)
    ))[0];
    if (!numeric) continue;
    const nameItems = row.items.filter((item) => item.x < (ratingStart || numeric.x - 3));
    const name = text(nameItems.map((item) => item.value).join(' '));
    if (!name || /^-?\d+(?:\.\d+)?$/.test(name) || /^(issuer\/instrument|% to net assets)$/i.test(name)) continue;
    if (/^grand total$/i.test(name)) break;

    const rating = ratingStart
      ? text(row.items.filter((item) => item.x >= ratingStart && item.x < numeric.x - 2)
        .map((item) => item.value).join(' '))
      : '';
    const publishedWeight = number(numeric.value);
    if (publishedWeight == null) continue;
    records.push({
      name,
      rating,
      weight: publishedWeight / 100,
      isGroup: nameItems.some((item) => item.fontName === header.fontName),
    });
  }

  const holdings = [];
  let holdingGroup = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (/\btotal\b/i.test(record.name)) continue;
    if (record.isGroup) {
      holdingGroup = record.name;
      if (records[index + 1] && !records[index + 1].isGroup) continue;
    }
    holdings.push({
      assetClass: holdingGroup,
      holdingGroup,
      instrumentName: record.name,
      isin: null,
      industryOrRating: record.rating || holdingGroup,
      quantity: null,
      marketValueLakh: null,
      weight: record.weight,
      yield: null,
      yieldToCall: null,
    });
  }
  return holdings;
}

async function parseFactsheet(bytes, item) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
  }).promise;
  const portfolios = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const titleEntries = content.items.filter((entry) => /^KOTAK\b/i.test(text(entry.str))
      && entry.transform[4] < 200 && entry.height >= 11)
      .sort((left, right) => right.transform[5] - left.transform[5]);
    for (let section = 0; section < titleEntries.length; section += 1) {
      const titleEntry = titleEntries[section];
      const sectionBottom = titleEntries[section + 1]?.transform[5] || 0;
      const sectionHeaders = content.items.filter((entry) => text(entry.str) === 'Issuer/Instrument'
        && entry.transform[5] < titleEntry.transform[5]
        && entry.transform[5] > sectionBottom);
      if (!sectionHeaders.length) continue;
      const headerY = Math.max(...sectionHeaders.map((entry) => entry.transform[5]));
      const headers = sectionHeaders.filter((entry) => Math.abs(entry.transform[5] - headerY) < 2)
        .sort((left, right) => left.transform[4] - right.transform[4]);
      const grandTotal = content.items.find((entry) => text(entry.str) === 'Grand Total'
        && entry.transform[5] < headerY && entry.transform[5] > sectionBottom);
      if (!grandTotal) continue;

      const name = text(titleEntry.str).replace(/\s+/g, ' ');
      const holdings = [];
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index];
        const columnEnd = headers[index + 1]?.transform[4] - 2 || page.view[2] - 20;
        const rating = content.items.find((entry) => (
          /^(Rating|Industry\/Rating)$/.test(text(entry.str))
          && Math.abs(entry.transform[5] - header.transform[5]) < 2
          && entry.transform[4] > header.transform[4] && entry.transform[4] < columnEnd
        ));
        const weightHeader = content.items.filter((entry) => /^% to Net(?: Assets)?$/.test(text(entry.str))
          && Math.abs(entry.transform[5] - header.transform[5]) < 2
          && entry.transform[4] > header.transform[4] && entry.transform[4] < columnEnd)
          .sort((left, right) => left.transform[4] - right.transform[4])[0];
        if (!weightHeader) continue;
        const columnTotalYs = content.items.filter((entry) => (
          /(?:\bTotal|Grand Total)$/i.test(text(entry.str))
          && entry.transform[4] >= header.transform[4] - 2
          && entry.transform[4] < columnEnd
          && entry.transform[5] < header.transform[5]
          && entry.transform[5] > sectionBottom
        )).map((entry) => entry.transform[5]);
        const columnBottom = Math.min(grandTotal.transform[5], ...columnTotalYs);
        holdings.push(...parseColumn(
          content.items,
          header,
          columnEnd,
          rating?.transform[4],
          weightHeader.transform[4],
          columnBottom,
        ));
      }
      if (holdings.length) {
        portfolios.push({
          sourceFundCode: name,
          name,
          date: item.asOfDate,
          holdings,
          sourceUrl: item.sourceUrl,
        });
      }
    }
  }
  const merged = new Map();
  for (const portfolio of portfolios) {
    const existing = merged.get(portfolio.name);
    if (existing) {
      existing.holdings.push(...portfolio.holdings);
    } else {
      merged.set(portfolio.name, portfolio);
    }
  }
  return [...merged.values()];
}

if (require.main === module) {
  importStandardPortfolios({
    amc: 'Kotak Mahindra Mutual Fund',
    amcWords: ['KOTAK', 'MAHINDRA'],
    description: 'Official Kotak Mutual Fund monthly factsheet portfolio disclosure.',
    sourcePage: SOURCE_PAGE,
    sourceFile: (asOfDate) => `Kotak monthly factsheet ${asOfDate}`,
    fetchItems,
    parseBytes: parseFactsheet,
    normalizeWeight: (value) => value,
  }).then((result) => {
    console.log(`Kotak holdings refreshed: ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { parseFactsheet };
