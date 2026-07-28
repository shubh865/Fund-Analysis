#!/usr/bin/env node

const db = require('../server/db');

const AMFI_BASE = 'https://www.amfiindia.com';
const API_BASE = `${AMFI_BASE}/gateway/pollingsebi/api/amfi`;
const SOURCE_URL = `${AMFI_BASE}/otherdata/fund-performance`;

async function post(path, body) {
  const response = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    // AMFI's polling gateway accepts requests from the official Fund
    // Performance page origin and rejects generic service-client requests.
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: AMFI_BASE,
      Referer: `${AMFI_BASE}/polling/amfi/fund-performance`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`AMFI request failed (${response.status}): ${path}`);
  const result = await response.json();
  if (result.validationStatus !== 'SUCCESS') throw new Error(result.errorMsgs?.[0]?.errorMsg || `AMFI did not return data for ${path}`);
  return result.data;
}

function sourceKey({ maturityType, category, subcategory, schemeName }) {
  return [maturityType, category, subcategory, schemeName]
    .map((value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

async function main() {
  const filters = await post('fundperformancefilters', {});
  const reportDate = filters.reportDate;
  if (!reportDate) throw new Error('AMFI Fund Performance did not provide a report date.');
  const date = new Date(`${reportDate} UTC`);
  if (Number.isNaN(date.getTime())) throw new Error(`Cannot parse AMFI report date: ${reportDate}`);
  const asOf = date.toISOString().slice(0, 10);

  const insert = db.prepare(`
    INSERT INTO scheme_total_aum_daily (
      source_scheme_key, date, scheme_name, maturity_type, category, subcategory,
      daily_aum_crore, riskometer_scheme, riskometer_benchmark, benchmark_name,
      disclosure_marker, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_scheme_key, date) DO UPDATE SET
      scheme_name = excluded.scheme_name,
      maturity_type = excluded.maturity_type,
      category = excluded.category,
      subcategory = excluded.subcategory,
      daily_aum_crore = excluded.daily_aum_crore,
      riskometer_scheme = excluded.riskometer_scheme,
      riskometer_benchmark = excluded.riskometer_benchmark,
      benchmark_name = excluded.benchmark_name,
      disclosure_marker = excluded.disclosure_marker,
      source_url = excluded.source_url
  `);
  const markComplete = db.prepare(`
    INSERT INTO import_progress (source, last_rowid, completed_at)
    VALUES ('amfi-total-aum', 0, CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET completed_at = CURRENT_TIMESTAMP
  `);

  let rows = 0;
  for (const maturityType of filters.maturityTypeList || []) {
    for (const category of filters.investmentTypeList || []) {
      const subcategories = await post('getsubcategory', { category: category.id });
      for (const subcategory of subcategories || []) {
        const results = await post('fundperformance', {
          maturityType: maturityType.id,
          category: category.id,
          subCategory: subcategory.id,
          mfid: 0,
          reportDate,
        });
        const transaction = db.transaction(() => {
          for (const row of results || []) {
            // AMFI publishes the scheme risk label for more debt funds than it
            // publishes a current point-in-time AUM. Keep that disclosure even
            // when Daily AUM is unavailable; an absent AUM must remain blank.
            if (!row.schemeName) continue;
            insert.run(
              sourceKey({ maturityType: maturityType.name, category: category.name, subcategory: subcategory.name, schemeName: row.schemeName }),
              asOf, row.schemeName, maturityType.name, category.name, subcategory.name,
              Number.isFinite(Number(row.dailyAUM)) ? Number(row.dailyAUM) : null,
              row.riskometerScheme || null, row.riskometerBenchmark || null,
              row.benchmark || null, row.specialCharAum || null, SOURCE_URL,
            );
            rows += 1;
          }
        });
        transaction();
      }
    }
  }
  markComplete.run();
  console.log(`Total AUM import complete: ${rows.toLocaleString('en-IN')} AMFI source rows for ${asOf}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
