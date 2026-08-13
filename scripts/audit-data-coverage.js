#!/usr/bin/env node

// Read-only source coverage report. This deliberately distinguishes a mapping
// from a usable value series: a provisional benchmark category mapping is not
// reported as daily benchmark data.
const db = require('../server/db');

function scalar(sql, ...params) {
  return db.prepare(sql).get(...params).value;
}

function print(label, value) {
  console.log(`${label}: ${value ?? 'not available'}`);
}

function main() {
  // Discontinued plans are removed during the NAV import cleanup, so the
  // schemes table itself represents the currently supported universe.
  const active = '1=1';
  const factsheetAmcs = scalar(`SELECT COUNT(DISTINCT source_amc) AS value FROM scheme_factsheet_snapshots`);
  const schemeAmcs = scalar(`SELECT COUNT(DISTINCT amc) AS value FROM schemes s WHERE ${active}`);
  const portfolioAmcs = scalar(`
    SELECT COUNT(DISTINCT amc) AS value
    FROM holding_portfolios hp
    WHERE EXISTS (SELECT 1 FROM portfolio_holdings ph WHERE ph.portfolio_id=hp.portfolio_id)
  `);

  console.log('Fund Analysis data coverage (read-only)');
  console.log('========================================');
  print('Latest NAV date', scalar('SELECT MAX(date) AS value FROM nav_daily'));
  print('Daily NAV rows', scalar('SELECT COUNT(*) AS value FROM nav_daily'));
  print('Latest TER date', scalar('SELECT MAX(date) AS value FROM scheme_ter_daily'));
  print('Daily TER rows', scalar('SELECT COUNT(*) AS value FROM scheme_ter_daily'));
  print('Latest AAUM period end', scalar('SELECT MAX(period_end) AS value FROM scheme_aaum_periodic'));
  print('Latest total-AUM date', scalar('SELECT MAX(date) AS value FROM scheme_total_aum_daily'));
  print('Latest portfolio disclosure', scalar('SELECT MAX(as_of_date) AS value FROM portfolio_holdings'));
  print('Portfolio AMC coverage', `${portfolioAmcs}/${schemeAmcs} active scheme AMCs`);
  print('Latest factsheet snapshot', scalar('SELECT MAX(as_of_date) AS value FROM scheme_factsheet_snapshots'));
  print('Factsheet AMC coverage', `${factsheetAmcs}/${schemeAmcs} active scheme AMCs`);
  print('Latest stored benchmark value', scalar('SELECT MAX(date) AS value FROM benchmark_nav_daily'));
  print('Debt categories with a benchmark mapping', scalar(`
    SELECT COUNT(DISTINCT s.category) AS value
    FROM schemes s JOIN category_benchmark_defaults cbd ON cbd.category=s.category
    WHERE s.category LIKE 'Debt Scheme - %'
  `));
  print('Debt categories with mapped daily benchmark values', scalar(`
    SELECT COUNT(DISTINCT s.category) AS value
    FROM schemes s
    JOIN category_benchmark_defaults cbd ON cbd.category=s.category
    WHERE s.category LIKE 'Debt Scheme - %'
      AND EXISTS (SELECT 1 FROM benchmark_nav_daily b WHERE b.benchmark_id=cbd.benchmark_id)
  `));

  console.log('\nAMCs still without an imported official factsheet snapshot:');
  const missingFactsheets = db.prepare(`
    SELECT DISTINCT s.amc
    FROM schemes s
    WHERE ${active} AND s.amc IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheme_factsheet_snapshots fs WHERE fs.source_amc=s.amc)
    ORDER BY s.amc
  `).all().map((row) => row.amc);
  console.log(missingFactsheets.length ? missingFactsheets.map((amc) => `- ${amc}`).join('\n') : '- none');

  console.log('\nAMCs without a stored monthly portfolio disclosure:');
  const missingPortfolios = db.prepare(`
    SELECT DISTINCT s.amc
    FROM schemes s
    WHERE ${active} AND s.amc IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM holding_portfolios hp
        JOIN portfolio_holdings ph ON ph.portfolio_id=hp.portfolio_id
        WHERE hp.amc=s.amc
      )
    ORDER BY s.amc
  `).all().map((row) => row.amc);
  console.log(missingPortfolios.length ? missingPortfolios.map((amc) => `- ${amc}`).join('\n') : '- none');
}

main();
