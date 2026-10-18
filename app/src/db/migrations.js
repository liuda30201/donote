'use strict';

const { createHash } = require('node:crypto');

function migrationError(message) {
  const error = new Error(message);
  error.code = 'DB_MIGRATION_INVALID';
  return error;
}

function normalizeMigrations(migrations) {
  if (!Array.isArray(migrations)) throw migrationError('Migrations must be an array');
  return migrations.map((migration, index) => {
    if (!migration || migration.version !== index + 1 ||
        typeof migration.name !== 'string' || !migration.name.trim() ||
        typeof migration.sql !== 'string' || !migration.sql.trim()) {
      throw migrationError('Migrations require consecutive versions starting at 1, a name and SQL');
    }
    // Migration SQL is trusted application code, never user input.
    const checksum = createHash('sha256')
      .update(`${migration.name}\n${migration.sql}`, 'utf8').digest('hex');
    return { version: migration.version, name: migration.name, sql: migration.sql, checksum };
  });
}

function applyMigrations(db, migrations = []) {
  const definitions = normalizeMigrations(migrations);
  // One write transaction serializes competing migrators and rolls back all pending DDL.
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    ) STRICT`);
    const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    for (let index = 0; index < applied.length; index += 1) {
      const row = applied[index];
      const expected = definitions[index];
      if (row.version !== index + 1 || !expected || row.version !== expected.version ||
          row.name !== expected.name || row.checksum !== expected.checksum) {
        throw migrationError('Unknown, reordered or modified database migration; refusing startup');
      }
    }
    const insert = db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
    const pending = definitions.slice(applied.length);
    for (const migration of pending) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.checksum, Date.now());
    }
    return pending.map(({ version }) => version);
  }).immediate();
}

module.exports = { applyMigrations };
