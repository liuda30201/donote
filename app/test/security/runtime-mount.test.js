'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSecurityRuntime } = require('../../src/security/runtime');
const { createApp } = require('../../src/app');

test('security runtime mounts protected device routes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-mount-'));
  const keyPath = path.join(root, 'key'); fs.writeFileSync(keyPath, crypto.randomBytes(32), {mode:0o600});
  const storageRoot = path.join(root, 'data'); fs.mkdirSync(storageRoot);
  const runtime = createSecurityRuntime({storageRoot,env:{AUTH_KEY_FILE:keyPath,AUTH_ORIGIN:'http://127.0.0.1:3000',AUTH_DEV_HTTP:'1'}});
  t.after(() => { runtime.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const { app, server, io } = createApp({authService:runtime.authService, securityRouter:runtime.securityRouter, adminRouter:runtime.adminRouter});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => io.close(resolve)); });
  assert.equal(app.get('securityRouter'), runtime.securityRouter);
  assert.equal(app.get('adminRouter'), runtime.adminRouter);
  const adminResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/users`);
  assert.equal(adminResponse.status, 401);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/sessions`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'AUTH_FAILED');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
