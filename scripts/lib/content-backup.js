#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSensitiveKeyring } = require('../../app/src/security/sensitive');

function fail(message) { throw new Error(message); }
function canonicalBase64Key(value) {
  if (typeof value !== 'string') fail('invalid content key encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) { bytes.fill(0); fail('invalid content key encoding'); }
  return bytes;
}
function regular(file, label) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) fail(`${label} must be regular single-link mode 0600`);
  return st;
}
function regularData(file, label) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) fail(`${label} must be regular single-link file`);
  return st;
}
function loadRing(root, filename, authKeyFile) {
  if (!filename) return null;
  regular(filename, 'content keyring');
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(filename);
  if (realFile === realRoot || realFile.startsWith(realRoot + path.sep)) fail('content keyring must be outside storage root');
  const raw = fs.readFileSync(realFile, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 32768) fail('content keyring too large');
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'activeKeyId,keys,version' || value.version !== 1
    || typeof value.activeKeyId !== 'string' || !value.keys || Array.isArray(value.keys)
    || Object.getPrototypeOf(value.keys) !== Object.prototype
    || Object.keys(value.keys).length < 1 || Object.keys(value.keys).length > 32) fail('invalid content keyring');
  const keys = {};
  const buffers = [];
  for (const [id, encoded] of Object.entries(value.keys)) {
    if (typeof id !== 'string' || !id || id.length > 128) fail('invalid content key id');
    const key = canonicalBase64Key(encoded);
    if (buffers.some(other => crypto.timingSafeEqual(other, key))) { key.fill(0); fail('content key ids must be distinct'); }
    buffers.push(key); keys[id] = key;
  }
  if (!Object.hasOwn(keys, value.activeKeyId)) fail('invalid active content key');
  if (authKeyFile) {
    regular(authKeyFile, 'AUTH_KEY_FILE');
    const realAuth = fs.realpathSync(authKeyFile);
    if (realAuth === realRoot || realAuth.startsWith(realRoot + path.sep) || realAuth === realFile) fail('keys must be outside data and distinct files');
    const authKey = fs.readFileSync(realAuth);
    if (authKey.length !== 32) { authKey.fill(0); fail('invalid AUTH_KEY_FILE'); }
    try {
      if (buffers.some(key => crypto.timingSafeEqual(key, authKey))) fail('content key must differ from AUTH_KEY_FILE');
    } finally { authKey.fill(0); }
  }
  let ring;
  try { ring = createSensitiveKeyring({ activeKeyId: value.activeKeyId, keys }); }
  finally { for (const key of buffers) key.fill(0); }
  return ring;
}
function inspect(root, keyringFile, authKeyFile, expectedIds) {
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.sensitive-rotation')) fail('sensitive rotation journal must be moved outside data root');
  }
  const ring = loadRing(root, keyringFile, authKeyFile);
  const ids = new Set(); let sensitiveCount = 0;
  try {
    const usersRoot = path.join(root, 'users');
    if (fs.existsSync(usersRoot)) {
      const usersStat = fs.lstatSync(usersRoot);
      if (!usersStat.isDirectory() || usersStat.isSymbolicLink()) fail('unsafe users directory');
      for (const userId of fs.readdirSync(usersRoot)) {
        const userDir = path.join(usersRoot, userId);
        const dirStat = fs.lstatSync(userDir);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('users contains non-directory');
        const file = path.join(userDir, 'messages.json');
        if (!fs.existsSync(file)) continue;
        const fileStat = regularData(file, 'messages file');
        if ((fileStat.mode & 0o170000) !== 0o100000) fail('invalid messages file');
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!state || !Array.isArray(state.messages)) fail(`invalid messages state: ${userId}`);
        for (const record of state.messages) {
          if (!record || typeof record !== 'object' || Array.isArray(record)) fail('invalid message record');
          if (record.sensitive !== true) {
            if (Object.hasOwn(record, 'encryptedPayload')) fail('encrypted payload on non-sensitive record');
            continue;
          }
          sensitiveCount++;
          if (record.type !== 'text' || record.content !== null || record.remark !== '' || typeof record.id !== 'string' || !record.encryptedPayload) fail('sensitive plaintext or invalid record');
          if (!ring) fail('sensitive records require SENSITIVE_KEYRING_FILE');
          ring.decrypt(record.encryptedPayload, { userId, messageId: record.id });
          const a = record.encryptedPayload.content.keyId;
          const b = record.encryptedPayload.remark.keyId;
          if (a !== b) fail('sensitive envelope key mismatch');
          ids.add(a);
        }
      }
    }
    const requiredContentKeyIds = [...ids].sort();
    if (expectedIds !== null && JSON.stringify(requiredContentKeyIds) !== JSON.stringify(expectedIds)) fail('requiredContentKeyIds mismatch');
    return { requiredContentKeyIds, sensitiveRecords: sensitiveCount };
  } finally { if (ring) ring.close(); }
}
function main() {
  const args = process.argv.slice(2);
  const [command, root] = args;
  if (command !== 'inspect' || !root) fail('usage: content-backup.js inspect ROOT [--keyring FILE] [--auth-key FILE] [--expected-ids JSON]');
  const options = {};
  for (let i = 2; i < args.length; i += 2) {
    if (!['--keyring', '--auth-key', '--expected-ids'].includes(args[i]) || !args[i + 1]) fail('invalid options');
    options[args[i].slice(2)] = args[i + 1];
  }
  const expected = options['expected-ids'] === undefined ? null : JSON.parse(options['expected-ids']);
  if (expected !== null && (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || JSON.stringify([...new Set(expected)].sort()) !== JSON.stringify(expected))) fail('invalid expected key ids');
  process.stdout.write(JSON.stringify(inspect(path.resolve(root), options.keyring && path.resolve(options.keyring), options['auth-key'] && path.resolve(options['auth-key']), expected)) + '\n');
}
try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
