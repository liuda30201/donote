const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('拆分后的文件接口保持多用户隔离', async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-clipboard-multi-test-'));
  process.env.STORAGE_ROOT = storageRoot;
  process.env.ACCESS_PASSWORD = '';
  process.env.ACCESS_PASSWORDS = 'alice:alice-test-password,bob:bob-test-password';
  process.env.MIGRATE_DEFAULT_USER = '';
  const { createApp } = require('../src/app');
  const { hasPendingPersist } = require('../src/storage');
  const { server, io } = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const alice = { 'x-access-password': 'alice-test-password' };
  const bob = { 'x-access-password': 'bob-test-password' };
  t.after(async () => {
    await new Promise((resolve) => io.close(resolve));
    while (hasPendingPersist()) await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  const status = await (await fetch(base + '/api/auth/status')).json();
  assert.deepEqual(status, { mode: 'multi', requirePassword: true });
  const body = new FormData();
  body.append('file', new Blob(['alice private file'], { type: 'text/plain' }), 'private.txt');
  const upload = await fetch(base + '/api/messages/upload', { method: 'POST', headers: alice, body });
  assert.equal(upload.status, 200);
  const id = (await upload.json()).message.id;
  const url = base + `/api/messages/${id}/file-stream`;
  assert.equal((await fetch(url, { headers: bob })).status, 404);
  assert.equal((await fetch(url + '?userId=alice', { headers: bob })).status, 401);
  const ownFile = await fetch(url, { headers: alice });
  assert.equal(ownFile.status, 200);
  assert.equal(await ownFile.text(), 'alice private file');
  const cookieDownload = await fetch(url, { headers: { Cookie: `wc_auth=${Buffer.from('alice-test-password').toString('base64')}` } });
  assert.equal(cookieDownload.status, 200);
  assert.equal(await cookieDownload.text(), 'alice private file');

  const imageBody = new FormData();
  imageBody.append('type', 'image');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  imageBody.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const imageUpload = await fetch(base + '/api/messages/upload', { method: 'POST', headers: alice, body: imageBody });
  assert.equal(imageUpload.status, 200);
  const image = (await imageUpload.json()).message;
  const thumbnailUrl = base + image.content.thumbnail;
  const thumbnail = await fetch(thumbnailUrl, { headers: { Cookie: `wc_auth=${Buffer.from('alice-test-password').toString('base64')}` } });
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), png);
  assert.equal((await fetch(thumbnailUrl, { headers: bob })).status, 401);
  assert.equal((await fetch(thumbnailUrl)).status, 401);
});
