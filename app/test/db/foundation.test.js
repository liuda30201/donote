'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, applyMigrations } = require('../../src/db');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donote-db-'));
  const handles = [];
  t.after(() => {
    for (const db of handles) if (db.open) db.close();
    // root is the exact directory created above, never an application data path.
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, open(options = {}) {
    const db = openDatabase({ storageRoot: root, ...options });
    handles.push(db);
    return db;
  } };
}

const first = { version: 1, name: 'sample', sql: 'CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT' };

test('requires explicit storage root and validated timeout', () => {
  assert.throws(() => openDatabase(), { code: 'DB_PATH_UNSAFE' });
  assert.throws(() => openDatabase({ busyTimeoutMs: -1 }), TypeError);
});

test('opens native SQLite with secure pragmas, files and foundation-only schema', (t) => {
  const f = fixture(t);
  const db = f.open();
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'schema_migrations' }]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(fs.statSync(path.join(f.root, `donote.db${suffix}`)).mode & 0o777, 0o600);
    }
  }
});

test('applies migrations once, supports append, and persists across reopen', (t) => {
  const f = fixture(t);
  const db = f.open({ migrations: [first] });
  assert.deepEqual(applyMigrations(db, [first]), []);
  const second = { version: 2, name: 'append', sql: 'ALTER TABLE sample ADD COLUMN note TEXT' };
  assert.deepEqual(applyMigrations(db, [first, second]), [2]);
  db.close();
  const reopened = f.open({ migrations: [first, second] });
  assert.equal(reopened.prepare('SELECT count(*) n FROM schema_migrations').get().n, 2);
  assert.equal(reopened.prepare('PRAGMA table_info(sample)').all().length, 2);
});

test('rejects changed, deleted, reordered and discontinuous migrations', (t) => {
  const f = fixture(t);
  const db = f.open({ migrations: [first] });
  for (const definitions of [[], [{ ...first, name: 'renamed' }], [{ ...first, sql: first.sql + ';' }], [{ ...first, version: 2 }]]) {
    assert.throws(() => applyMigrations(db, definitions), { code: 'DB_MIGRATION_INVALID' });
  }
  assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n, 1);
});

test('rolls back all pending DDL and version records after migration failure', (t) => {
  const f = fixture(t);
  const db = f.open({ migrations: [first] });
  const pending = { version: 2, name: 'pending', sql: 'CREATE TABLE pending (id INTEGER)' };
  const broken = { version: 3, name: 'broken', sql: 'CREATE TABLE broken (' };
  assert.throws(() => applyMigrations(db, [first, pending, broken]));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='pending'").get().n, 0);
  assert.equal(db.prepare('SELECT max(version) n FROM schema_migrations').get().n, 1);
});

test('enforces foreign keys on the opened connection', (t) => {
  const f = fixture(t);
  const db = f.open();
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))');
  assert.throws(() => db.prepare('INSERT INTO child VALUES (?)').run(99), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
});

test('respects bounded busy timeout and does not partially apply a locked migration', (t) => {
  const f = fixture(t);
  const writer = f.open({ migrations: [first] });
  const contender = f.open({ migrations: [first], busyTimeoutMs: 20 });
  writer.exec('BEGIN IMMEDIATE');
  try {
    const second = { version: 2, name: 'locked', sql: 'CREATE TABLE locked (id INTEGER)' };
    assert.throws(() => applyMigrations(contender, [first, second]), { code: 'SQLITE_BUSY' });
    assert.equal(contender.prepare('SELECT max(version) n FROM schema_migrations').get().n, 1);
  } finally {
    writer.exec('ROLLBACK');
  }
});

test('refuses symlinked root and database files without touching their target', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'untouched');
  fs.writeFileSync(target, 'unchanged');
  const linkedRoot = path.join(f.root, 'linked');
  fs.symlinkSync(f.root, linkedRoot, 'dir');
  assert.throws(() => openDatabase({ storageRoot: linkedRoot }), { code: 'DB_PATH_UNSAFE' });
  fs.symlinkSync(target, path.join(f.root, 'donote.db'));
  assert.throws(() => f.open(), { code: 'DB_PATH_UNSAFE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});
