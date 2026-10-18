'use strict';
// Host-only browser acceptance, never a substitute for final-image acceptance.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../..');
const {generateTotp}=require('../../src/security/primitives');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(100);}throw Error('Timeout: '+label);}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'donote-browser-'));const data=path.join(root,'data');fs.mkdirSync(data);const key=path.join(root,'key');fs.writeFileSync(key,require('crypto').randomBytes(32),{mode:0o600});const password='Synthetic-browser-Only-123!',newPassword='Synthetic-browser-New-123!';let app,chrome,ws,ws2;const results={};const errors=[];
 try{
 const init=spawnSync(process.execPath,[path.join(repo,'app/scripts/accounts.js'),'init-admin','--data-dir',data,'--offline-confirmed'],{input:JSON.stringify({username:'reviewadmin',displayName:'Review Admin',password}),encoding:'utf8'});if(init.status!==0)throw Error('Synthetic init failed: '+init.stderr);
 const appPort=await port(),cdpPort=await port(),base='http://127.0.0.1:'+appPort;
 app=spawn(process.execPath,['server.js'],{cwd:path.join(repo,'app'),env:{PATH:process.env.PATH,AUTH_MODE:'accounts',AUTH_ORIGIN:base,AUTH_DEV_HTTP:'1',DONOTE_TEST_MODE:process.env.ENROLLMENT_OPTIONAL_TEST==='1'?'1':'0',AUTH_TOTP_OPTIONAL:process.env.ENROLLMENT_OPTIONAL_TEST==='1'?'1':'0',AUTH_KEY_FILE:key,STORAGE_ROOT:data,PORT:String(appPort)},stdio:['ignore','ignore','pipe']});let appErrors='';app.stderr.on('data',x=>appErrors+=x);
 await until(async()=> (await fetch(base+'/api/version')).ok,'host app');
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+cdpPort,'--user-data-dir='+path.join(root,'chrome-profile'),'about:blank'],{stdio:'ignore'});
 const targets=await until(async()=>{const a=await(await fetch('http://127.0.0.1:'+cdpPort+'/json')).json();return a.find(x=>x.type==='page');},'Chrome CDP');
 ws=new WebSocket(targets.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.id){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}else if(v.method==='Network.requestWillBeSent'&&v.params.request.url.includes('/socket.io/'))console.error('Socket request:',v.params.request.method,JSON.stringify({hasOrigin:Object.keys(v.params.request.headers).some(k=>k.toLowerCase()==='origin'),hasReferer:Object.keys(v.params.request.headers).some(k=>k.toLowerCase()==='referer')}));else if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.text);else if(v.method==='Runtime.consoleAPICalled'&&v.params.type==='error')console.error('Browser console:',v.params.args.map(x=>x.value??x.description).join(' '));};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
 const fill=(id,value)=>evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`);
 const visible=id=>evaluate(`!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
 await call('Runtime.enable');await call('Network.enable');await call('Page.navigate',{url:base});await until(()=>visible('username-input'),'accounts login UI');results.login_form=true;
 await fill('username-input','reviewadmin');await fill('password-input',password);await click('auth-btn');
 await until(()=>evaluate(`accountStage==='setup'`),'password setup');
 if(await visible('account-code') || await visible('account-code-label'))throw Error('Password-only initialization incorrectly requests authenticator code');
 results.password_setup_without_otp=true;
 await fill('account-new-password',newPassword);await click('auth-btn');await until(()=>evaluate(`document.getElementById('account-recovery-result').textContent.includes('重新登录')`),'password completion');
 await fill('username-input','reviewadmin');await fill('password-input',newPassword);await click('auth-btn');
 await until(()=>evaluate(`document.getElementById('enrollment-qr').naturalWidth>0`),'in-app QR');
 results.qr_after_entry=await visible('chat-section');results.required_no_skip=!(await visible('enrollment-skip'));
 results.private_api_blocked=await evaluate(`fetch('/api/messages').then(r=>r.status===401)`);
 if(process.env.ENROLLMENT_OPTIONAL_TEST==='1') {
   await click('enrollment-skip');await until(()=>evaluate(`socket.connected && !chatSection.inert`),'optional skip workspace');
   results.optional_skip=await evaluate(`fetch('/api/messages').then(r=>r.ok)`);
   if(!results.optional_skip || errors.length)throw Error('Optional enrollment failed');
   console.log(JSON.stringify({kind:'host-synthetic-real-Chrome-optional',results},null,2));return;
 }
 const secret=await evaluate(`document.getElementById('enrollment-secret').textContent`);
 await fill('enrollment-code',generateTotp(secret));await click('enrollment-submit');await until(()=>visible('enrollment-recovery'),'recovery codes');
 await click('enrollment-done');await until(()=>evaluate(`socket.connected`),'bound session socket');
 await click('logout-btn');await until(()=>visible('auth-section'),'logout before MFA check');results.setup=true;
 // Avoid replay of the enrollment counter without waiting for a real 30-second tick.
 // Login at the next accepted window counter; grant operations use a later fresh counter.
 await fill('username-input','reviewadmin');await fill('password-input',newPassword);await click('auth-btn');await until(()=>evaluate(`accountStage==='mfa'`),'TOTP login stage');await fill('account-code',generateTotp(secret,{now:Date.now()+30000}));await click('auth-btn');try{await until(()=>visible('chat-section'),'authenticated workspace');}catch(e){console.error('Login diagnostic',await evaluate(`JSON.stringify({stage:accountStage,error:document.getElementById('auth-error').textContent,mode:currentMode})`));throw e;}results.totp_login=true;
 await click('admin-open');await until(()=>evaluate(`document.getElementById('admin-users').children.length>0`),'admin list');results.admin_list_no_origin=true;await click('admin-close');
 await click('security-open');await until(()=>evaluate(`document.getElementById('security-sessions').textContent.length>0`),'sessions');results.sessions=true;await click('security-history-btn');await until(()=>evaluate(`document.getElementById('security-history').textContent.length>0`),'history');results.history=true;
 await click('security-close');
 // Second real page shares only this fixture's temporary profile/cookie jar.
 const target2=await(await fetch('http://127.0.0.1:'+cdpPort+'/json/new?'+encodeURIComponent(base),{method:'PUT'})).json();
 ws2=new WebSocket(target2.webSocketDebuggerUrl);await new Promise((r,j)=>{ws2.onopen=r;ws2.onerror=j;});let id2=0;const pending2=new Map();
 ws2.onmessage=e=>{const v=JSON.parse(e.data);if(v.id){const p=pending2.get(v.id);pending2.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}else if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.text);};
 const call2=(method,params={})=>new Promise((resolve,reject)=>{const n=++id2;pending2.set(n,{resolve,reject});ws2.send(JSON.stringify({id:n,method,params}));});
 const evaluate2=async expression=>{const r=await call2('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 await call2('Runtime.enable');await until(()=>evaluate2(`isAuthenticated && socket.connected && !document.getElementById('chat-section').classList.contains('hidden')`),'second tab session restore');results.second_tab_session_restore=true;
 const marker='synthetic-private-dual-tab-'+Date.now();
 await evaluate(`authFetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'text',content:${JSON.stringify(marker)}})}).then(r=>{if(!r.ok)throw Error('synthetic message failed')})`);
 await until(()=>evaluate2(`messages.some(m=>m.content===${JSON.stringify(marker)}) && document.getElementById('messages-list').textContent.includes(${JSON.stringify(marker)})`),'second tab private message');results.second_tab_private_message=true;
 await call2('Page.reload');await until(()=>evaluate2(`isAuthenticated && socket.connected && messages.some(m=>m.content===${JSON.stringify(marker)})`),'second tab reload cookie restore');results.second_tab_reload_cookie_restore=true;
 const resumeCount=await evaluate2(`window.__resumeMeCount=0;window.__originalFetch=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/api/auth/me'))window.__resumeMeCount++;return window.__originalFetch(...args)};window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.__resumeMeCount`);
 await until(()=>evaluate2(`window.__resumeMeCount>0 && accountRevalidation===null && isAuthenticated && socket.connected && messages.some(m=>m.content===${JSON.stringify(marker)})`),'persisted pageshow revalidation');results.persisted_pageshow_revalidation=true;
 await evaluate2(`window.__logoutBroadcastSeen=false;window.__logoutObserver=new BroadcastChannel('donote-session');window.__logoutObserver.onmessage=e=>{if(e.data?.type==='logout')window.__logoutBroadcastSeen=true;};document.getElementById('security-password').value='synthetic-clear-me';document.getElementById('admin-actor-password').value='synthetic-clear-me';`);
 await click('logout-btn');await until(()=>visible('auth-section'),'logout');results.logout=await evaluate(`accountUser===null && accountCsrfToken===null && document.getElementById('admin-actor-password').value==='' && document.getElementById('security-password').value===''`);
 await until(()=>evaluate2(`window.__logoutBroadcastSeen && !isAuthenticated && accountUser===null && accountCsrfToken===null && messages.length===0 && favorites.length===0 && !socket.connected && !document.getElementById('auth-section').classList.contains('hidden') && document.getElementById('chat-section').classList.contains('hidden') && !document.getElementById('messages-list').textContent.includes(${JSON.stringify(marker)}) && document.getElementById('security-password').value==='' && document.getElementById('admin-actor-password').value===''`),'second tab broadcast logout and private clear');results.dual_tab_broadcast_logout_clear_socket=true;
 await evaluate2(`window.__logoutObserver.close()`);await call2('Page.reload');await until(()=>evaluate2(`currentMode==='accounts' && !isAuthenticated && accountUser===null && messages.length===0 && !socket.connected && !document.getElementById('auth-section').classList.contains('hidden') && !document.getElementById('messages-list').textContent.includes(${JSON.stringify(marker)})`),'second tab reload after logout');results.second_tab_reload_logged_out=true;
 results.browser_exceptions=errors.length;console.log(JSON.stringify({kind:'host-synthetic-real-Chrome',results},null,2));if(errors.length)throw Error('Browser runtime exceptions observed');
 }finally{ws2?.close();ws?.close();await stop(chrome);await stop(app);if(!root.startsWith(path.join(os.tmpdir(),'donote-browser-')))throw Error('unsafe temp cleanup');fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
