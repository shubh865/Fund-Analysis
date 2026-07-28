#!/usr/bin/env node

const db = require('../server/db');

function normalizeFundName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // AMFI's NAV and AAUM feeds have a few harmless naming differences.
    .replace(/\bflexicap\b/g, 'flexi cap')
    .replace(/\bmidcap\b/g, 'mid cap')
    .replace(/\bowsal\b/g, 'oswal')
    .replace(/\b(direct|regular|standard|eco|plan|growth|idcw|dividend|income|distribution|cum|capital|withdrawal|payout|reinvestment|bonus|option|fund)\b/g, ' ')
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

const aaumSources = db.prepare(`
  SELECT DISTINCT amfi_scheme_code, scheme_name
  FROM scheme_aaum_periodic
`).all();

const sourcesByName = new Map();
for (const source of aaumSources) {
  const key = normalizeFundName(source.scheme_name);
  if (!key) continue;
  const candidates = sourcesByName.get(key) || [];
  candidates.push(source);
  sourcesByName.set(key, candidates);
}

const schemes = db.prepare('SELECT scheme_code, name FROM schemes').all();
const clear = db.prepare('DELETE FROM scheme_aaum_mappings');
const insert = db.prepare(`
  INSERT INTO scheme_aaum_mappings (scheme_code, source_scheme_code, mapping_status, updated_at)
  VALUES (?, ?, 'provisional', CURRENT_TIMESTAMP)
`);

let mapped = 0;
let direct = 0;
let inferred = 0;
let ambiguous = 0;

const transaction = db.transaction(() => {
  clear.run();
  for (const scheme of schemes) {
    const exact = aaumSources.find((source) => source.amfi_scheme_code === scheme.scheme_code);
    if (exact) {
      insert.run(scheme.scheme_code, exact.amfi_scheme_code);
      mapped += 1;
      direct += 1;
      continue;
    }
    const candidates = sourcesByName.get(normalizeFundName(scheme.name)) || [];
    // IDCW records may resolve to both a Direct and a Regular AAUM source.
    // Preserve the plan identity when AMFI gives us that distinction.
    const matchingPlan = planType(scheme.name);
    const planCandidates = matchingPlan
      ? candidates.filter((candidate) => planType(candidate.scheme_name) === matchingPlan)
      : candidates;
    if (planCandidates.length === 1) {
      insert.run(scheme.scheme_code, planCandidates[0].amfi_scheme_code);
      mapped += 1;
      inferred += 1;
    } else if (planCandidates.length > 1) {
      ambiguous += 1;
    }
  }
});
transaction();

console.log(`Mapped ${mapped.toLocaleString('en-IN')} NAV schemes to AMFI AAUM sources (${direct.toLocaleString('en-IN')} direct, ${inferred.toLocaleString('en-IN')} underlying-fund links).`);
console.log(`${ambiguous.toLocaleString('en-IN')} schemes were left unmapped because the AAUM identity was ambiguous.`);
