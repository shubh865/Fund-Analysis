#!/usr/bin/env node

const XLSX = require('xlsx');
const db = require('../server/db');

const RBI_BASE = 'https://data.rbi.org.in';
const API_BASE = `${RBI_BASE}/CIMS_Gateway_DBIE/GATEWAY/SERVICES`;
const SOURCE_URL = `${RBI_BASE}/DBIE/`;
const RATE_NAME = 'RBI Repo Rate (Overnight)';

function toIsoDate(value) {
  const match = String(value || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[match[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]))).toISOString().slice(0, 10);
}

async function downloadWorkbook() {
  const commonHeaders = {
    'Content-Type': 'application/json', channelkey: 'key2', datatype: 'application/json',
    Origin: RBI_BASE, Referer: SOURCE_URL, 'User-Agent': 'Fund-Analysis/0.1',
  };
  const session = await fetch(`${API_BASE}/security_generateSessionToken`, {
    method: 'POST', headers: commonHeaders, body: JSON.stringify({ body: {} }),
  });
  const token = session.headers.get('authorization');
  if (!session.ok || !token) throw new Error(`RBI session request failed (${session.status}).`);
  const form = new FormData();
  form.append('requestMessage', '{"body":{"Filename":"OtherMacroeconomicTimeseriesData"}}');
  const download = await fetch(`${API_BASE}/download/dbie_FileDownloadHDFSAction`, {
    method: 'POST',
    headers: { channelkey: 'key2', authorization: token, Origin: RBI_BASE, Referer: SOURCE_URL, 'User-Agent': 'Fund-Analysis/0.1' },
    body: form,
  });
  if (!download.ok) throw new Error(`RBI workbook download failed (${download.status}).`);
  return Buffer.from(await download.arrayBuffer());
}

async function main() {
  const workbook = XLSX.read(await downloadWorkbook(), { type: 'buffer', raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Daily, { header: 1, defval: null, raw: true });
  const headers = rows[1] || [];
  const dateColumn = headers.findIndex((value) => String(value).trim().toLowerCase() === 'reporting date');
  const rateColumn = headers.findIndex((value) => String(value).trim().toLowerCase() === 'repo rate (overnight)');
  if (dateColumn < 0 || rateColumn < 0) throw new Error('RBI workbook did not contain the Daily Repo Rate column.');

  const upsert = db.prepare(`
    INSERT INTO risk_free_rate_daily (date, annual_rate_percent, rate_name, source_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      annual_rate_percent = excluded.annual_rate_percent,
      rate_name = excluded.rate_name,
      source_url = excluded.source_url
  `);
  let imported = 0;
  const transaction = db.transaction(() => {
    for (const row of rows.slice(3)) {
      const date = toIsoDate(row[dateColumn]);
      const rate = Number(row[rateColumn]);
      if (!date || !Number.isFinite(rate) || rate <= 0) continue;
      upsert.run(date, rate, RATE_NAME, SOURCE_URL);
      imported += 1;
    }
    db.prepare(`
      INSERT INTO import_progress (source, last_rowid, completed_at)
      VALUES ('rbi-repo-rate', 0, CURRENT_TIMESTAMP)
      ON CONFLICT(source) DO UPDATE SET completed_at = CURRENT_TIMESTAMP
    `).run();
  });
  transaction();
  console.log(`RBI Repo Rate import complete: ${imported.toLocaleString('en-IN')} daily observations.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
