'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../db');
const { ACCOUNT_MIGRATIONS } = require('../db/schema');
const { createRepositories } = require('../db/repositories');
const { createAuthService } = require('./auth-service');

function loadContentKeyring({ storageRoot, filename, authKey }) {
  if (!filename) return null;
  const crypto = require('node:crypto');
  const root = fs.realpathSync(storageRoot); const resolved = fs.realpathSync(filename);
  const relative = path.relative(root, resolved); const stat = fs.lstatSync(filename);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error('SENSITIVE_KEYRING_FILE must be an external 0600 regular file');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!config || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'activeKeyId,keys,version' || config.version !== 1 || !config.keys || Array.isArray(config.keys) || typeof config.keys !== 'object') throw new Error('Invalid content keyring configuration');
  const keys = {};
  try {
    for (const [id, value] of Object.entries(config.keys)) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid content key encoding');
      const key = Buffer.from(value, 'base64'); keys[id] = key;
      if (key.length !== 32 || key.toString('base64') !== value || crypto.timingSafeEqual(key, authKey)) throw new Error('Content keys must be independent of AUTH_KEY');
    }
    return require('./sensitive').createSensitiveKeyring({ activeKeyId: config.activeKeyId, keys });
  } finally { for (const key of Object.values(keys)) key.fill(0); }
}

// Explicit opt-in only. Never generate a replacement key on startup.
function createSecurityRuntime({ storageRoot, env = process.env }) {
  if (!env.AUTH_ORIGIN || !env.AUTH_KEY_FILE) throw new Error('Accounts mode requires AUTH_ORIGIN and AUTH_KEY_FILE');
  const rootPath = fs.realpathSync(storageRoot);
  const keyPath = fs.realpathSync(env.AUTH_KEY_FILE);
  const relativeKey = path.relative(rootPath, keyPath);
  if (!relativeKey || (!relativeKey.startsWith(`..${path.sep}`) && relativeKey !== '..' && !path.isAbsolute(relativeKey))) throw new Error('AUTH_KEY_FILE must be outside storage root');
  const stat = fs.lstatSync(env.AUTH_KEY_FILE);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('AUTH_KEY_FILE must be a private regular file (0600)');
  const key = fs.readFileSync(env.AUTH_KEY_FILE);
  if (key.length !== 32) throw new Error('AUTH_KEY_FILE must contain exactly 32 random bytes');
  const keyring = loadContentKeyring({ storageRoot, filename: env.SENSITIVE_KEYRING_FILE, authKey: key });
  const db = openDatabase({ storageRoot, migrations: ACCOUNT_MIGRATIONS });
  try {
    const repo = createRepositories(db);
    const origins = env.AUTH_ORIGIN.split(',').map(x => x.trim());
    const secureCookies = env.AUTH_DEV_HTTP !== '1';
    if (!secureCookies && origins.some(x => !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(x))) throw new Error('Development HTTP requires loopback origins');
    if (secureCookies && origins.some(x => !x.startsWith('https://'))) throw new Error('Production authentication requires HTTPS origins');
    const testMode = env.NODE_ENV !== 'production' && env.DONOTE_TEST_MODE === '1';
    const authService = createAuthService({ repo, allowedOrigins: origins, encryptionKey: key, keyId: env.AUTH_KEY_ID || 'primary', secureCookies, postLoginFactorSetup: env.TOTP_SETUP_AFTER_LOGIN !== '0', optionalFactorSetup: testMode && env.AUTH_TOTP_OPTIONAL === '1' });
    const mailer = require('./mailer').createMailer(env);
    const emailVerification = require('./email-verification').createEmailVerification({repo,authService,mailer,encryptionKey:key});
    authService.setEmailVerification(emailVerification);
    const operations = require('./operations').createOperationsService({ authService, repo, encryptionKey: key, keyId: env.AUTH_KEY_ID || 'primary' });
    const sensitiveService = require('./sensitive-service').createSensitiveService({ authService, verifyStrong: operations.verifyStrong, keyring });
    const { createSecurityRouter } = require('../routes/security');
    const securityRouter = createSecurityRouter({ authService, repo, encryptionKey: key, keyId: env.AUTH_KEY_ID || 'primary', operations });
    const { createAdminRouter } = require('../routes/admin');
    const adminRouter = createAdminRouter({ authService, repo, encryptionKey: key, keyId: env.AUTH_KEY_ID || 'primary' });
    return { db, repo, authService, emailVerification, mailer, sensitiveService, keyring, securityRouter, adminRouter, close() { mailer.close(); sensitiveService.close(); keyring?.close(); db.close(); key.fill(0); } };
  } catch (error) { db.close(); key.fill(0); keyring?.close(); throw error; }
}
module.exports = { createSecurityRuntime, loadContentKeyring };
