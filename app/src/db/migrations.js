'use strict';

const { createHash } = require('node:crypto');
function migrationError(message) { const error = new Error(message); error.code = 'DB_MIGRATION_INVALID'; return error; }
function normalizeMigrations(migrations) {
  if (!Array.isArray(migrations)) throw migrationError('Migrations must be an array');
  return migrations.map((migration, index) => {
    if (!migration || migration.version !== index + 1 || typeof migration.name !== 'string' || !migration.name.trim() || typeof migration.sql !== 'string' || !migration.sql.trim()) throw migrationError('Migrations require consecutive versions starting at 1, a name and SQL');
    const checksum = createHash('sha256').update(`${migration.name}\n${migration.sql}${migration.rebuildForeignKeys ? '\nrebuildForeignKeys=true' : ''}`, 'utf8').digest('hex');
    return { version: migration.version, name: migration.name, sql: migration.sql, checksum, rebuildForeignKeys: migration.rebuildForeignKeys === true };
  });
}
function applyMigrations(db, migrations = []) {
  const definitions = normalizeMigrations(migrations);
  if (db.inTransaction) throw migrationError('Migrations cannot run inside an existing transaction');
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL CHECK (applied_at >= 0)) STRICT`);
    const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    for (let index = 0; index < applied.length; index += 1) {
      const row = applied[index], expected = definitions[index];
      if (row.version !== index + 1 || !expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) throw migrationError('Unknown, reordered or modified database migration; refusing startup');
    }
    const insert = db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
    const pending = definitions.slice(applied.length);
    for (const migration of pending) {
      if (migration.rebuildForeignKeys && db.prepare("SELECT 1 FROM verification_preferences WHERE email IS NOT NULL GROUP BY email COLLATE NOCASE HAVING COUNT(*)>1 LIMIT 1").get()) throw migrationError('Duplicate historical email bindings must be resolved before upgrading');
      db.exec(migration.sql); insert.run(migration.version, migration.name, migration.checksum, Date.now()); }
    if (db.pragma('foreign_key_check').length) throw migrationError('Migration would violate existing foreign keys');
    return pending.map(({ version }) => version);
  }).immediate;
  const rebuilding = definitions.some(m => m.rebuildForeignKeys) && (() => { try { return db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()?.version < definitions.length; } catch { return true; } })();
  if (rebuilding) { db.pragma('foreign_keys = OFF'); if (db.pragma('foreign_keys', { simple: true }) !== 0) throw migrationError('Cannot disable foreign keys for rebuild'); }
  try { return migrate(); }
  finally { if (rebuilding) db.pragma('foreign_keys = ON'); }
}
module.exports = { applyMigrations };