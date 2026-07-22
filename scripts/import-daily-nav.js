const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');

const sourceUrl = 'https://www.amfiindia.com/spages/NAVAll.txt';
const rawDirectory = path.join(__dirname, '..', 'raw');
const excludedAmcs = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'amc-exclusions.json'), 'utf8')));
const invalidNavs = new Set(['#N/A', '#DIV/0!', 'N.A.', 'NA', 'B.C.', 'B. C.']);

function normaliseIsin(value) {
  const isin = (value || '').trim().toUpperCase();
  return /^(INF|IINF)[A-Z0-9]{9}$/.test(isin) ? isin : null;
}

function parseAmfiDate(value) {
  const match = /^(\d{2})-(\w{3})-(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const month = months[match[2].toUpperCase()];
  return month ? `${match[3]}-${month}-${match[1]}` : null;
}

function parseNavAll(text) {
  const rows = [];
  let amc = null;
  let category = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    const categoryMatch = /^.+?Schemes\((.+)\)$/.exec(trimmedLine);
    if (categoryMatch) {
      category = categoryMatch[1].trim();
      continue;
    }
    const fields = line.split(';').map((field) => field.trim());
    if (fields.length === 1 && fields[0] && !/^scheme code/i.test(fields[0])) {
      amc = fields[0];
      continue;
    }
    if (fields.length < 6 || !/^\d+$/.test(fields[0])) continue;
    // NAVAll.txt currently has six columns.  The two ISIN columns are
    // payout/growth and reinvestment, followed by name, NAV and date.
    const [schemeCode, payoutIsin, reinvestmentIsin, name, navText, dateText] = fields;
    if (invalidNavs.has(navText.toUpperCase())) continue;
    const nav = Number(navText);
    const date = parseAmfiDate(dateText);
    if (!Number.isFinite(nav) || nav <= 0 || !date || !name) continue;
    rows.push({ schemeCode, payoutIsin: normaliseIsin(payoutIsin), growthIsin: normaliseIsin(reinvestmentIsin), name, nav, date, amc, category });
  }
  return rows;
}

async function getSource() {
  const requestedFile = process.argv[2];
  if (requestedFile) return fs.readFileSync(path.resolve(requestedFile), 'utf8');
  const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'MutualFundAnalytics/0.1 (local)' } });
  if (!response.ok) throw new Error(`AMFI returned HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const source = await getSource();
  const parsedRows = parseNavAll(source);
  const rows = parsedRows.filter((row) => !excludedAmcs.has(row.amc));
  if (!rows.length) throw new Error('No valid NAV rows remain after AMC exclusions; source format may have changed.');
  fs.mkdirSync(rawDirectory, { recursive: true });
  const latestDate = rows.map((row) => row.date).sort().at(-1);
  fs.writeFileSync(path.join(rawDirectory, `navall_${latestDate}.txt`), source);

  const upsertScheme = db.prepare(`
    INSERT INTO schemes (scheme_code, isin_div_payout, isin_growth, name, amc, category)
    VALUES (@schemeCode, @payoutIsin, @growthIsin, @name, @amc, @category)
    ON CONFLICT(scheme_code) DO UPDATE SET
      isin_div_payout = excluded.isin_div_payout,
      isin_growth = excluded.isin_growth,
      name = excluded.name,
      amc = excluded.amc,
      category = COALESCE(excluded.category, schemes.category),
      updated_at = CURRENT_TIMESTAMP
  `);
  const upsertNav = db.prepare(`
    INSERT INTO nav_daily (scheme_code, date, nav) VALUES (@schemeCode, @date, @nav)
    ON CONFLICT(scheme_code, date) DO UPDATE SET nav = excluded.nav
  `);
  const importRows = db.transaction((records) => records.forEach((row) => { upsertScheme.run(row); upsertNav.run(row); }));
  importRows(rows);
  console.log(`Imported ${rows.length} valid NAV rows; skipped ${parsedRows.length - rows.length} excluded-AMC rows; latest reported date: ${latestDate}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
