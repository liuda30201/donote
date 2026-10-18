'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('./migrations');

function pathError(message) {
  const error = new Error(message);
  error.code = 'DB_PATH_UNSAFE';
  return error;
}

function assertRegularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw pathError('Database files must be regular, non-linked files');
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function preparePath(storageRoot) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw pathError('An explicit storageRoot is required');
  }
  const root = path.resolve(storageRoot);
  // Reject a symlink at the supplied root. Trusted parent directories remain an operator responsibility.
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw pathError('storageRoot must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);
  const filename = path.join(root, 'donote.db');
  for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) assertRegularFile(file);
  try {
    const fd = fs.openSync(filename, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return filename;
}

/** Opens only an explicit private data root. Does not read environment variables or application data. */
function openDatabase({ storageRoot, migrations = [], busyTimeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
    throw new TypeError('busyTimeoutMs must be an integer between 0 and 60000');
  }
  const filename = preparePath(storageRoot);
  const db = new Database(filename, { timeout: busyTimeoutMs });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal' || db.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('SQLite WAL and foreign keys are required');
    }
    // FULL protects committed security state across power loss better than NORMAL.
    db.pragma('synchronous = FULL');
    applyMigrations(db, migrations);
    for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) assertRegularFile(file);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = { openDatabase, applyMigrations };
