'use strict';

// Node entry point for the independent, cross-platform synthetic acceptance suite.
// The Python fixture substitutes Docker and never opens the repository data/ tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('backup/recovery synthetic acceptance suite', { timeout: 120000 }, () => {
  const suite = path.join(__dirname, 'v01_backup_recovery_independent.py');
  const result = spawnSync('python3', [suite, '-v'], {
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
});
