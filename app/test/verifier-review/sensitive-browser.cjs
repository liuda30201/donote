'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { generateTotp } = require('../../src/security/primitives');
const repo = path.resolve(__dirname, '../../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await delay(100); } throw new Error(`Timeout: ${label}`); }
async function stop(child, label) { if (!child || child.exitCode !== null) return; console.log(`cleanup: stopping ${label} pid=${child.pid}`); child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await Promise.race([new Promise(r => child.once('exit', r)), delay(2000)]); } }
function connectTarget(target, onEvent = () => {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); let id = 0; const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id) { const item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result); } else onEvent(value); });
  const call = async (method, params = {}) => { await ready; return new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout after 30s: ${method}`)); }, 30000); pending.set(n, { resolve, reject, timer }); try { ws.send(JSON.stringify({ id: n, method, params })); } catch (error) { clearTimeout(timer); pending.delete(n); reject(error); } }); };
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; };
  return { ws, call, evaluate };
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donote-sensitive-browser-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const authKey = path.join(root, 'auth.key'); fs.writeFileSync(authKey, crypto.randomBytes(32), { mode: 0o600 });
  const contentKey = crypto.randomBytes(32); const keyring = path.join(root, 'content-keyring.json');
  fs.writeFileSync(keyring, JSON.stringify({ version: 1, activeKeyId: 'browser-test', keys: { 'browser-test': contentKey.toString('base64') } }), { mode: 0o600 }); contentKey.fill(0);
  const password = 'Synthetic-browser-Only-123!'; const username = 'sensitivebrowser'; let app; let chrome; let first; let second; const results = {}; const errors = [];
  const phase = label => console.log(`phase: ${label}`);
  try {
    phase('init account');
    const init = spawnSync(process.execPath, [path.join(repo, 'app/scripts/accounts.js'), 'init-admin', '--data-dir', data, '--offline-confirmed'], { input: JSON.stringify({ username, displayName: 'Sensitive Browser', password }), encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`init-admin failed: ${init.stderr}`);
    phase('start service');
    const appPort = await port(); const cdpPort = await port(); const base = `http://127.0.0.1:${appPort}`;
    app = spawn(process.execPath, ['server.js'], { cwd: path.join(repo, 'app'), env: { ...process.env, AUTH_MODE: 'accounts', AUTH_ORIGIN: base, AUTH_DEV_HTTP: '1', AUTH_KEY_FILE: authKey, SENSITIVE_KEYRING_FILE: keyring, SENSITIVE_KEYRING_HOST_FILE: keyring, STORAGE_ROOT: data, PORT: String(appPort) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; app.stderr.on('data', chunk => { stderr += chunk; }); await until(async () => (await fetch(`${base}/api/version`)).ok, 'server startup');
    phase('start Chrome');
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--user-data-dir=' + path.join(root, 'chrome-profile'), 'about:blank'], { stdio: 'ignore' });
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(x => x.type === 'page'), 'Chrome CDP');
    phase('connect CDP');
    first = connectTarget(target, event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text); if (event.method === 'Network.responseReceived' && event.params.response.url.includes('/sensitive/')) console.log('sensitive-http:', event.params.response.status, new URL(event.params.response.url).pathname); }); await first.call('Runtime.enable'); await first.call('Page.enable'); await first.call('Network.enable');
    phase('navigate and login');
    await first.call('Page.navigate', { url: base }); const e = first.evaluate; const click = id => e(`document.getElementById(${JSON.stringify(id)}).click()`); const fill = (id, value) => e(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`); const visible = id => e(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
    await until(() => visible('username-input'), 'login form'); await fill('username-input', username); await fill('password-input', password); await click('auth-btn');
    const secretText = await until(() => e(`document.getElementById('account-setup-secret').textContent`), 'setup secret'); const secret = secretText.split('：').at(-1).trim();
    await fill('account-code', generateTotp(secret, { now: Date.now() - 30000 })); await fill('account-new-password', password); await click('auth-btn'); await until(() => e(`document.getElementById('account-recovery-result').textContent.includes('重新登录')`), 'setup done');
    await fill('username-input', username); await fill('password-input', password); await click('auth-btn'); await until(() => e(`accountStage==='mfa'`), 'mfa stage'); await fill('account-code', generateTotp(secret)); await click('auth-btn'); await until(() => e(`isAuthenticated && !document.getElementById('chat-section').classList.contains('hidden')`), 'workspace'); results.login = true;
    phase('create sensitive text');
    await click('toggle-composer-btn'); await until(() => e(`!document.getElementById('composer-area').classList.contains('hidden')`), 'composer'); await click('sensitive-text-input'); await fill('text-input', 'browser sensitive secret'); await click('send-text');
    phase('verify locked payload');
    const sensitive = await until(() => e(`messages.find(m=>m.sensitive===true)`), 'sensitive creation'); results.checkbox_create = true; results.locked_no_plaintext = await e(`(()=>{const m=messages.find(m=>m.id===${JSON.stringify(sensitive.id)});return !!m && m.sensitive===true && m.content===null && m.remark==='' && !JSON.stringify(m).includes('browser sensitive secret')})()`);
    phase('reveal and teardown');
    const revealCode = generateTotp(secret, { now: Date.now() + 30000 });
    const revealStart = await e(`window.prompt=(label)=>label.includes('动态')?${JSON.stringify(revealCode)}:${JSON.stringify(password)};document.getElementById('toast-text').textContent='';openTextViewer(messages.find(m=>m.id===${JSON.stringify(sensitive.id)})).then(()=>({mode:currentMode,auth:isAuthenticated,id:${JSON.stringify(sensitive.id)}}))`); console.log('reveal-start:', JSON.stringify(revealStart));
    await until(() => e(`currentViewerTextMsg?.content==='browser sensitive secret' || document.getElementById('toast-text').textContent`), 'reveal viewer');
    const revealState = await e(`({content:currentViewerTextMsg?.content||null,toast:document.getElementById('toast-text').textContent,visible:!document.getElementById('text-viewer').classList.contains('hidden')})`); console.log('reveal-state:', JSON.stringify(revealState)); if (revealState.content !== 'browser sensitive secret') throw new Error(`Reveal failed: ${JSON.stringify(revealState)}`); results.reveal = true;
    results.dom_teardown = await e(`closeTextViewer();!document.getElementById('text-viewer-content').textContent&&!document.getElementById('text-viewer-title').textContent&&!document.getElementById('text-viewer-meta').textContent&&!document.getElementById('text-viewer-open-link').getAttribute('href')`);
    phase('synthetic hidden event with controlled late reveal response');
    await e(`window.__originalFetch=window.fetch;window.__lateHeld=false;window.fetch=async function(url,options){if(String(url).endsWith('/sensitive/reauth'))return new Response(JSON.stringify({token:'controlled-browser-test'}),{status:200});if(String(url).endsWith('/sensitive/reveal')){window.__lateHeld=true;return await new Promise(resolve=>window.__releaseLate=()=>resolve(new Response(JSON.stringify({content:'late synthetic secret',remark:'late remark',expiresAt:Date.now()+120000}),{status:200})));}return window.__originalFetch(url,options)};window.__lateTask=openTextViewer(messages.find(m=>m.id===${JSON.stringify(sensitive.id)}));true`);
    await until(() => e(`window.__lateHeld===true`), 'controlled reveal response held');
    results.synthetic_hidden_late_response = await e(`(async()=>{const generation=sensitiveViewerGeneration;Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));closeTextViewer();window.__releaseLate();await window.__lateTask;const clean=sensitiveViewerGeneration>generation&&!sensitiveViewerState.size&&currentViewerTextMsg===null&&!textViewerContent.textContent&&!textViewerTitle.textContent&&!textViewerOpenLink.getAttribute('href');window.fetch=window.__originalFetch;delete document.visibilityState;return clean})()`); if (!results.synthetic_hidden_late_response) throw new Error('Hidden late reveal response cleanup failed');
    phase('two real tabs: socket locks previously ordinary viewer');
    const target2 = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json();
    second = connectTarget(target2); await second.call('Runtime.enable');
    await until(() => second.evaluate(`isAuthenticated&&socket.connected`), 'second tab authenticated socket');
    const ordinaryId = await second.evaluate(`authFetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'text',content:'cross tab ordinary secret'})}).then(async r=>{if(!r.ok)throw Error('create failed '+r.status);return (await r.json()).message.id})`);
    await until(() => e(`messages.some(m=>m.id===${JSON.stringify(ordinaryId)})`), 'first tab ordinary socket message');
    await e(`openTextViewer(messages.find(m=>m.id===${JSON.stringify(ordinaryId)}))`);
    if (!await e(`currentViewerTextMsg?.content==='cross tab ordinary secret'`)) throw new Error('Cross-tab viewer precondition failed');
    await e(`window.__sensitiveSocketSeen=false;socket.once('message-sensitive',msg=>{if(msg.id===${JSON.stringify(ordinaryId)})window.__sensitiveSocketSeen=true});true`);
    const markStatus = await second.evaluate(`authFetch('/api/messages/${encodeURIComponent(ordinaryId)}/sensitive/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sensitive:true})}).then(r=>r.status)`);
    if (markStatus !== 200) throw new Error('Cross-tab mark HTTP '+markStatus);
    await until(() => e(`window.__sensitiveSocketSeen===true`), 'real message-sensitive socket receipt');
    results.cross_tab_socket_cleanup = await e(`(()=>{const m=messages.find(m=>m.id===${JSON.stringify(ordinaryId)});return m.sensitive===true&&m.content===null&&m.remark===''&&currentViewerTextMsg===null&&!sensitiveViewerState.size&&!textViewerContent.textContent&&!document.getElementById('messages-list').textContent.includes('cross tab ordinary secret')})()`);
    phase('synthetic persisted pageshow triggers real session revalidation');
    results.synthetic_persisted_pageshow = await e(`(async()=>{window.__meRequests=0;const original=window.fetch;window.fetch=function(url,options){if(String(url)==='/api/auth/me')window.__meRequests++;return original(url,options)};window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));await accountRevalidation;window.fetch=original;return window.__meRequests===1&&isAuthenticated&&accountRevalidation===null})()`);
    phase('logout cleanup');
    await e(`logout(false)`); await until(() => visible('auth-section'), 'logout'); results.logout_cleanup = await e(`messages.length===0&&!sensitiveViewerState.size&&!document.getElementById('text-viewer-content').textContent`);
    results.browser_exceptions = errors.length; console.log(JSON.stringify({ kind: 'host-synthetic-sensitive-real-Chrome', results, server_stderr: stderr.slice(-1000) }, null, 2)); if (errors.length || Object.entries(results).some(([name, value]) => name !== 'browser_exceptions' && value !== true)) throw new Error('Browser acceptance assertions failed');
  } finally { first?.ws.close(); second?.ws.close(); await stop(chrome, 'Chrome'); await stop(app, 'service'); if (!root.startsWith(path.join(os.tmpdir(), 'donote-sensitive-browser-'))) throw new Error('unsafe test temp cleanup'); fs.rmSync(root, { recursive: true, force: true }); console.log('cleanup: removed temporary fixture'); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
