const crypto = require('crypto');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const AMC = 'ITI Mutual Fund';
const SOURCE_PAGE = 'https://www.itiamc.com/statuory-disclosure?type=Portfolio%20Disclosures';
const API_URL = 'https://itiamc.com/jeeth/api/v1/catalog/getPartnerDocumentByType';
const KEY = Buffer.from('aar6tzij8o1snaar', 'latin1');
const IV = Buffer.from('0123456789ABCDEF', 'latin1');

function encrypt(payload) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
}

function decrypt(value) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8'));
}

async function fetchItems() {
  const payload = {
    type: 'Disclosure',
    guid: crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
    timeStamp: Date.now(),
  };
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eData: encrypt(payload) }),
  });
  if (!response.ok) throw new Error(`ITI disclosure API returned ${response.status}.`);
  const envelope = await response.json();
  const result = decrypt(envelope.eData);
  const documents = [];
  for (const section of result.data?.typeList || []) {
    if (section.subType !== 'Portfolio Disclosures') continue;
    for (const group of section.subTypesList || []) {
      if (group.topic !== 'Monthly') continue;
      documents.push(...(group.topicsList || []));
    }
  }
  const latest = documents
    .filter((document) => /\.xlsx?(?:$|\?)/i.test(document.url || ''))
    .map((document) => {
      const match = text(document.fileName).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
      if (!match) return null;
      const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
        .indexOf(match[1].toLowerCase()) + 1;
      const lastDay = new Date(Date.UTC(Number(match[2]), month, 0)).getUTCDate();
      return { ...document, asOfDate: `${match[2]}-${String(month).padStart(2, '0')}-${lastDay}` };
    })
    .filter(Boolean)
    .sort((left, right) => right.asOfDate.localeCompare(left.asOfDate))[0];
  if (!latest) throw new Error('ITI has not published a usable monthly portfolio workbook.');
  return [{ sourceUrl: latest.url, asOfDate: latest.asOfDate }];
}

async function main() {
  console.log('Fetching ITI monthly portfolio disclosure...');
  const result = await importStandardPortfolios({
    amc: AMC,
    amcWords: ['ITI', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `iti-portfolios-${date}.xlsx`,
    description: 'ITI monthly portfolio disclosure',
    fetchItems,
    normalizeWeight: (weight) => weight,
    nameFromRows: (rows, headerIndex, sheetName) => text(rows.slice(0, headerIndex).flat()
      .find((cell) => /^ITI .+ Fund$/i.test(text(cell)) && !/^ITI Mutual Fund$/i.test(text(cell)))) || sheetName,
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} ITI portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
