'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.argv.includes('--fixture')) {
  (async () => {
    const root = process.env.STORAGE_ROOT;
    const userId = 'account-http-user';
    const usage = [];
    let quotaBytes = Number(process.env.TEST_QUOTA || 1);
    const repo = {
      findUserById(id) { return id === userId ? { id, deleted_at: null, storage_quota_bytes: quotaBytes } : null; },
      setStorageUsage({ storageBytes }) { usage.push(storageBytes); return true; }
    };
    const authService = {
      authenticateRequest() {
        return { user: { id: userId, role: 'user', security_version: 1 }, context: { userId }, session: {}, token: 'fixture' };
      },
      requireCsrf() {}
    };
    const storage = require('../src/storage');
    const upload = require('../src/upload');
    const { configureAccountQuota } = require('../src/quota-runtime');
    const { createApp } = require('../src/app');
    const quotaRuntime = configureAccountQuota({ storage, upload, repo, storageRoot: root, env: process.env });
    const { server, close } = createApp({ authService, quotaRuntime });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function send(method, url, body, headers = {}) {
      const response = await fetch(base + url, { method, headers, body });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    function form(name, content) {
      const body = new FormData();
      body.append('file', new Blob([content], { type: 'text/plain' }), name);
      return body;
    }
    async function physicalFiles(directory) {
      const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
      return entries.filter(entry => entry.isFile()).map(entry => entry.name);
    }
    const dataFile = path.join(root, 'users', userId, 'messages.json');
    const uploadRoot = path.join(root, 'users', userId, 'uploads');
    const messageFileState = async () => JSON.parse(await fs.readFile(dataFile, 'utf8').catch(() => '{"messages":[]}')).messages;
    let result;
    if (process.env.TEST_MODE === 'reject') {
      const multipartResult = await send('POST', '/api/messages/upload', form('quota-reject.txt', 'multipart quota payload'));
      const dataUrl = `data:text/plain;base64,${Buffer.from('DataURL quota payload').toString('base64')}`;
      const dataUrlResult = await send('POST', '/api/messages', JSON.stringify({ type: 'file', content: { dataUrl, name: 'quota-reject.txt' } }), { 'content-type': 'application/json' });
      result = { multipartResult, dataUrlResult, messages: await messageFileState(), files: await physicalFiles(uploadRoot) };
    } else {
      const first = await send('POST', '/api/messages/upload', form('success.txt', 'known successful upload bytes'));
      const afterCreateBytes = usage.at(-1);
      let deleteResult = null;
      if (first.body?.message?.id) deleteResult = await send('DELETE', `/api/messages/${first.body.message.id}`);
      const afterDeleteBytes = usage.at(-1);

      // Give one upload enough space but not two. Concurrent requests share the
      // real configured per-user mutation runner, so admission must serialize.
      const oneUploadDelta = Math.max(1, (afterCreateBytes || 0) - (afterDeleteBytes || 0));
      quotaBytes = (afterDeleteBytes || 0) + Math.ceil(oneUploadDelta * 1.5);
      const concurrent = await Promise.all([
        send('POST', '/api/messages/upload', form('parallel-a.txt', 'same-sized concurrent payload')),
        send('POST', '/api/messages/upload', form('parallel-b.txt', 'same-sized concurrent payload'))
      ]);
      const filesAfterConcurrent = await physicalFiles(uploadRoot);
      const messagesAfterConcurrent = await messageFileState();
      const usageAfterConcurrent = usage.at(-1);

      // Send a genuine, incomplete HTTP multipart request and abort only after
      // the upload middleware registers its active temporary file.
      const { getActiveTempFiles } = require('../src/upload');
      const http = require('node:http');
      const tempDir = path.join(root, 'temp');
      const abortResult = await new Promise(resolve => {
        const boundary = 'quota-abort-boundary';
        const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/messages/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
        request.on('error', () => {});
        request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="abort.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        let sent = 0; let observedActive = false; let zeroSince = null;
        const pump = setInterval(() => {
          if (request.destroyed) { clearInterval(pump); return; }
          sent += 32 * 1024;
          if (sent >= 8 * 1024 * 1024) { clearInterval(pump); request.destroy(); return; }
          request.write(Buffer.alloc(32 * 1024));
        }, 10);
        const startedAt = Date.now();
        const poll = setInterval(async () => {
          const active = getActiveTempFiles().size;
          if (active > 0) {
            observedActive = true;
            clearInterval(pump);
            request.destroy();
          }
          if (observedActive && active === 0) {
            zeroSince ??= Date.now();
            if (Date.now() - zeroSince >= 100) {
              clearInterval(poll);
              resolve({ observedActive, remainingActive: active, residualFiles: await physicalFiles(tempDir) });
            }
          }
          if (Date.now() - startedAt > 5000) {
            clearInterval(poll); clearInterval(pump); request.destroy();
            resolve({ observedActive, remainingActive: getActiveTempFiles().size, residualFiles: await physicalFiles(tempDir) });
          }
        }, 5);
      });

      result = {
        first, deleteResult, afterCreateBytes, afterDeleteBytes, quotaBytes,
        concurrentStatuses: concurrent.map(response => response.status),
        filesAfterConcurrent, messagesAfterConcurrent, usageAfterConcurrent,
        abortResult, usage
      };
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    await close();
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  function runFixture({ quota = 1, mode = 'reject' } = {}) {
    return new Promise((resolve, reject) => {
      fs.mkdtemp(path.join(os.tmpdir(), 'donote-quota-http-')).then(root => {
        const child = spawn(process.execPath, [__filename, '--fixture'], {
          env: { ...process.env, AUTH_MODE: 'accounts', AUTH_ORIGIN: 'http://127.0.0.1', STORAGE_ROOT: root, UPLOAD_ROOT: path.join(root, 'uploads'), TEST_QUOTA: String(quota), TEST_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = ''; let error = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { error += chunk; });
        child.on('error', reject);
        child.on('close', async code => {
          await fs.rm(root, { recursive: true, force: true });
          if (code !== 0) return reject(new Error(`fixture exited ${code}: ${error}`));
          try { resolve(JSON.parse(output.trim().split('\n').pop())); } catch (cause) { reject(new Error(`invalid fixture output: ${output}\n${error}`, { cause })); }
        });
      }).catch(reject);
    });
  }

  test('account HTTP multipart and DataURL uploads are rejected and rolled back by physical quota', async () => {
    const result = await runFixture({ quota: 1, mode: 'reject' });
    assert.equal(result.multipartResult.status, 413);
    assert.equal(result.dataUrlResult.status, 413);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.files, []);
  });

  test('account HTTP success/delete releases DB usage and concurrent uploads stay within quota', async () => {
    const result = await runFixture({ quota: 100000, mode: 'success' });
    assert.equal(result.first.status, 200);
    assert.equal(result.deleteResult?.status, 200);
    assert.ok(result.afterCreateBytes > result.afterDeleteBytes, 'DB usage drops after deleting the upload');
    assert.ok(result.concurrentStatuses.filter(status => status === 200).length <= 1, 'concurrent requests cannot both commit');
    assert.deepEqual([...result.concurrentStatuses].sort(), [200, 413], 'queued request must reach quota admission with its own upload files');
    assert.ok(result.usageAfterConcurrent <= result.quotaBytes, 'stored usage is within account quota');
    assert.equal(result.messagesAfterConcurrent.length, 1);
    assert.equal(result.filesAfterConcurrent.length, 1);
    assert.equal(result.abortResult.remainingActive, 0);
    assert.equal(result.abortResult.residualFiles.length, 0);
    assert.deepEqual(result.abortResult.residualFiles, []);
  });
}
