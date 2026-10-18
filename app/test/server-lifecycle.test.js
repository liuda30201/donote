'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function launch(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dn-server-lifecycle-'));
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUTH_MODE: 'legacy', ACCESS_PASSWORD: '', ACCESS_PASSWORDS: '', MIGRATE_DEFAULT_USER: '', STORAGE_ROOT: root, UPLOAD_ROOT: path.join(root, 'uploads'), PORT: String(port), ...overrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  processHandle.stdout.on('data', b => { output += b; });
  processHandle.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => processHandle.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
    await exited;
    // This root was created by mkdtemp above and contains fixture data only.
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, port, processHandle, exited, output: () => output };
}
function request(port, url, payload) {
  return new Promise((resolve, reject) => {
    const body = payload && JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let data = ''; res.on('data', b => { data += b; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function ready(child) {
  for (let attempts = 0; attempts < 200; attempts++) {
    if (child.output().includes('服务器运行在')) return;
    if (child.processHandle.exitCode !== null) throw new Error(child.output());
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Fixture server did not start');
}

test('real SIGTERM exits successfully and retains last acknowledged message', { timeout: 10000 }, async t => {
  const child = await launch(t); await ready(child);
  const reply = await request(child.port, '/api/messages', { type: 'text', content: 'persist-before-shutdown' });
  assert.equal(reply.status, 200);
  child.processHandle.kill('SIGTERM');
  assert.deepEqual(await child.exited, { code: 0, signal: null });
  const saved = JSON.parse(await fs.readFile(path.join(child.root, 'messages.json'), 'utf8'));
  assert.equal(saved.messages.at(-1).content, 'persist-before-shutdown');
  assert.doesNotMatch(child.output(), /服务关闭失败|服务启动失败/);
});

test('listen failure exits unsuccessfully without leaving cleanup timers running', { timeout: 10000 }, async t => {
  const occupied = net.createServer(); await new Promise(r => occupied.listen(0, r));
  t.after(() => new Promise(r => occupied.close(r)));
  const child = await launch(t, { PORT: String(occupied.address().port) });
  const exit = await child.exited;
  assert.equal(exit.code, 1); assert.equal(exit.signal, null);
  assert.match(child.output(), /EADDRINUSE/);
});
