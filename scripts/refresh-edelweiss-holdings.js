const crypto = require('crypto');
const { importStandardPortfolios, text } = require('./lib/standard-portfolio-importer');

const SOURCE_PAGE = 'https://www.edelweissmf.com/statutory/portfolio-of-schemes';
const API_URL = 'https://api.edelweissmf.com/edelweissmf/api/v1/mf/statutory-menus/single'
  + '?type=Statutory&fundType=MF&menuName=Portfolio%20of%20scheme(s)';
const ORIGIN = 'https://www.edelweissmf.com';
const ENCRYPTION_SECRET = '5b6714126d3149fbab994747b2633287';
const HASH_KEY = 'r4vcos0ejvndsow95n';
const HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
};

function evpBytesToKey(passphrase, salt) {
  let output = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (output.length < 48) {
    previous = crypto.createHash('md5')
      .update(Buffer.concat([previous, Buffer.from(passphrase), salt]))
      .digest();
    output = Buffer.concat([output, previous]);
  }
  return { key: output.subarray(0, 32), iv: output.subarray(32, 48) };
}

function decryptCryptoJs(ciphertext, passphrase) {
  const encrypted = Buffer.from(ciphertext, 'base64');
  if (encrypted.subarray(0, 8).toString() !== 'Salted__') {
    throw new Error('Edelweiss API returned an unsupported encrypted response.');
  }
  const { key, iv } = evpBytesToKey(passphrase, encrypted.subarray(8, 16));
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString('utf8');
}

function dateFromTitle(title) {
  const match = text(title).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const month = String(new Date(`${match[1]} 1, 2000`).getMonth() + 1).padStart(2, '0');
  return `${match[3]}-${month}-${String(match[2]).padStart(2, '0')}`;
}

async function fetchDisclosure() {
  const ipResponse = await fetch('https://api.ipify.org');
  if (!ipResponse.ok) throw new Error(`Public IP service returned ${ipResponse.status}.`);
  const ipAddress = text(await ipResponse.text());
  const timestamp = Date.now().toString();
  const passphrase = crypto.createHmac('sha256', HASH_KEY)
    .update(`${ENCRYPTION_SECRET}${ipAddress}${timestamp}`)
    .digest('hex');
  const response = await fetch(API_URL, {
    headers: {
      ...HEADERS,
      'x-ip-address': ipAddress,
      'x-timestamp': timestamp,
    },
  });
  if (!response.ok) throw new Error(`Edelweiss disclosure API returned ${response.status}.`);
  const payload = await response.json();
  return JSON.parse(decryptCryptoJs(payload.body, passphrase));
}

async function fetchItems() {
  const disclosure = await fetchDisclosure();
  const candidates = (disclosure.files || [])
    .filter((file) => /monthly portfolio/i.test(file.subMenuName || ''))
    .map((file) => ({
      title: text(file.fileTitle),
      asOfDate: dateFromTitle(file.fileTitle),
      sourceUrl: new URL(file.downloadFile || file.filePath, ORIGIN).href,
    }))
    .filter((item) => item.asOfDate && /\.xlsx?$/i.test(item.sourceUrl));
  const latestDate = candidates.map((item) => item.asOfDate).sort().at(-1);
  if (!latestDate) throw new Error('Edelweiss has not published a usable monthly portfolio workbook.');
  return candidates.filter((item) => item.asOfDate === latestDate);
}

async function main() {
  console.log('Fetching Edelweiss monthly portfolio disclosures...');
  const result = await importStandardPortfolios({
    amc: 'Edelweiss Mutual Fund',
    amcWords: ['EDELWEISS', 'MUTUAL', 'FUND'],
    sourcePage: SOURCE_PAGE,
    sourceFile: (date) => `edelweiss-portfolios-${date}.xlsx`,
    description: 'Edelweiss monthly portfolio disclosure',
    fetchItems,
    fetchBytes: async (item) => {
      const response = await fetch(item.sourceUrl, {
        headers: {
          ...HEADERS,
          accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
          referer: SOURCE_PAGE,
        },
      });
      if (!response.ok) throw new Error(`Edelweiss workbook returned ${response.status}: ${item.sourceUrl}`);
      return Buffer.from(await response.arrayBuffer());
    },
    normalizeWeight: (weight) => weight,
    namePattern: /EDELWEISS.+FUND/i,
    nameFromRows: (rows, headerIndex, sheetName) => {
      const heading = text(rows.slice(0, headerIndex).flat()
        .find((cell) => /PORTFOLIO STATEMENT OF EDELWEISS/i.test(text(cell))));
      const match = heading.match(/PORTFOLIO STATEMENT OF\s+(.+?)\s+AS ON/i);
      return match ? match[1] : sheetName;
    },
  });
  console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Edelweiss portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} schemes.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
