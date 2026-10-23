'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_PRIVATE_UNLOCK_HOURS, privateUnlockTarget } = require('../src/private-unlock');

test('private unlock target validates scope and supported durations', () => {
  assert.equal(MAX_PRIVATE_UNLOCK_HOURS, 168);
  assert.deepEqual(privateUnlockTarget({ scope: 'current', messageId: 'm1', duration: '600' }), { action: 'private', scope: 'current', messageId: 'm1', seconds: 600 });
  assert.deepEqual(privateUnlockTarget({ scope: 'all', duration: '1800' }), { action: 'private', scope: 'all', messageId: null, seconds: 1800 });
  assert.deepEqual(privateUnlockTarget({ scope: 'current', messageId: 'm1', duration: 'custom', hours: '1.5' }).seconds, 5400);
  assert.equal(privateUnlockTarget({ scope: 'all', duration: 'permanent' }).seconds, -1);
});

test('private unlock target rejects invalid custom hours and cross-scope IDs', () => {
  for (const value of ['', '0', '168.1', '1.25', '1..5', '-1', 'abc']) {
    assert.throws(() => privateUnlockTarget({ scope: 'all', duration: 'custom', hours: value }), { code: 'INVALID_PRIVATE_UNLOCK' });
  }
  assert.throws(() => privateUnlockTarget({ scope: 'current', duration: '600' }), { code: 'INVALID_PRIVATE_UNLOCK' });
  assert.throws(() => privateUnlockTarget({ scope: 'all', messageId: 'm1', duration: '600' }), { code: 'INVALID_PRIVATE_UNLOCK' });
  assert.throws(() => privateUnlockTarget({ scope: 'other', duration: '600' }), { code: 'INVALID_PRIVATE_UNLOCK' });
});
