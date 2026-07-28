#!/usr/bin/env node

const db = require('../server/db');

function normalizeFundName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bflexicap\b/g, 'flexi cap')
    .replace(/\bmidcap\b/g, 'mid cap')
    .replace(/\bowsal\b/g, 'oswal')
    .replace(/\b(direct|regular|standard|eco|plan|growth|idcw|dividend|income|distribution|cum|capital|withdrawal|payout|reinvestment|bonus|option|fund)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const sources = db.prepare(`
  SELECT source_scheme_key, scheme_name
  FROM scheme_total_aum_daily
  WHERE date = (SELECT MAX(date) FROM scheme_total_aum_daily)
`).all();
const byName = new Map();
for (const source of sources) {
  const key = normalizeFundName(source.scheme_name);
  if (!key) continue;
  const candidates = byName.get(key) || [];
  candidates.push(source);
  byName.set(key, candidates);
}

const schemes = db.prepare('SELECT scheme_code, name FROM schemes').all();
const clear = db.prepare('DELETE FROM scheme_total_aum_mappings');
const insert = db.prepare(`
  INSERT INTO scheme_total_aum_mappings (scheme_code, source_scheme_key, mapping_status, updated_at)
  VALUES (?, ?, 'provisional', CURRENT_TIMESTAMP)
`);

let mapped = 0;
let ambiguous = 0;
const transaction = db.transaction(() => {
  clear.run();
  for (const scheme of schemes) {
    const candidates = byName.get(normalizeFundName(scheme.name)) || [];
    if (candidates.length === 1) {
      insert.run(scheme.scheme_code, candidates[0].source_scheme_key);
      mapped += 1;
    } else if (candidates.length > 1) {
      ambiguous += 1;
    }
  }
});
transaction();

console.log(`Mapped ${mapped.toLocaleString('en-IN')} NAV schemes to AMFI Total AUM sources.`);
console.log(`${ambiguous.toLocaleString('en-IN')} schemes were left unmapped because the AMFI source identity was ambiguous.`);
