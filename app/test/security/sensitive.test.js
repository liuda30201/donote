'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const s = require('../../src/security/sensitive');

const context = { userId: 'synthetic-user', messageId: 'synthetic-message', keyId: 'synthetic-key-1' };
const text = { content: 'synthetic-sensitive-body-正文', remark: 'synthetic-sensitive-remark-备注' };
const scope = { userId: context.userId, sessionId: 'synthetic-session', securityVersion: 1, messageId: context.messageId, action: 'reveal' };
const failure = { name: 'Error', message: 'Sensitive text authentication failed' };

function fixture() {
  const key = crypto.randomBytes(32);
  return { key, payload: s.encryptSensitiveText(text, key, context) };
}
test('independent body and remark envelopes round-trip with fresh nonces and no serialized plaintext', () => {
  const { key, payload } = fixture();
  assert.deepEqual(s.decryptSensitiveText(JSON.parse(JSON.stringify(payload)), key, context), text);
  const next = s.encryptSensitiveText(text, key, context);
  assert.notEqual(payload.content.nonce, payload.remark.nonce);
  assert.notEqual(payload.content.nonce, next.content.nonce);
  for (const field of ['content', 'remark']) {
    assert.equal(payload[field].keyId, context.keyId);
    assert.equal(payload[field].algorithm, 'aes-256-gcm');
    assert.equal(Buffer.from(payload[field].nonce, 'base64').length, 12);
    assert.equal(Buffer.from(payload[field].tag, 'base64').length, 16);
    assert.equal(JSON.stringify(payload).includes(text[field]), false);
  }
});
test('wrong user, message, field, key ID and key have a single authentication failure', () => {
  const { key, payload } = fixture();
  for (const change of [{ userId: 'other-user' }, { messageId: 'other-message' }, { keyId: 'other-key' }]) {
    assert.throws(() => s.decryptSensitiveText(payload, key, { ...context, ...change }), failure);
  }
  assert.throws(() => s.decryptSensitiveText({ ...payload, content: payload.remark, remark: payload.content }, key, context), failure);
  assert.throws(() => s.decryptSensitiveText(payload, crypto.randomBytes(32), context), failure);
  assert.throws(() => s.decryptSensitiveText(payload, Buffer.alloc(31), context), failure);
  assert.throws(() => s.decryptSensitiveText(payload, key, null), failure);
});
test('tampered, truncated, noncanonical and unexpected payloads fail closed', () => {
  const { key, payload } = fixture();
  for (const field of ['content', 'remark']) {
    for (const part of ['nonce', 'tag', 'ciphertext']) {
      const bytes = Buffer.from(payload[field][part], 'base64'); bytes[0] ^= 1;
      const damaged = { ...payload, [field]: { ...payload[field], [part]: bytes.toString('base64') } };
      assert.throws(() => s.decryptSensitiveText(damaged, key, context), failure);
    }
    for (const change of [{ version: 2 }, { algorithm: 'none' }, { keyId: 'unknown' }, { nonce: 'AA==' }, { tag: payload[field].tag + '=' }, { ciphertext: 'a'.repeat(6000) }, { plaintext: text[field] }]) {
      assert.throws(() => s.decryptSensitiveText({ ...payload, [field]: { ...payload[field], ...change } }, key, context), failure);
    }
  }
  for (const bad of [null, {}, { ...payload, version: 2 }, { ...payload, plaintext: text.content }]) {
    assert.throws(() => s.decryptSensitiveText(bad, key, context), failure);
  }
});
test('explicit fields enforce one MiB UTF-8 bounds without truncation', () => {
  const key = crypto.randomBytes(32);
  const max = { content: 'x'.repeat(s.MAX_FIELD_BYTES), remark: '' };
  assert.deepEqual(s.decryptSensitiveText(s.encryptSensitiveText(max, key, context), key, context), max);
  for (const bad of [{ content: 'x'.repeat(s.MAX_FIELD_BYTES + 1), remark: '' }, { content: '', remark: '长'.repeat(Math.floor(s.MAX_FIELD_BYTES / 3) + 1) }, { content: '\ud800', remark: '' }, { content: null, remark: '' }, { content: '' }, { ...text, extra: 'unsafe' }]) {
    assert.throws(() => s.encryptSensitiveText(bad, key, context), TypeError);
  }
  assert.throws(() => s.encryptSensitiveText(text, key, { ...context, messageId: '' }), TypeError);
  const bom = { content: '\ufeffsynthetic-content', remark: '🙂'.repeat(2048) };
  assert.deepEqual(s.decryptSensitiveText(s.encryptSensitiveText(bom, key, context), key, context), bom);
});
test('locked serializer allowlists metadata and drops both stale plaintext and ciphertext', () => {
  const { payload } = fixture();
  const record = { id: context.messageId, type: 'text', sensitive: true, ...text, encryptedPayload: payload, stale: { plaintext: text.content } };
  const locked = s.serializeSensitiveText(record);
  assert.deepEqual(locked, { id: context.messageId, type: 'text', sensitive: true, content: null, remark: '' });
  assert.equal(JSON.stringify(locked).includes(text.content), false);
  assert.equal(JSON.stringify(locked).includes(text.remark), false);
  assert.equal(JSON.stringify(locked).includes(payload.content.ciphertext), false);
  assert.equal(record.content, text.content); // Pure helper, not secure erasure.
  assert.throws(() => s.serializeSensitiveText({ ...record, type: 'image' }), TypeError);
  assert.throws(() => s.serializeSensitiveText({ ...record, sensitive: false }), TypeError);
});
test('unlock grants bind every scope component and consume once without sliding renewal', () => {
  let current = 1000;
  const grants = s.createSensitiveUnlockGrants({ now: () => current });
  const issued = grants.issue(scope, 2000);
  assert.equal(issued.expiresAt, 2000);
  assert.equal(Buffer.from(issued.token, 'base64url').length, 32);
  for (const change of [{ userId: 'other' }, { sessionId: 'other' }, { securityVersion: 2 }, { messageId: 'other' }, { action: 'export' }]) {
    assert.equal(grants.consume(issued.token, { ...scope, ...change }), false);
  }
  current = 1999;
  assert.equal(grants.consume(issued.token, scope), true);
  assert.equal(grants.consume(issued.token, scope), false);
  const expires = grants.issue(scope, 3000);
  current = 3000;
  assert.equal(grants.consume(expires.token, scope), false); // Exact deadline fails.
  current = 1500;
  assert.equal(grants.consume(expires.token, scope), false); // Clock rollback cannot revive.
  assert.throws(() => grants.issue(scope, 3000), TypeError);
  assert.throws(() => grants.issue(scope, 3000 + s.MAX_UNLOCK_MS + 1), TypeError);
});
test('grants revoke individually, by user/session, or all; state is not serialized or shared', () => {
  const grants = s.createSensitiveUnlockGrants({ now: () => 1000 });
  const first = grants.issue(scope, 2000);
  assert.equal(grants.revoke(first.token), true);
  assert.equal(grants.revoke(first.token), false);
  assert.equal(grants.consume(first.token, scope), false);
  const own = grants.issue(scope, 2000);
  const other = grants.issue({ ...scope, sessionId: 'other' }, 2000);
  assert.equal(grants.revokeSession(scope.userId, scope.sessionId), 1);
  assert.equal(grants.consume(own.token, scope), false);
  assert.equal(JSON.stringify(grants), '{}');
  assert.equal(s.createSensitiveUnlockGrants({ now: () => 1000 }).consume(other.token, { ...scope, sessionId: 'other' }), false);
  grants.clear();
  assert.equal(grants.consume(other.token, { ...scope, sessionId: 'other' }), false);
  assert.equal(grants.consume('malformed-token', scope), false);
});
test('keyring retains old decrypt keys, rotates to active key with verification, and never exposes keys', () => {
  const oldKey = crypto.randomBytes(32); const newKey = crypto.randomBytes(32);
  const old = s.encryptSensitiveText(text, oldKey, { ...context, keyId: 'old' });
  const oldSnapshot = JSON.stringify(old);
  const ring = s.createSensitiveKeyring({ activeKeyId: 'current', keys: { old: oldKey, current: newKey } });
  oldKey.fill(0); newKey.fill(0); // Defensive key copies remain usable.
  assert.deepEqual(ring.decrypt(old, { userId: context.userId, messageId: context.messageId }), text);
  const rotated = ring.rotate(old, { userId: context.userId, messageId: context.messageId });
  assert.equal(rotated.content.keyId, 'current');
  assert.equal(rotated.remark.keyId, 'current');
  assert.notEqual(rotated.content.nonce, old.content.nonce);
  assert.deepEqual(ring.decrypt(rotated, { ...context, keyId: 'current' }), text);
  assert.equal(JSON.stringify(old), oldSnapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(ring)), { activeKeyId: 'current' });
  assert.throws(() => ring.encrypt(text, { ...context, keyId: 'old' }), TypeError);
  assert.throws(() => ring.decrypt(old, { ...context, keyId: 'current' }), failure);
  const invalid = { ...old, remark: { ...old.remark, tag: 'AA==' } };
  assert.throws(() => ring.rotate(invalid, context), failure);
  const activeOnly = s.createSensitiveKeyring({ activeKeyId: 'current', keys: { current: crypto.randomBytes(32) } });
  assert.throws(() => activeOnly.decrypt(old, context), failure);
  ring.close(); ring.close();
  assert.throws(() => ring.encrypt(text, context), /closed/);
  assert.throws(() => ring.decrypt(rotated, context), failure);
  activeOnly.close();
});
test('keyring rejects missing, oversized, reused or malformed key configurations', () => {
  const key = crypto.randomBytes(32);
  for (const config of [{}, { activeKeyId: 'missing', keys: { old: key } }, { activeKeyId: 'old', keys: { old: Buffer.alloc(31) } }, { activeKeyId: 'old', keys: { old: key, current: key } }, { activeKeyId: 'old', keys: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i === 0 ? 'old' : `key-${i}`, crypto.randomBytes(32)])) }]) {
    assert.throws(() => s.createSensitiveKeyring(config), TypeError);
  }
});
test('user and message revocation are tenant-scoped across sessions', () => {
  const grants = s.createSensitiveUnlockGrants({ now: () => 1000 });
  const a = grants.issue(scope, 2000);
  const b = grants.issue({ ...scope, sessionId: 'other' }, 2000);
  const c = grants.issue({ ...scope, userId: 'other' }, 2000);
  assert.equal(grants.revokeMessage(scope.userId, scope.messageId), 2);
  assert.equal(grants.consume(a.token, scope), false);
  assert.equal(grants.consume(b.token, { ...scope, sessionId: 'other' }), false);
  assert.equal(grants.consume(c.token, { ...scope, userId: 'other' }), true);
  const d = grants.issue(scope, 2000);
  assert.equal(grants.revokeUser(scope.userId), 1);
  assert.equal(grants.consume(d.token, scope), false);
});
test('oversized base64 input is rejected before cryptographic processing', () => {
  const { key, payload } = fixture();
  const oversized = { ...payload, content: { ...payload.content, ciphertext: 'A'.repeat(Math.ceil(s.MAX_FIELD_BYTES / 3) * 4 + 4) } };
  assert.throws(() => s.decryptSensitiveText(oversized, key, context), failure);
});
test('grant helper bounds lifetime/capacity and prunes expired grants', () => {
  let current = 1000;
  const grants = s.createSensitiveUnlockGrants({ now: () => current, maxEntries: 1 });
  assert.throws(() => grants.issue(scope, 1000), TypeError);
  assert.throws(() => grants.issue(scope, 121001), TypeError);
  assert.throws(() => grants.issue({ ...scope, securityVersion: 0 }, 2000), TypeError);
  grants.issue(scope, 2000);
  assert.throws(() => grants.issue(scope, 2000), /capacity/);
  current = 2000;
  assert.equal(typeof grants.issue(scope, 3000).token, 'string');
  assert.throws(() => s.createSensitiveUnlockGrants({ now: () => NaN }).issue(scope, 3000), TypeError);
});
