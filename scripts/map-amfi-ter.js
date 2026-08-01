#!/usr/bin/env node

const db = require('../server/db');

function normalizeFundName(name) {
  const normalized = String(name || '')
    .toLowerCase()
    // AMFI occasionally appends the previous scheme name to the current
    // identity. Match on the current name while the source key preserves the
    // historical continuity.
    .replace(/\bformerly\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/\bflexicap\b/g, 'flexi cap')
    .replace(/\bmidcap\b/g, 'mid cap')
    .replace(/\bowsal\b/g, 'oswal')
    .replace(/\b(direct|regular|standard|eco|growth|idcw|dividend|income|distribution|cum|capital|withdrawal|payout|reinvestment|bonus|plan|option|fund)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const verifiedRenameAliases = new Map([
    ['idfc emerging businesses', 'bandhan small cap'],
    ['bandhan emerging businesses', 'bandhan small cap'],
    ['franklin india smaller companies', 'franklin india small cap'],
    ['kotak tax saver scheme', 'kotak elss tax saver'],
    ['kotak tax saver', 'kotak elss tax saver'],
    ['quantum tax saving', 'quantum elss tax saver'],
    ['sbi long term equity', 'sbi elss tax saver'],
    ['union tax saver scheme', 'union elss tax saver'],
    ['union long term equity', 'union elss tax saver'],
    ['union tax saver elss', 'union elss tax saver'],
    ['boi axa mid cap tax series 1', 'bank of india mid cap tax series 1'],
    ['boi axa mid cap tax series 2', 'bank of india mid cap tax series 2'],
  ]);
  return verifiedRenameAliases.get(normalized) || normalized;
}

function planType(name) {
  const normalized = String(name || '').toLowerCase();
  if (/\bdirect\b/.test(normalized)) return 'direct';
  if (/\bregular\b/.test(normalized)) return 'regular';
  // Older NAV identities pre-date Direct plans. AMFI's TER source still
  // provides a Regular value for them, so use it only when a unique source
  // identity is found below.
  return 'regular';
}

function optionType(name) {
  const normalized = String(name || '').toLowerCase();
  if (/\b(idcw|dividend)\b|income\s+distribution/.test(normalized)) return 'idcw';
  if (/\bgrowth\b/.test(normalized)) return 'growth';
  return null;
}

function normalizeCategory(category) {
  const label = String(category || '')
    .toLowerCase()
    .replace(/^(equity|debt|hybrid) schemes? - /, '')
    .replace(/^income\/debt oriented schemes - /, '')
    .trim();
  const aliases = {
    'banking and psu debt fund': 'banking and psu fund',
    'dynamic term fund': 'dynamic bond',
    'medium term fund': 'medium duration fund',
    'short term fund': 'short duration fund',
    'ultra short term fund': 'ultra short duration fund',
    'ultra short to short term fund': 'ultra short duration fund',
    'elss- tax saver fund': 'elss',
    'balanced advantage fund/ dynamic asset allocation': 'dynamic asset allocation or balanced advantage',
    'equity savings fund': 'equity savings',
    'multi asset allocation fund': 'multi asset allocation',
  };
  return aliases[label] || label;
}

// A source key can contain an incorrect historical label that AMFI/NSDL later
// corrected (and, rarely, a key that was reused for another scheme). Identify
// every key by its latest published row, while retaining all of that key's
// older observations after the correct key has been selected.
const terSources = db.prepare(`
  WITH bounds AS (
    SELECT source_scheme_key, MIN(date) AS first_date, MAX(date) AS latest_date
    FROM scheme_ter_daily
    GROUP BY source_scheme_key
  )
  SELECT latest.source_scheme_key, latest.scheme_name, latest.category,
    latest.amfi_mf_id, bounds.first_date, bounds.latest_date,
    first.regular_ter AS first_regular_ter, first.direct_ter AS first_direct_ter,
    latest.regular_ter AS latest_regular_ter, latest.direct_ter AS latest_direct_ter
  FROM bounds
  JOIN scheme_ter_daily latest
    ON latest.source_scheme_key = bounds.source_scheme_key
   AND latest.date = bounds.latest_date
  JOIN scheme_ter_daily first
    ON first.source_scheme_key = bounds.source_scheme_key
   AND first.date = bounds.first_date
`).all();

const sourceByName = new Map();
const sourceByIdentity = new Map();
for (const source of terSources) {
  const key = normalizeFundName(source.scheme_name);
  if (!key) continue;
  const matches = sourceByName.get(key) || [];
  matches.push(source);
  sourceByName.set(key, matches);
  const identityKey = `${source.amfi_mf_id || ''}|${normalizeCategory(source.category)}`;
  const identitySources = sourceByIdentity.get(identityKey) || [];
  identitySources.push(source);
  sourceByIdentity.set(identityKey, identitySources);
}

function dateGapDays(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000);
}

function hasMatchingBoundaryTer(predecessor, successor) {
  const pairs = [
    [predecessor.latest_regular_ter, successor.first_regular_ter],
    [predecessor.latest_direct_ter, successor.first_direct_ter],
  ].filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0);
  return pairs.length > 0 && pairs.every(([left, right]) => Math.abs(left - right) <= 0.05);
}

function continuousHistoricalSources(initialSources) {
  const selected = new Map(initialSources.map((source) => [source.source_scheme_key, source]));
  let added = true;
  while (added) {
    added = false;
    for (const successor of [...selected.values()]) {
      const identityKey = `${successor.amfi_mf_id || ''}|${normalizeCategory(successor.category)}`;
      const possible = (sourceByIdentity.get(identityKey) || [])
        .filter((source) => !selected.has(source.source_scheme_key))
        .map((source) => ({ source, gap: dateGapDays(source.latest_date, successor.first_date) }))
        .filter(({ source, gap }) => gap >= 1 && gap <= 7 && hasMatchingBoundaryTer(source, successor))
        .sort((left, right) => left.gap - right.gap);
      // A rename/source transition must have one unambiguous nearest
      // predecessor. Do not join identities when two candidates are equally
      // plausible.
      if (!possible.length || (possible[1] && possible[1].gap === possible[0].gap)) continue;
      selected.set(possible[0].source.source_scheme_key, possible[0].source);
      added = true;
    }
  }
  return [...selected.values()];
}

const schemes = db.prepare('SELECT scheme_code, name, category FROM schemes').all();
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
    const schemeOption = optionType(scheme.name);
    if (!type) {
      unsupportedPlan += 1;
      continue;
    }
    const namedCandidates = (sourceByName.get(normalizeFundName(scheme.name)) || []).filter((source) => (
      (!scheme.category || !source.category || normalizeCategory(source.category) === normalizeCategory(scheme.category))
      && (!schemeOption || !optionType(source.scheme_name) || schemeOption === optionType(source.scheme_name))
    ));
    const candidates = continuousHistoricalSources(namedCandidates);
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
