const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('消息与文件路由在独立数据目录中保持原有行为', async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-clipboard-test-'));
  process.env.STORAGE_ROOT = storageRoot;
  process.env.ACCESS_PASSWORD = 'test-only-password';
  process.env.ACCESS_PASSWORDS = '';
  const { createApp } = require('../src/app');
  const { hasPendingPersist } = require('../src/storage');
  const { server, io } = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const credentials = { 'x-access-password': process.env.ACCESS_PASSWORD };

  t.after(async () => {
    await new Promise((resolve) => io.close(resolve));
    while (hasPendingPersist()) await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  async function jsonRequest(url, method, body) {
    return fetch(base + url, {
      method,
      headers: { ...credentials, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  let messageId;
  await t.test('登录、静态资源与未知 API', async () => {
    const landing = await fetch(base + '/');
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /DoNote.*复制过的内容，在这里继续/);
    assert.match(landingHtml, /进入工作台/);
    assert.match(landingHtml, /支持邮箱验证码自主注册登录/);
    const loginPage = await fetch(base + '/login');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /id="auth-section"/);
    const appPage = await fetch(base + '/app');
    assert.equal(appPage.status, 200);
    assert.match(await appPage.text(), /id="chat-section"/);
    assert.equal((await fetch(base + '/landing.css?v=3')).status, 200);
    assert.equal((await fetch(base + '/landing.js?v=1')).status, 200);
    for (const image of ['workspace-overview.png', 'collect-paste.png', 'search-preview.png', 'across-devices.png']) {
      assert.equal((await fetch(base + '/images/' + image)).status, 200);
    }
    const manifest = await (await fetch(base + '/manifest.json')).json();
    assert.equal(manifest.start_url, '/app');
    const status = await (await fetch(base + '/api/auth/status')).json();
    assert.deepEqual(status, { mode: 'single', requirePassword: true });
    assert.equal((await fetch(base + '/api/messages')).status, 401);
    assert.equal((await jsonRequest('/api/auth', 'POST', { password: 'wrong' })).status, 401);
    assert.equal((await jsonRequest('/api/auth', 'POST', { password: process.env.ACCESS_PASSWORD })).status, 200);
    const unknown = await fetch(base + '/api/messages/missing/endpoint', { headers: credentials });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'Not Found');
  });

  await t.test('拒绝 URL 密码与超限 JSON，404 不回显查询凭据', async () => {
    const queryOnly = await fetch(base + '/api/messages?password=' + encodeURIComponent(process.env.ACCESS_PASSWORD));
    assert.equal(queryOnly.status, 401);
    const oversized = await jsonRequest('/api/messages', 'POST', { type: 'text', content: 'a'.repeat(1024 * 1024) });
    assert.equal(oversized.status, 413);
    const unknown = await fetch(base + '/api/nonexistent?password=secret');
    assert.deepEqual(await unknown.json(), { error: 'Not Found' });
  });

  await t.test('消息创建、搜索、备注、收藏与清空', async () => {
    const created = await jsonRequest('/api/messages', 'POST', { type: 'text', content: '整理回归测试' });
    assert.equal(created.status, 200);
    messageId = (await created.json()).message.id;
    while (hasPendingPersist()) await new Promise((resolve) => setTimeout(resolve, 10));
    const persisted = JSON.parse(await fs.readFile(path.join(storageRoot, 'messages.json'), 'utf8'));
    assert.equal(persisted.messages.some((message) => message.id === messageId), true);
    assert.equal((await jsonRequest('/api/messages/groups', 'POST', { name: 'a项目' })).status, 200);
    const groupsRes = await (await fetch(base + '/api/messages/groups', { headers: credentials })).json();
    assert.equal(groupsRes.groups.includes('a项目'), true);
    assert.equal((await jsonRequest(`/api/messages/${messageId}/title`, 'PATCH', { title: 'a项目' })).status, 200);
    assert.equal((await jsonRequest(`/api/messages/${messageId}/remark`, 'PATCH', { remark: '测试备注' })).status, 200);
    const search = await (await fetch(base + '/api/messages/search?q=' + encodeURIComponent('测试备注'), { headers: credentials })).json();
    assert.equal(search.messages[0].id, messageId);
    const typeOnlySearch = await (await fetch(base + '/api/messages/search?type=text', { headers: credentials })).json();
    assert.equal(typeOnlySearch.messages.some((m) => m.id === messageId), true);
    assert.equal((await fetch(base + '/api/messages/search', { headers: credentials })).status, 400);
    assert.equal((await jsonRequest(`/api/messages/${messageId}/favorite`, 'POST')).status, 200);
    assert.equal((await jsonRequest('/api/messages/clear', 'POST')).status, 200);
    const messages = await (await fetch(base + '/api/messages', { headers: credentials })).json();
    assert.equal(messages.messages.length, 1);
    assert.equal(messages.messages[0].favorite, true);
  });

  await t.test('上传、Cookie 下载、Range、预览与主动内容限制', async () => {
    async function upload(name, mime, content) {
      const body = new FormData();
      body.append('file', new Blob([content], { type: mime }), name);
      const response = await fetch(base + '/api/messages/upload', { method: 'POST', headers: credentials, body });
      assert.equal(response.status, 200);
      return (await response.json()).message.id;
    }
    const content = '{"hello":"world"}';
    const id = await upload('example.json', 'application/json', content);
    const url = `/api/messages/${id}/file-stream`;
    assert.equal((await fetch(base + url)).status, 401);
    const downloaded = await fetch(base + url, { headers: { Cookie: `wc_auth=${Buffer.from(process.env.ACCESS_PASSWORD).toString('base64')}` } });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
    assert.equal(await downloaded.text(), content);
    const preview = await fetch(base + url + '?inline=1', { headers: credentials });
    assert.match(preview.headers.get('content-disposition'), /^inline/);
    assert.equal(await preview.text(), content);
    const legacyDownload = await fetch(base + `/api/messages/${id}/file-download`, { headers: credentials });
    assert.equal(legacyDownload.status, 200);
    assert.equal(await legacyDownload.text(), content);
    const range = await fetch(base + url, { headers: { ...credentials, Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), content.slice(0, 4));
    const activeId = await upload('example.html', 'text/html', '<script>alert(1)</script>');
    const active = await fetch(base + `/api/messages/${activeId}/file-stream?inline=1`, { headers: credentials });
    assert.equal(active.headers.get('content-type'), 'application/octet-stream');
    assert.match(active.headers.get('content-disposition'), /^attachment/);
    assert.match(active.headers.get('content-security-policy'), /sandbox/);
    const largeId = await upload('large.txt', 'text/plain', 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal((await fetch(base + `/api/messages/${largeId}/file-stream?inline=1`, { headers: credentials })).status, 413);
    const imageBody = new FormData();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    imageBody.append('type', 'image');
    imageBody.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const imageResponse = await fetch(base + '/api/messages/upload', { method: 'POST', headers: credentials, body: imageBody });
    assert.equal(imageResponse.status, 200);
    const uploadedImage = (await imageResponse.json()).message;
    const imageId = uploadedImage.id;
    const cookieHeaders = { Cookie: `wc_auth=${Buffer.from(process.env.ACCESS_PASSWORD).toString('base64')}` };
    const thumbnail = await fetch(base + uploadedImage.content.thumbnail, { headers: cookieHeaders });
    assert.equal(thumbnail.status, 200, '页面使用上传结果返回的缩略图地址，应能加载图片');
    assert.equal(thumbnail.headers.get('content-type'), 'image/png');
    assert.match(thumbnail.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), png);
    assert.equal((await fetch(base + uploadedImage.content.thumbnail)).status, 401);
    const history = await (await fetch(base + '/api/messages', { headers: credentials })).json();
    const historicalImage = history.messages.find((message) => message.id === imageId);
    assert.equal(historicalImage.content.thumbnail, uploadedImage.content.thumbnail);
    const historicalThumbnail = await fetch(base + historicalImage.content.thumbnail, { headers: cookieHeaders });
    assert.equal(historicalThumbnail.status, 200, '历史图片使用认证接口，不需要迁移数据');
    assert.deepEqual(Buffer.from(await historicalThumbnail.arrayBuffer()), png);
    const imageFile = await fetch(base + `/api/messages/${imageId}/image-file?original=1`, { headers: credentials });
    assert.equal(imageFile.status, 200);
    assert.deepEqual(Buffer.from(await imageFile.arrayBuffer()), png);
    const original = await (await fetch(base + `/api/messages/${imageId}/image-original`, { headers: credentials })).json();
    assert.equal(original.original, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal((await jsonRequest(`/api/messages/${id}`, 'DELETE')).status, 200);
    assert.equal((await fetch(base + url, { headers: credentials })).status, 404);
  });

  await t.test('内部认证、禁用入口与删除', async () => {
    assert.equal((await fetch(base + '/api/messages/auth-verify')).status, 401);
    assert.equal((await fetch(base + '/api/messages/auth-verify', { headers: credentials })).status, 200);
    for (const url of ['/uploads/file.txt', '/api/share/example']) {
      assert.equal((await fetch(base + url, { headers: credentials })).status, 404);
    }
    assert.equal((await jsonRequest(`/api/messages/${messageId}`, 'DELETE')).status, 200);
    assert.equal((await jsonRequest(`/api/messages/${messageId}`, 'DELETE')).status, 404);
  });
});
