'use strict';

// E01 primitives. Message routes and persistence are integrated separately by E02.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { generateToken, hashToken } = require('./primitives');

const MAX_FIELD_BYTES = 1024 * 1024; // Hard allocation/DoS bound per UTF-8 field.
const MAX_UNLOCK_MS = 120000;
const AUTHENTICATION_FAILED = 'Sensitive text authentication failed';

function identifier(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new TypeError('Explicit sensitive text identity required');
  return value;
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('An explicit 32-byte content key is required');
}
function requireText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_FIELD_BYTES || !text.isWellFormed()) throw new TypeError('Sensitive text field must be bounded well-formed UTF-8');
}
function aadContext(context, field) {
  const { userId, messageId, keyId } = context || {};
  identifier(userId); identifier(messageId); identifier(keyId);
  return Buffer.from(JSON.stringify(['donote-sensitive-text', 1, userId, messageId, field, keyId]), 'utf8');
}
function encryptField(plaintext, key, context, field) {
  requireText(plaintext);
  const aad = aadContext(context, field);
  const nonce = crypto.randomBytes(12);
  const bytes = Buffer.from(plaintext, 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: bytes.length });
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', keyId: context.keyId, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { bytes.fill(0); }
}
function strictBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) { bytes.fill(0); throw new Error('Invalid encoding'); }
  return bytes;
}
function validEnvelope(envelope) {
  return exactKeys(envelope, ['version', 'algorithm', 'keyId', 'nonce', 'ciphertext', 'tag'])
    && envelope.version === 1 && envelope.algorithm === 'aes-256-gcm';
}
function decryptField(envelope, key, context, field) {
  if (!validEnvelope(envelope) || envelope.keyId !== context.keyId) throw new Error('Invalid envelope');
  const aad = aadContext(context, field);
  let nonce; let tag; let ciphertext; let plaintext;
  try {
    nonce = strictBase64(envelope.nonce, 12);
    tag = strictBase64(envelope.tag, 16);
    ciphertext = strictBase64(envelope.ciphertext, MAX_FIELD_BYTES);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    const pending = decipher.update(ciphertext);
    try {
      const final = decipher.final();
      try { plaintext = Buffer.concat([pending, final]); } finally { final.fill(0); }
    } finally { pending.fill(0); }
    if (plaintext.length > MAX_FIELD_BYTES) throw new Error('Invalid plaintext size');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } finally {
    if (nonce) nonce.fill(0);
    if (tag) tag.fill(0);
    if (ciphertext) ciphertext.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}
function encryptSensitiveText(text, key, context) {
  requireKey(key);
  if (!exactKeys(text, ['content', 'remark'])) throw new TypeError('Explicit content and remark required');
  const contentContext = { ...context };
  // Validate all inputs before encrypting either field.
  aadContext(contentContext, 'content');
  requireText(text.content); requireText(text.remark);
  return {
    version: 1,
    content: encryptField(text.content, key, contentContext, 'content'),
    remark: encryptField(text.remark, key, contentContext, 'remark')
  };
}
function decryptSensitiveText(payload, key, context) {
  try {
    requireKey(key);
    if (!exactKeys(payload, ['version', 'content', 'remark']) || payload.version !== 1
      || !validEnvelope(payload.content) || !validEnvelope(payload.remark)
      || payload.content.keyId !== payload.remark.keyId) throw new Error('Invalid payload');
    const contentContext = { ...context };
    const content = decryptField(payload.content, key, contentContext, 'content');
    try {
      const remark = decryptField(payload.remark, key, contentContext, 'remark');
      return { content, remark };
    } catch { throw new Error(AUTHENTICATION_FAILED); }
  } catch { throw new Error(AUTHENTICATION_FAILED); }
}

// Dedicated content keyring. Keys are defensively copied and never returned or serialized.
function createSensitiveKeyring({ activeKeyId, keys } = {}) {
  identifier(activeKeyId);
  if (!exactKeys(keys, keys && typeof keys === 'object' ? Object.keys(keys) : [])
    || Object.keys(keys).length < 1 || Object.keys(keys).length > 32 || !Object.hasOwn(keys, activeKeyId)) throw new TypeError('Explicit content keyring required');
  for (const [id, key] of Object.entries(keys)) { identifier(id); requireKey(key); }
  const entries = Object.entries(keys);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (crypto.timingSafeEqual(entries[i][1], entries[j][1])) throw new TypeError('Content key IDs must use distinct keys');
    }
  }
  const keyMap = new Map(entries.map(([id, key]) => [id, Buffer.from(key)]));
  let closed = false;
  function requireOpen() { if (closed) throw new Error('Content keyring closed'); }
  function decrypt(payload, context) {
    try {
      requireOpen();
      const id = payload && payload.content && payload.content.keyId;
      identifier(id);
      const key = keyMap.get(id);
      if (!key || (context && context.keyId !== undefined && context.keyId !== id)) throw new Error('Unknown key');
      return decryptSensitiveText(payload, key, { ...context, keyId: id });
    } catch { throw new Error(AUTHENTICATION_FAILED); }
  }
  function encrypt(text, context) {
    requireOpen();
    if (context && context.keyId !== undefined && context.keyId !== activeKeyId) throw new TypeError('Encryption requires active content key');
    return encryptSensitiveText(text, keyMap.get(activeKeyId), { ...context, keyId: activeKeyId });
  }
  return Object.freeze({
    activeKeyId,
    encrypt,
    decrypt,
    rotate(payload, context) {
      requireOpen();
      const plain = decrypt(payload, context);
      const rotated = encrypt(plain, { userId: context.userId, messageId: context.messageId });
      const verified = decrypt(rotated, { userId: context.userId, messageId: context.messageId });
      if (verified.content !== plain.content || verified.remark !== plain.remark) throw new Error(AUTHENTICATION_FAILED);
      return rotated; // Pure candidate: caller must atomically persist and retain old backup keys.
    },
    close() {
      if (!closed) { for (const key of keyMap.values()) key.fill(0); keyMap.clear(); closed = true; }
    }
  });
}

// Allowlist only. Never spread a storage record, even if it contains stale plaintext.
function serializeSensitiveText(record) {
  if (!record || record.sensitive !== true || record.type !== 'text') throw new TypeError('Sensitive text record required');
  return { id: identifier(record.id), type: 'text', sensitive: true, content: null, remark: '' };
}
function unlockScope(scope) {
  const { userId, sessionId, securityVersion, messageId, action } = scope || {};
  identifier(userId); identifier(sessionId); identifier(messageId);
  if (!Number.isSafeInteger(securityVersion) || securityVersion < 1 || action !== 'reveal') throw new TypeError('Explicit reveal scope required');
  return JSON.stringify([userId, sessionId, securityVersion, messageId, action]);
}

// Authorization/reauthentication must happen outside this helper before issue().
function createSensitiveUnlockGrants({ now = Date.now, maxEntries = 1000 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new TypeError('Invalid grant options');
  const grants = new Map();
  let lastNow = 0;
  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid grant clock');
    lastNow = Math.max(lastNow, value); // Clock rollback cannot extend an already observed deadline.
    return lastNow;
  }
  function prune() {
    const current = time();
    for (const [digest, grant] of grants) if (current >= grant.expiresAt) grants.delete(digest);
    return current;
  }
  return Object.freeze({
    issue(scope, expiresAt) {
      const binding = unlockScope(scope);
      const current = prune();
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= current || expiresAt - current > MAX_UNLOCK_MS) throw new TypeError('Unlock requires an absolute deadline within two minutes');
      if (grants.size >= maxEntries) throw new Error('Sensitive unlock capacity reached');
      const token = generateToken();
      grants.set(hashToken(token), { binding, userId: scope.userId, sessionId: scope.sessionId, messageId: scope.messageId, expiresAt });
      return { token, expiresAt };
    },
    consume(token, scope) {
      prune();
      let digest; let binding;
      try { digest = hashToken(token); binding = unlockScope(scope); } catch { return false; }
      const grant = grants.get(digest);
      if (!grant || grant.binding !== binding) return false;
      grants.delete(digest); // Synchronous one-shot consumption, before any caller decrypts.
      return true;
    },
    revoke(token) {
      prune();
      try { return grants.delete(hashToken(token)); } catch { return false; }
    },
    revokeUser(userId) {
      identifier(userId); prune();
      let count = 0;
      for (const [digest, grant] of grants) {
        if (grant.userId === userId) { grants.delete(digest); count += 1; }
      }
      return count;
    },
    revokeMessage(userId, messageId) {
      identifier(userId); identifier(messageId); prune();
      let count = 0;
      for (const [digest, grant] of grants) {
        if (grant.userId === userId && grant.messageId === messageId) { grants.delete(digest); count += 1; }
      }
      return count;
    },
    revokeSession(userId, sessionId) {
      identifier(userId); identifier(sessionId); prune();
      let count = 0;
      for (const [digest, grant] of grants) {
        if (grant.userId === userId && grant.sessionId === sessionId) { grants.delete(digest); count += 1; }
      }
      return count;
    },
    clear() { grants.clear(); }
  });
}

module.exports = { MAX_FIELD_BYTES, MAX_UNLOCK_MS, encryptSensitiveText, decryptSensitiveText, serializeSensitiveText, createSensitiveUnlockGrants, createSensitiveKeyring };
