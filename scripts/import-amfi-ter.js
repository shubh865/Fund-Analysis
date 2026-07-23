#!/usr/bin/env node

const db = require('../server/db');

const AMFI_BASE = 'https://www.amfiindia.com';
const SOURCE_URL = `${AMFI_BASE}/ter-of-mf-schemes`;

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceIdentity(row) {
  if (row.NSDLSchemeCode) {
    return { key: `NSDL:${row.NSDLSchemeCode}`, nsdlCode: row.NSDLSchemeCode };
  }
  const normalizedName = String(row.Scheme_Name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedName) return null;
  return { key: `AMFI-MF:${row.MF_ID ?? 'unknown'}:${normalizedName}`, nsdlCode: null };
}

async function fetchJson(path) {
  const response = await fetch(`${AMFI_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Fund-Analysis/0.1' },
  });
  if (!response.ok) throw new Error(`AMFI request failed (${response.status}): ${path}`);
  return response.json();
}

async function latestMonth() {
  const currentYear = new Date().getUTCFullYear();
  for (const year of [`${currentYear}-${currentYear + 1}`, `${currentYear - 1}-${currentYear}`]) {
    const months = await fetchJson(`/api/populate-ter-month?year=${encodeURIComponent(year)}`);
    if (months.length) return months[0].MonthNumber;
  }
  throw new Error('AMFI did not return an available TER month.');
}

async function availableMonths() {
  const currentYear = new Date().getUTCFullYear();
  const months = new Set();
  for (let year = 2018; year <= currentYear; year += 1) {
    const financialYear = `${year}-${year + 1}`;
    const response = await fetchJson(`/api/populate-ter-month?year=${encodeURIComponent(financialYear)}`);
    for (const item of response) months.add(item.MonthNumber);
  }
  return [...months].sort((left, right) => {
    const [leftMonth, leftYear] = left.split('-').map(Number);
    const [rightMonth, rightYear] = right.split('-').map(Number);
    return leftYear - rightYear || leftMonth - rightMonth;
  });
}

async function fetchTerMonth(month, pageSize) {
  const path = (page) => `/api/populate-te-rdata-revised?MF_ID=All&Month=${encodeURIComponent(month)}&strCat=-1&strType=-1&page=${page}&pageSize=${pageSize}`;
  const first = await fetchJson(path(1));
  const rows = [...(first.data || [])];
  const pageCount = first.meta?.pageCount || 1;
  for (let page = 2; page <= pageCount; page += 1) {
    const response = await fetchJson(path(page));
    rows.push(...(response.data || []));
  }
  return rows;
}

async function main() {
  const allMonths = process.argv.includes('--all');
  const requestedMonth = getOption('--month');
  const months = requestedMonth ? [requestedMonth] : (allMonths ? await availableMonths() : [await latestMonth()]);
  const pageSize = 50000;

  const insert = db.prepare(`
    INSERT INTO scheme_ter_daily (
      source_scheme_key, date, nsdl_scheme_code, scheme_name, amfi_mf_id, scheme_type, category,
      regular_ber, regular_brokerage_cost, regular_transaction_cost,
      regular_statutory_levies, regular_ter, direct_ber, direct_brokerage_cost,
      direct_transaction_cost, direct_statutory_levies, direct_ter, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_scheme_key, date) DO UPDATE SET
      nsdl_scheme_code = excluded.nsdl_scheme_code,
      scheme_name = excluded.scheme_name,
      amfi_mf_id = excluded.amfi_mf_id,
      scheme_type = excluded.scheme_type,
      category = excluded.category,
      regular_ber = excluded.regular_ber,
      regular_brokerage_cost = excluded.regular_brokerage_cost,
      regular_transaction_cost = excluded.regular_transaction_cost,
      regular_statutory_levies = excluded.regular_statutory_levies,
      regular_ter = excluded.regular_ter,
      direct_ber = excluded.direct_ber,
      direct_brokerage_cost = excluded.direct_brokerage_cost,
      direct_transaction_cost = excluded.direct_transaction_cost,
      direct_statutory_levies = excluded.direct_statutory_levies,
      direct_ter = excluded.direct_ter,
      source_url = excluded.source_url
  `);
  const markComplete = db.prepare(`
    INSERT INTO import_progress (source, last_rowid, completed_at)
    VALUES (?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET completed_at = CURRENT_TIMESTAMP
  `);
  const isComplete = db.prepare('SELECT completed_at FROM import_progress WHERE source = ?');
  let importedMonths = 0;
  let importedRows = 0;
  let skippedRows = 0;

  for (const month of months) {
    const checkpoint = `amfi-ter-${month}`;
    if (allMonths && isComplete.get(checkpoint)?.completed_at) continue;
    const rows = await fetchTerMonth(month, pageSize);
    const identifiedRows = rows.map((row) => ({ row, identity: sourceIdentity(row) })).filter((item) => item.identity);
    skippedRows += rows.length - identifiedRows.length;
    const transaction = db.transaction(() => {
      for (const { row, identity } of identifiedRows) {
        const modernComponents = Object.hasOwn(row, 'R_BER');
        insert.run(
          identity.key, String(row.TER_Date).slice(0, 10), identity.nsdlCode, row.Scheme_Name || '',
          row.MF_ID == null ? null : String(row.MF_ID), row.SchemeType_Desc || null,
          row.SchemeCat_Desc || null, modernComponents ? asNumber(row.R_BER) : null,
          modernComponents ? asNumber(row.R_BrokerageCost) : null,
          modernComponents ? asNumber(row.R_TransactionCost) : null,
          modernComponents ? asNumber(row.R_StatutoryLevies) : null, asNumber(row.R_TER),
          modernComponents ? asNumber(row.D_BER) : null, modernComponents ? asNumber(row.D_BrokerageCost) : null,
          modernComponents ? asNumber(row.D_TransactionCost) : null,
          modernComponents ? asNumber(row.D_StatutoryLevies) : null, asNumber(row.D_TER), SOURCE_URL,
        );
      }
      markComplete.run(checkpoint);
    });
    transaction();
    const uniqueRows = new Set(identifiedRows.map(({ row, identity }) => `${identity.key}|${String(row.TER_Date).slice(0, 10)}`)).size;
    importedMonths += 1;
    importedRows += uniqueRows;
    console.log(`TER ${month}: ${uniqueRows.toLocaleString('en-IN')} unique rows imported (${rows.length.toLocaleString('en-IN')} source records).`);
  }
  console.log(`TER import complete: ${importedMonths} months, ${importedRows.toLocaleString('en-IN')} unique rows, ${skippedRows.toLocaleString('en-IN')} rows without a usable source identity.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
