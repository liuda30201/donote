'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../../src/db');
const { SECURITY_MIGRATION } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');
const { createAuthService } = require('../../src/security/auth-service');
const p = require('../../src/security/primitives');
const { setupSocket, socketHelper } = require('../../src/socket');

// Faithful namespace/socket boundary: server emits are kept separate from incoming events.
class Namespace extends EventEmitter {
  use(fn) { this.middleware = fn; }
  connect(socket) {
    let error;
    this.middleware(socket, err => { error = err; });
    if (!error) this.emit('connection', socket);
    return error;
  }
}
class Socket extends EventEmitter {
  constructor(cookie, { origin = 'https://donote.test', auth = {} } = {}) {
    super(); this.handshake = { headers: { cookie, ...(origin ? { origin } : {}) }, auth, address: '127.0.0.1' };
    this.sent = []; this.rooms = new Set(); this.disconnected = false;
  }
  emit(event, data) { this.sent.push({ event, data }); return true; }
  receive(event, data) { return super.emit(event, data); }
  join(room) { this.rooms.add(room); }
  disconnect() { this.disconnected = true; super.emit('disconnect'); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-socket-'));
  const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] });
  const repo = createRepositories(db);
  const authService = createAuthService({ repo, allowedOrigins: ['https://donote.test'], encryptionKey: crypto.randomBytes(32), keyId: 'test' });
  const io = new Namespace(); const controller = setupSocket(io, { authService });
  t.after(() => { controller.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function user(name) { return repo.createUser({ username: name, displayName: name, passwordHash: 'unused-synthetic-hash' }); }
  function session(owner, duration = 60000) {
    const token = p.generateToken(); const at = Date.now();
    const row = repo.createSession({ userId: owner.id, token, csrfToken: p.generateToken(), authStrength: 'password', createdAt: at, idleExpiresAt: at + duration, expiresAt: at + duration });
    return { row, cookie: `__Host-dn_session=${token}` };
  }
  return { io, controller, repo, db, user, session };
}

test('session handshake requires Cookie and exact Origin, rejects client identity and isolates broadcasts', t => {
  const f = fixture(t); const a = f.user('alice'); const b = f.user('bob');
  const one = f.session(a); const two = f.session(b);
  for (const socket of [new Socket(''), new Socket(one.cookie, { origin: 'https://evil.test' }), new Socket(one.cookie, { origin: null }), new Socket(one.cookie, { auth: { password: 'old' } }), new Socket(one.cookie, { auth: { userId: b.id } })]) assert.ok(f.io.connect(socket));
  const sa = new Socket(one.cookie); const sb = new Socket(two.cookie);
  assert.equal(f.io.connect(sa), undefined); assert.equal(f.io.connect(sb), undefined);
  assert.equal(sa.userId, a.id); assert.equal(sa.sessionId, one.row.id);
  assert.deepEqual([...sa.rooms], [a.id]); assert.equal(sa.sent.filter(e => e.event === 'sync').length, 1);
  sa.receive('join', b.id); assert.deepEqual([...sa.rooms], [a.id]);
  const calls = [
    ['broadcastMessage', { text: 'private' }, 'message-new'], ['broadcastDelete', 'id', 'message-delete'],
    ['broadcastClear', {}, 'messages-clear'], ['broadcastFavorite', {}, 'message-favorite'], ['broadcastRemark', {}, 'message-remark']
  ];
  for (const [method, payload, event] of calls) {
    socketHelper[method](a.id, payload);
    assert.equal(sa.sent.filter(e => e.event === event).length, 1);
    assert.equal(sb.sent.filter(e => e.event === event).length, 0);
  }
  socketHelper.broadcastMessage(null, { text: 'must not broadcast globally' });
  assert.equal(sb.sent.filter(e => e.event === 'message-new').length, 0);
});

test('browser polling without Origin requires same-origin metadata and allowlisted Referer', t => {
  const f = fixture(t); const owner = f.user('browser'); const session = f.session(owner);
  function polling({ referer = 'https://donote.test/', site = 'same-origin', transport = 'polling', method = 'GET', origin = null } = {}) {
    const socket = new Socket(session.cookie, { origin });
    socket.handshake.query = { transport };
    Object.assign(socket.handshake.headers, { referer, 'sec-fetch-site': site });
    socket.request = { method };
    return socket;
  }
  const trusted = polling(); assert.equal(f.io.connect(trusted), undefined);
  assert.equal(trusted.userId, owner.id);
  for (const options of [
    { referer: 'https://evil.test/' }, { referer: undefined }, { referer: 'null' },
    { referer: 'https://donote.test.evil.test/' }, { referer: 'https://user@donote.test/' },
    { site: 'cross-site' }, { site: 'same-site' }, { site: '' },
    { transport: 'websocket' }, { method: 'POST' }, { origin: 'https://evil.test' }
  ]) {
    const socket = polling(options);
    if (Object.hasOwn(options, 'referer') && options.referer === undefined) delete socket.handshake.headers.referer;
    assert.ok(f.io.connect(socket), JSON.stringify(options));
  }
});

test('revocation, disabled account and security version prevent any subsequent private broadcast', t => {
  const f = fixture(t); const a = f.user('alice'); const one = f.session(a); const two = f.session(a);
  const sa = new Socket(one.cookie); const other = new Socket(two.cookie);
  f.io.connect(sa); f.io.connect(other);
  f.repo.revokeSession({ userId: a.id, sessionId: one.row.id });
  socketHelper.broadcastMessage(a.id, { private: true });
  assert.equal(sa.disconnected, true); assert.equal(other.disconnected, false);
  assert.equal(sa.sent.some(e => e.event === 'message-new'), false);
  assert.equal(sa.sent.filter(e => e.event === 'session-revoked').length, 1);
  f.db.prepare('UPDATE users SET security_version=security_version+1 WHERE id=?').run(a.id);
  f.controller.revalidateSessions(); assert.equal(other.disconnected, true);
  const b = f.user('bob'); const bs = f.session(b); const sb = new Socket(bs.cookie); f.io.connect(sb);
  f.repo.setDisabled({ userId: b.id, disabled: true });
  f.io.revalidateSessions(); assert.equal(sb.disconnected, true);
});

test('idle sockets expire and database revocation is detected without traffic; close clears polling', async t => {
  const f = fixture(t); const a = f.user('alice'); const short = f.session(a, 50); const one = new Socket(short.cookie);
  f.io.connect(one);
  await new Promise(resolve => setTimeout(resolve, 90)); assert.equal(one.disconnected, true);
  const long = f.session(a); const two = new Socket(long.cookie); f.io.connect(two);
  f.repo.revokeSession({ userId: a.id, sessionId: long.row.id });
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(two.disconnected, true);
  const last = f.session(a); const three = new Socket(last.cookie); f.io.connect(three);
  f.controller.close(); assert.equal(three.disconnected, true);
  const emitted = three.sent.length;
  socketHelper.broadcastMessage(a.id, {}); assert.equal(three.sent.length, emitted);
});
