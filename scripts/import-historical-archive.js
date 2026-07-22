const path = require('node:path');
const Database = require('better-sqlite3');
process.env.SKIP_NAV_DATE_INDEX = '1';
const target = require('../server/db');

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'raw', 'funds.db'));
const sourceName = 'captn3m0-historical-mf-data';
const batchSize = 250_000;

function main() {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const sourceTables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schemes', 'nav')").all();
  if (sourceTables.length !== 2) throw new Error('The archive does not have the expected schemes and nav tables.');

  const existing = target.prepare('SELECT last_rowid, completed_at FROM import_progress WHERE source = ?').get(sourceName);
  if (existing?.completed_at) {
    console.log('Historical archive is already fully imported.');
    return;
  }
  const initialRowId = existing?.last_rowid || 0;

  // Preserve names and ISIN metadata supplied by the fresh AMFI feed where it
  // already exists; add archive-only (including discontinued) schemes.
  const addScheme = target.prepare(`
    INSERT INTO schemes (scheme_code, name)
    VALUES (?, ?)
    ON CONFLICT(scheme_code) DO NOTHING
  `);
  const saveProgress = target.prepare(`
    INSERT INTO import_progress (source, last_rowid, completed_at) VALUES (?, ?, NULL)
    ON CONFLICT(source) DO UPDATE SET last_rowid = excluded.last_rowid, completed_at = NULL
  `);
  const finishProgress = target.prepare(`
    INSERT INTO import_progress (source, last_rowid, completed_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET last_rowid = excluded.last_rowid, completed_at = CURRENT_TIMESTAMP
  `);

  const loadSchemes = target.transaction(() => {
    for (const scheme of source.prepare('SELECT scheme_code, scheme_name FROM schemes').iterate()) addScheme.run(String(scheme.scheme_code), scheme.scheme_name);
  });
  loadSchemes();

  // Let SQLite copy a range directly from the source database. This is far
  // faster than crossing the JavaScript boundary once per historical NAV.
  target.prepare('ATTACH DATABASE ? AS archive').run(sourcePath);
  const sourceLastRow = target.prepare('SELECT MAX(rowid) AS rowid FROM archive.nav').get().rowid;
  const copyBatch = target.prepare(`
    INSERT OR IGNORE INTO nav_daily (scheme_code, date, nav)
    SELECT CAST(scheme_code AS TEXT), date, nav
    FROM archive.nav
    WHERE rowid > ? AND rowid <= ?
  `);
  const commitBatch = target.transaction((startRowId, endRowId) => {
    copyBatch.run(startRowId, endRowId);
    saveProgress.run(sourceName, endRowId);
  });

  let lastRowId = initialRowId;
  let imported = 0;
  while (true) {
    if (lastRowId >= sourceLastRow) break;
    const endRowId = Math.min(lastRowId + batchSize, sourceLastRow);
    commitBatch(lastRowId, endRowId);
    imported += endRowId - lastRowId;
    lastRowId = endRowId;
    console.log(`Processed ${imported.toLocaleString()} archive NAV rows this run (through row ${lastRowId.toLocaleString()}).`);
  }
  target.exec('DETACH DATABASE archive');
  finishProgress.run(sourceName, lastRowId);
  target.exec('CREATE INDEX IF NOT EXISTS idx_nav_daily_date ON nav_daily(date)');
  console.log(`Historical import complete. Processed ${imported.toLocaleString()} archive NAV rows this run.`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
