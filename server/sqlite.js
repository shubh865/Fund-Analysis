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
    // better-sqlite3 quietly ignores extra fields on a named-parameter object.
    // Node's built-in driver rejects them. Import rows deliberately carry more
    // source fields than each individual upsert needs, so retain that former
    // behaviour at this boundary rather than duplicating/reshaping every row.
    const namedParameters = new Set(
      [...String(sql).matchAll(/[$@:][A-Za-z_][A-Za-z0-9_]*/g)].map((match) => match[0].slice(1)),
    );
    const filterArguments = (args) => {
      if (args.length !== 1 || !args[0] || Array.isArray(args[0]) || typeof args[0] !== 'object' || !namedParameters.size) {
        return args;
      }
      const parameters = {};
      for (const [key, value] of Object.entries(args[0])) {
        const bareKey = key.replace(/^[$@:]/, '');
        if (namedParameters.has(bareKey)) parameters[bareKey] = value;
      }
      return [parameters];
    };
    return {
      run: (...args) => statement.run(...filterArguments(args)),
      get: (...args) => statement.get(...filterArguments(args)),
      all: (...args) => statement.all(...filterArguments(args)),
      iterate: (...args) => statement.iterate(...filterArguments(args)),
      columns: () => statement.columns(),
    };
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
        if (depth === 0) this.exec('ROLLBACK');
        else {
          this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
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
