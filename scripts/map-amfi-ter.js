#!/usr/bin/env node

const db = require('../server/db');

function normalizeFundName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(direct|regular|growth|idcw|dividend|payout|reinvestment|bonus|plan|option)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function planType(name) {
  const normalized = String(name || '').toLowerCase();
  if (/\bdirect\b/.test(normalized)) return 'direct';
  if (/\bregular\b/.test(normalized)) return 'regular';
  return null;
}

const terSources = db.prepare(`
  SELECT source_scheme_key, scheme_name, MAX(date) AS latest_date
  FROM scheme_ter_daily
  GROUP BY source_scheme_key, scheme_name
`).all();

const sourceByName = new Map();
for (const source of terSources) {
  const key = normalizeFundName(source.scheme_name);
  if (!key) continue;
  const matches = sourceByName.get(key) || [];
  matches.push(source);
  sourceByName.set(key, matches);
}

const schemes = db.prepare('SELECT scheme_code, name FROM schemes').all();
const insert = db.prepare(`
  INSERT INTO scheme_ter_mappings (scheme_code, source_scheme_key, plan_type, mapping_status, updated_at)
  VALUES (?, ?, ?, 'provisional', CURRENT_TIMESTAMP)
  ON CONFLICT(scheme_code, source_scheme_key) DO UPDATE SET
    plan_type = excluded.plan_type,
    mapping_status = excluded.mapping_status,
    updated_at = CURRENT_TIMESTAMP
`);

const clear = db.prepare('DELETE FROM scheme_ter_mappings');
let mapped = 0;
let mappedSchemes = 0;
let multiSourceSchemes = 0;
let unsupportedPlan = 0;
const transaction = db.transaction(() => {
  clear.run();
  for (const scheme of schemes) {
    const type = planType(scheme.name);
    if (!type) {
      unsupportedPlan += 1;
      continue;
    }
    const candidates = sourceByName.get(normalizeFundName(scheme.name)) || [];
    if (!candidates.length) continue;
    if (candidates.length > 1) multiSourceSchemes += 1;
    for (const candidate of candidates) {
      insert.run(scheme.scheme_code, candidate.source_scheme_key, type);
      mapped += 1;
    }
    mappedSchemes += 1;
  }
});
transaction();

console.log(`Mapped ${mappedSchemes.toLocaleString('en-IN')} Direct/Regular NAV schemes through ${mapped.toLocaleString('en-IN')} AMFI TER source links.`);
console.log(`${multiSourceSchemes.toLocaleString('en-IN')} schemes use multiple official TER identities across their history; ${unsupportedPlan.toLocaleString('en-IN')} schemes are not Direct or Regular plans.`);
