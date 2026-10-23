'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = fs.mkdtemp(path.join(os.tmpdir(), 'donote-private-unlock-'));
process.env.AUTH_MODE = 'accounts';
process.env.AUTH_ORIGIN = 'https://private-unlock.test';
process.env.STORAGE_ROOT = root;

const { createApp } = require('../src/app');
const { getUserState } = require('../src/storage');
const { privateUnlockTarget } = require('../src/private-unlock');

function fixture() {
  let issued = new Map();
  let next = 0;
  const userId = 'private-unlock-user';
  const sessionId = 'private-unlock-session';
  const authService = {
    authenticateRequest() { return { user: { id: userId }, session: { id: sessionId }, context: { userId, sessionId } }; },
    requireCsrf() {},
    requireOrigin() {},
    emailVerification: {
      sendPrivateUnlock(req) {
        const target = privateUnlockTarget(req.body);
        const challenge = `private-challenge-${++next}`;
        issued.set(challenge, target);
        return { challenge, expiresAt: Date.now() + 300000, emailHint: 'p***@example.test' };
      },
      consume(challenge, code, scope, mutation) {
        const target = issued.get(challenge);
        if (!target || code !== '123456' || scope.userId !== userId || scope.sessionId !== sessionId || scope.purpose !== 'reauth' || JSON.stringify(scope.target) !== JSON.stringify(target)) {
          throw Object.assign(new Error('AUTH_FAILED'), { status: 401, code: 'AUTH_FAILED' });
        }
        issued.delete(challenge);
        return mutation();
      }
    }
  };
  const state = getUserState(userId);
  state.messages = [
    { id: 'card-current', type: 'text', timestamp: 1, content: 'current', remark: '', private: true },
    { id: 'card-other', type: 'text', timestamp: 2, content: 'other', remark: '', private: true },
    { id: 'card-public', type: 'text', timestamp: 3, content: 'public', remark: '' }
  ];
  return { authService, state, userId };
}

test('private unlock HTTP binds the email challenge and applies scoped temporary/permanent actions', async t => {
  const f = fixture();
  const application = createApp({ authService: f.authService });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  t.after(async () => {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { Origin: 'https://private-unlock.test', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { response, body: await response.json() };
  }
  async function issue(selection) {
    const result = await request('/api/auth/email/private-unlock', { action: 'private', ...selection });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body.challenge;
  }
  async function verify(challenge, selection, code = '123456') {
    return request('/api/messages/private/verify', { challenge, code, ...selection });
  }

  const currentSelection = { scope: 'current', messageId: 'card-current', duration: 'custom', hours: '1.5' };
  const challenge = await issue(currentSelection);
  const temporary = await verify(challenge, currentSelection);
  assert.equal(temporary.response.status, 200, JSON.stringify(temporary.body));
  assert.equal(temporary.body.scope, 'current');
  assert.equal(temporary.body.messageId, 'card-current');
  assert.ok(temporary.body.expiresAt > Date.now());
  assert.equal(f.state.messages.find(m => m.id === 'card-current').private, true);
  assert.equal(f.state.messages.find(m => m.id === 'card-other').private, true);

  const mismatchedChallenge = await issue(currentSelection);
  const mismatched = await verify(mismatchedChallenge, { scope: 'all', duration: '600' });
  assert.equal(mismatched.response.status, 401);
  assert.equal(f.state.messages.find(m => m.id === 'card-current').private, true);

  const permanentCurrent = { scope: 'current', messageId: 'card-current', duration: 'permanent' };
  const currentChallenge = await issue(permanentCurrent);
  const currentResult = await verify(currentChallenge, permanentCurrent);
  assert.equal(currentResult.response.status, 200, JSON.stringify(currentResult.body));
  assert.deepEqual(currentResult.body.updatedIds, ['card-current']);
  assert.equal(f.state.messages.find(m => m.id === 'card-current').private, undefined);
  assert.equal(f.state.messages.find(m => m.id === 'card-other').private, true);

  const permanentAll = { scope: 'all', duration: 'permanent' };
  const allChallenge = await issue(permanentAll);
  const allResult = await verify(allChallenge, permanentAll);
  assert.equal(allResult.response.status, 200, JSON.stringify(allResult.body));
  assert.deepEqual(allResult.body.updatedIds, ['card-other']);
  assert.equal(f.state.messages.find(m => m.id === 'card-other').private, undefined);
  assert.equal(f.state.messages.find(m => m.id === 'card-public').private, undefined);

  const invalid = await request('/api/auth/email/private-unlock', { action: 'private', scope: 'all', duration: 'custom', hours: '168.1' });
  assert.equal(invalid.response.status, 400);
});
