const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SQLiteDatabase } = require('../server/sqlite');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutual-fund-sqlite-'));
const targetPath = path.join(directory, 'target.db');
const archivePath = path.join(directory, 'archive.db');

try {
  const db = new SQLiteDatabase(targetPath);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, nav REAL)');

  const save = db.prepare('INSERT INTO items (id, name, nav) VALUES (@id, @name, @nav)');
  assert.equal(save.run({ id: 1, name: 'First', nav: 10, category: 'extra source field' }).changes, 1);
  assert.equal(db.prepare('SELECT name FROM items WHERE id = @id').get({ id: 1, unused: true }).name, 'First');
  assert.equal(db.prepare('SELECT * FROM items WHERE nav >= @minimum').all({ minimum: 10, unused: true }).length, 1);
  assert.equal([...db.prepare('SELECT id FROM items WHERE id = @id').iterate({ id: 1, unused: true })].length, 1);

  const nested = db.transaction(() => {
    save.run({ id: 2, name: 'Second', nav: 20 });
    const inner = db.transaction(() => { save.run({ id: 3, name: 'Third', nav: 30 }); });
    inner();
  });
  nested();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items').get().count, 3);

  const rollback = db.transaction(() => {
    save.run({ id: 4, name: 'Discarded', nav: 40 });
    throw new Error('intentional rollback');
  });
  assert.throws(rollback, /intentional rollback/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items WHERE id = 4').get().count, 0);
  db.close();

  const archive = new SQLiteDatabase(archivePath);
  archive.exec('CREATE TABLE nav (scheme_code TEXT, date TEXT, nav REAL); INSERT INTO nav VALUES (\'1\', \'2026-01-01\', 100)');
  archive.close();

  const source = new SQLiteDatabase(archivePath, { readonly: true, fileMustExist: true });
  assert.equal(source.prepare('SELECT COUNT(*) AS count FROM nav').get().count, 1);
  source.close();

  const target = new SQLiteDatabase(targetPath);
  target.prepare('ATTACH DATABASE ? AS archive').run(archivePath);
  assert.equal(target.prepare('SELECT nav FROM archive.nav WHERE scheme_code = ?').get('1').nav, 100);
  target.exec('DETACH DATABASE archive');
  target.close();

  console.log('Node SQLite compatibility checks passed.');
} finally {
  // Windows can retain SQLite's file handle for a moment after close(). This
  // is only a disposable test directory, so never fail a valid verification
  // merely because that delayed cleanup has not completed yet.
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* temporary files are harmless */ }
}
