const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

class SQLiteDatabase {
  constructor(filename, options = {}) {
    if (options.fileMustExist && !fs.existsSync(filename)) {
      throw new Error(`SQLite database does not exist: ${filename}`);
    }

    this.database = new DatabaseSync(filename, {
      readOnly: Boolean(options.readonly),
      enableForeignKeyConstraints: true,
    });
    this.transactionDepth = 0;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    statement.setAllowBareNamedParameters(true);
    return statement;
  }

  exec(sql) {
    return this.database.exec(sql);
  }

  pragma(value) {
    return this.exec(`PRAGMA ${value}`);
  }

  transaction(fn) {
    return (...args) => {
      const depth = this.transactionDepth;
      const savepoint = `codex_transaction_${depth}`;
      this.transactionDepth += 1;
      this.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        this.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    };
  }

  close() {
    this.database.close();
  }
}

module.exports = { SQLiteDatabase };
