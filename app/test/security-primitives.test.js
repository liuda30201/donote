'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = require('../src/security/primitives');

test('Argon2id uses real salted fixed-policy hashes, verifies and bounds input', async () => {
  const password = 'synthetic-password-长';
  const a = await p.hashPassword(password); const b = await p.hashPassword(password);
  assert.match(a, /^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$/);
  assert.notEqual(a, b);
  assert.equal(await p.verifyPassword(password, a), true);
  assert.equal(await p.verifyPassword('wrong-password', a), false);
  assert.equal(await p.verifyPassword(password, a.replace('m=65536', 'm=99999999')), false);
  assert.equal(await p.verifyPassword(password, 'not-a-hash'), false);
  assert.equal(await p.verifyPassword(null, a), false);
  await assert.rejects(p.hashPassword('short'), TypeError);
  await assert.rejects(p.hashPassword('长'.repeat(342)), TypeError);
  const max = 'a'.repeat(1024);
  assert.equal(await p.verifyPassword(max, await p.hashPassword(max)), true);
});

test('opaque tokens are random canonical 256-bit values and hashes are deterministic', () => {
  const a = p.generateToken(); const b = p.generateToken();
  assert.notEqual(a, b); assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.equal(p.hashToken(a), crypto.createHash('sha256').update(a).digest('hex'));
  assert.throws(() => p.hashToken(a + '='));
  assert.throws(() => p.hashToken('a'.repeat(43))); // noncanonical final bits
  assert.equal(p.constantTimeEqual('same', 'same'), true);
  assert.equal(p.constantTimeEqual('a', 'aa'), false);
  assert.equal(p.constantTimeEqual(null, ''), false);
});

test('TOTP matches RFC6238 Appendix B SHA1 vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, code] of vectors) {
    const now = seconds * 1000;
    assert.equal(p.generateTotp(secret, { now, digits: 8 }), code);
    assert.equal(p.verifyTotp(secret, code, { now, digits: 8, window: 0 }), Math.floor(seconds / 30));
    assert.equal(p.generateTotp(secret, { now }), code.slice(-6));
  }
});

test('TOTP validates canonical secrets, bounded windows and returns counter for repository CAS', () => {
  const secret = p.generateTotpSecret(); const now = 300000;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const code = p.generateTotp(secret, { now });
  assert.equal(p.verifyTotp(secret, code, { now: now + 30000 }), 10);
  assert.equal(p.verifyTotp(secret, code, { now: now + 60000 }), null);
  assert.equal(p.verifyTotp(secret, 123456, { now }), null);
  assert.equal(p.verifyTotp(secret, '12345 ', { now }), null);
  assert.throws(() => p.generateTotp(secret.toLowerCase(), { now }));
  assert.throws(() => p.generateTotp(secret + '=', { now }));
  assert.throws(() => p.generateTotp(secret, { now: -1 }));
  assert.throws(() => p.generateTotp(secret, { window: 2 }));
  // The primitive intentionally does not consume counters; repository must atomically reject reuse.
  assert.equal(p.verifyTotp(secret, code, { now }), 10);
});

test('AES256GCM authenticates user, purpose, key ID, ciphertext and envelope metadata', () => {
  const key = crypto.randomBytes(32); const context = { userId: 'synthetic-user-a', purpose: 'totp-secret', keyId: 'test-key-1' };
  const a = p.encryptSecret('synthetic-secret', key, context);
  const b = p.encryptSecret('synthetic-secret', key, context);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(p.decryptSecret(a, key, context), 'synthetic-secret');
  for (const change of [{ userId: 'synthetic-user-b' }, { purpose: 'recovery' }, { keyId: 'test-key-2' }]) assert.throws(() => p.decryptSecret(a, key, { ...context, ...change }), /authentication failed/);
  assert.throws(() => p.decryptSecret(a, crypto.randomBytes(32), context), /authentication failed/);
  for (const field of ['nonce', 'tag', 'ciphertext']) {
    const bytes = Buffer.from(a[field], 'base64'); bytes[0] ^= 1;
    assert.throws(() => p.decryptSecret({ ...a, [field]: bytes.toString('base64') }, key, context), /authentication failed/);
  }
  for (const change of [{ version: 2 }, { algorithm: 'aes-128-gcm' }, { nonce: 'AA==' }, { tag: a.tag + '=' }, { ciphertext: 'a'.repeat(6000) }]) assert.throws(() => p.decryptSecret({ ...a, ...change }, key, context));
  assert.throws(() => p.encryptSecret('secret', Buffer.alloc(31), context));
  assert.throws(() => p.encryptSecret('secret', key, { ...context, userId: '' }));
  assert.throws(() => p.encryptSecret('x'.repeat(4097), key, context));
  assert.equal(p.decryptSecret(p.encryptSecret('', key, context), key, context), '');
});

test('recovery codes have 128-bit entropy, bounded count, domain-separated hashes', () => {
  const codes = p.generateRecoveryCodes(); assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/);
    assert.match(p.hashRecoveryCode(code), /^[a-f0-9]{64}$/);
    assert.equal(p.hashRecoveryCode(code), p.hashRecoveryCode(code));
    assert.notEqual(p.hashRecoveryCode(code), crypto.createHash('sha256').update(code).digest('hex'));
  }
  assert.throws(() => p.generateRecoveryCodes(0));
  assert.throws(() => p.generateRecoveryCodes(21));
  assert.throws(() => p.hashRecoveryCode('bad-code'));
});
