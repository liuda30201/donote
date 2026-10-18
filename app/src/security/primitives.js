'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');

const PASSWORD_POLICY = Object.freeze({ minLength: 12, maxBytes: 1024, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 });
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function passwordBytes(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_POLICY.minLength || Buffer.byteLength(password, 'utf8') > PASSWORD_POLICY.maxBytes) {
    throw new TypeError('Password must contain at least 12 characters and at most 1024 UTF-8 bytes');
  }
  return Buffer.from(password, 'utf8');
}

async function hashPassword(password) {
  const bytes = passwordBytes(password);
  try {
    return await argon2.hash(bytes, { type: argon2.argon2id, version: 0x13, salt: crypto.randomBytes(16), memoryCost: PASSWORD_POLICY.memoryCost, timeCost: PASSWORD_POLICY.timeCost, parallelism: PASSWORD_POLICY.parallelism, hashLength: PASSWORD_POLICY.hashLength });
  } finally { bytes.fill(0); }
}

async function verifyPassword(password, encoded) {
  let bytes;
  try {
    bytes = passwordBytes(password);
    // Only this fixed policy is accepted; never run attacker-selected memory/work parameters.
    if (typeof encoded !== 'string' || !/^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(encoded)) return false;
    return await argon2.verify(encoded, bytes);
  } catch { return false; }
  finally { if (bytes) bytes.fill(0); }
}

function generateToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new TypeError('Invalid opaque token');
  return crypto.createHash('sha256').update(token, 'ascii').digest('hex');
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Hash to fixed length; timingSafeEqual requires equally sized buffers.
  const equal = crypto.timingSafeEqual(crypto.createHash('sha256').update(aa).digest(), crypto.createHash('sha256').update(bb).digest());
  const sameLength = aa.length === bb.length;
  return equal && sameLength;
}

function encodeBase32(bytes) {
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += BASE32[(value >>> bits) & 31]; }
  }
  if (bits) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}
function decodeBase32(secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 128 || !/^[A-Z2-7]+$/.test(secret)) throw new TypeError('Invalid canonical Base32 secret');
  let bits = 0; let value = 0; const bytes = [];
  for (const char of secret) {
    value = (value << 5) | BASE32.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const result = Buffer.from(bytes);
  if (encodeBase32(result) !== secret) throw new TypeError('Noncanonical Base32 secret');
  return result;
}
function generateTotpSecret() { return encodeBase32(crypto.randomBytes(20)); }
function totpOptions({ now = Date.now(), digits = 6, window = 1 } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || ![6, 8].includes(digits) || !Number.isInteger(window) || window < 0 || window > 1) throw new TypeError('Invalid TOTP options');
  return { counter: Math.floor(now / 30000), digits, window };
}
function atCounter(key, counter, digits) {
  const moving = Buffer.alloc(8); moving.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(moving).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}
function generateTotp(secret, options) {
  const { counter, digits } = totpOptions(options);
  const key = decodeBase32(secret);
  try { return atCounter(key, counter, digits); } finally { key.fill(0); }
}
function verifyTotp(secret, code, options) {
  const { counter, digits, window } = totpOptions(options);
  if (typeof code !== 'string' || !new RegExp(`^[0-9]{${digits}}$`).test(code)) return null;
  const key = decodeBase32(secret);
  let matched = null;
  try {
    for (let candidate = Math.max(0, counter - window); candidate <= counter + window; candidate += 1) {
      if (constantTimeEqual(atCounter(key, candidate, digits), code)) matched = candidate;
    }
    return matched;
  } finally { key.fill(0); }
}

function aadContext({ userId, purpose, keyId }) {
  for (const field of [userId, purpose, keyId]) if (typeof field !== 'string' || field.length < 1 || field.length > 128) throw new TypeError('Explicit encryption context required');
  return Buffer.from(JSON.stringify(['donote-secret', 1, userId, purpose, keyId]), 'utf8');
}
function requireKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('An explicit 32-byte key is required'); }
function encryptSecret(plaintext, key, context) {
  requireKey(key);
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > 4096) throw new TypeError('Invalid secret plaintext');
  const aad = aadContext(context); const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'aes-256-gcm', keyId: context.keyId, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function strictBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('Invalid encoding');
  return bytes;
}
function decryptSecret(envelope, key, context) {
  requireKey(key);
  const aad = aadContext(context);
  try {
    if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.keyId !== context.keyId) throw new Error('Invalid envelope');
    const nonce = strictBase64(envelope.nonce, 12); const tag = strictBase64(envelope.tag, 16);
    const ciphertext = strictBase64(envelope.ciphertext, 4096);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Error('Secret authentication failed'); }
}
function generateRecoveryCodes(count = 10) {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new TypeError('Invalid recovery code count');
  return Array.from({ length: count }, () => crypto.randomBytes(16).toString('hex').match(/.{8}/g).join('-'));
}
function hashRecoveryCode(code) {
  if (typeof code !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(code)) throw new TypeError('Invalid recovery code');
  return crypto.createHash('sha256').update('donote-recovery-v1\0').update(code, 'ascii').digest('hex');
}

module.exports = { PASSWORD_POLICY, hashPassword, verifyPassword, generateToken, hashToken, constantTimeEqual, generateTotpSecret, generateTotp, verifyTotp, encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode };
