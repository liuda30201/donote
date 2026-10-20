'use strict';

const { hashPassword } = require('./primitives');

// Bootstrap only an empty database. Subsequent restarts never reset credentials.
async function initializeAdmin({ db, repo, env }) {
  if (db.prepare('SELECT count(*) AS n FROM users').get().n !== 0) return false;
  if (!env.ADMIN_EMAIL && !env.ADMIN_PASSWORD) return false;
  const email = typeof env.ADMIN_EMAIL === 'string' ? env.ADMIN_EMAIL.trim().toLowerCase() : '';
  const username = email.split('@')[0];
  if (email.length > 254 || !username || username.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)) throw new Error('Valid ADMIN_EMAIL required for initialization');
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  return db.transaction(() => {
    if (db.prepare('SELECT count(*) AS n FROM users').get().n !== 0) return false;
    const at = Date.now();
    const user = repo.createUser({ username, displayName: username, passwordHash, role: 'admin', emailAccount: true, at });
    repo.email.setInitialPreference({ userId: user.id, email, at });
    repo.addAudit({ actorId: user.id, targetId: user.id, action: 'user.created', at, detail: { source: 'env-bootstrap' } });
    return true;
  }).immediate();
}

module.exports = { initializeAdmin };
