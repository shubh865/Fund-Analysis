#!/usr/bin/env node

const db = require('../server/db');

const AMFI_BASE = 'https://www.amfiindia.com';
const SOURCE_URL = `${AMFI_BASE}/aum-data/average-aum`;

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function periodEnd(periodLabel) {
  const match = periodLabel.match(/([A-Za-z]+)\s+(\d{4})$/);
  if (!match) throw new Error(`Cannot determine the end date for AMFI period: ${periodLabel}`);
  const month = new Date(`${match[1]} 1, ${match[2]} UTC`).getUTCMonth();
  const end = new Date(Date.UTC(Number(match[2]), month + 1, 0));
  return end.toISOString().slice(0, 10);
}

function frequency(periodLabel) {
  const match = periodLabel.match(/^\s*([A-Za-z]+)\s*-\s*([A-Za-z]+)\s+\d{4}\s*$/);
  if (!match) return 'unknown';
  return match[1].toLowerCase() === match[2].toLowerCase() ? 'monthly' : 'quarterly';
}

async function fetchJson(path) {
  const response = await fetch(`${AMFI_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Fund-Analysis/0.1' },
  });
  if (!response.ok) throw new Error(`AMFI request failed (${response.status}): ${path}`);
  return response.json();
}

async function main() {
  const requestedFy = getOption('--fy');
  const requestedPeriod = getOption('--period');
  const allPeriods = process.argv.includes('--all');
  const years = await fetchJson('/api/average-aum-schemewise?strType=Categorywise&MF_ID=0');
  const financialYears = requestedFy
    ? years.data?.filter((item) => String(item.id) === String(requestedFy))
    : (allPeriods ? [...(years.data || [])].reverse() : [years.data?.[0]]);
  if (!financialYears?.length || !financialYears[0]) throw new Error('AMFI did not return an AAUM financial year.');

  const insert = db.prepare(`
    INSERT INTO scheme_aaum_periodic (
      amfi_scheme_code, period_end, period_label, financial_year, reporting_frequency,
      scheme_name, amc, category, aaum_excluding_domestic_fof_lakh,
      aaum_domestic_fof_lakh, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(amfi_scheme_code, period_end) DO UPDATE SET
      period_label = excluded.period_label,
      financial_year = excluded.financial_year,
      reporting_frequency = excluded.reporting_frequency,
      scheme_name = excluded.scheme_name,
      amc = excluded.amc,
      category = excluded.category,
      aaum_excluding_domestic_fof_lakh = excluded.aaum_excluding_domestic_fof_lakh,
      aaum_domestic_fof_lakh = excluded.aaum_domestic_fof_lakh,
      source_url = excluded.source_url
  `);

  const markComplete = db.prepare(`
    INSERT INTO import_progress (source, last_rowid, completed_at)
    VALUES (?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET completed_at = CURRENT_TIMESTAMP
  `);
  const isComplete = db.prepare('SELECT completed_at FROM import_progress WHERE source = ?');
  let importedPeriods = 0;
  let importedRows = 0;

  for (const financialYear of financialYears) {
    const fyId = String(financialYear.id);
    const periodResponse = await fetchJson(`/api/average-aum-schemewise?fyId=${encodeURIComponent(fyId)}&strType=Categorywise&MF_ID=0`);
    const periods = requestedPeriod
      ? periodResponse.data?.periods?.filter((item) => String(item.id) === String(requestedPeriod))
      : (allPeriods ? periodResponse.data?.periods || [] : [periodResponse.data?.periods?.at(-1)]);
    if (!periods.length || !periods[0]) throw new Error(`AMFI did not return the requested AAUM period for financial year ${fyId}.`);

    for (const period of periods) {
      const endDate = periodEnd(period.period);
      const checkpoint = `amfi-aaum-${endDate}`;
      if (allPeriods && isComplete.get(checkpoint)?.completed_at) continue;

      const result = await fetchJson(`/api/average-aum-schemewise?strType=Categorywise&fyId=${encodeURIComponent(fyId)}&periodId=${encodeURIComponent(period.id)}&MF_ID=0`);
      let rows = 0;
      const transaction = db.transaction(() => {
        for (const group of result.data || []) {
          for (const scheme of group.schemes || []) {
            const aum = scheme.AverageAumForTheMonth || {};
            insert.run(
              String(scheme.AMFI_Code), endDate, period.period, periodResponse.data?.financial_year || null, frequency(period.period),
              scheme.SchemeNAVName || '', group.Mfname || null, group.SchemeCat_Desc || null,
              aum.ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas ?? null,
              aum.FundOfFundsDomestic ?? null, SOURCE_URL,
            );
            rows += 1;
          }
        }
        markComplete.run(checkpoint);
      });
      transaction();
      importedPeriods += 1;
      importedRows += rows;
      console.log(`AAUM ${period.period}: ${rows.toLocaleString('en-IN')} source rows imported.`);
    }
  }
  console.log(`AAUM import complete: ${importedPeriods} periods, ${importedRows.toLocaleString('en-IN')} source rows.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
