# Accounts 前端与运行时只读审查

审查对象为正在并行修改的工作树快照。只读检查，不修改前端、后端或他人测试；以下发现已通知 client-realtime。尚未收到其修复完成通知，因此本报告列的是已观察到的阻塞，不能视为修复后最终验收。

## 当前结论

尚不能确认“没有请求路径发送旧密码”或“不会跨账户显示缓存”。已用实际前端函数独立复现旧消息响应写入新账户内存。账户模式稳定进入后的 authFetch、XHR 和 Socket auth 有明确 session 分支，持久消息/收藏缓存也被禁用，但模式探测前/失败回退和多个异步完成路径仍未封闭。

## 已复现阻塞：A 的旧响应覆盖 B 的消息

当前 `loadInitialMessages()` 在 `await fetchMessagesPage()` 后无 account epoch 或 user/session 校验，直接赋值 messages 并渲染。可用如下无浏览器实验读取当前函数执行，不改任何源文件：

```bash
node <<'JS'
const fs=require('fs'),vm=require('vm'); const src=fs.readFileSync('app/public/app.js','utf8');
let release; const c={currentMode:'accounts',localStorage:{getItem:()=>null},messages:[],PAGE_SIZE:30,fetchMessagesPage:()=>new Promise(r=>release=r),renderMessages:()=>{},updateExpireInfo:()=>{},showToast:()=>{},console};
vm.createContext(c);vm.runInContext(src.slice(src.indexOf('async function loadInitialMessages()'),src.indexOf('async function refreshMessagesAfterReconnect()')),c);
const work=c.loadInitialMessages(); c.messages=[];c.accountEpoch=2;c.isAuthenticated=true;c.userId='B';
release({messages:[{id:'A-secret'}]});
work.then(()=>console.log(JSON.stringify({activeUser:c.userId,messages:c.messages})));
JS
```

观察结果：`{"activeUser":"B","messages":[{"id":"A-secret"}]}`。

浏览器复现步骤：A 登录，延迟 `/api/messages` 响应，退出后 B 登录，再释放 A 响应；观察列表出现 A 记录。类似无代次检查还存在于 loadFavorites、refreshMessagesAfterReconnect、loadOlderMessages、loadMoreSearchResults 和 openFileViewer 的 response.text 后；收藏数组、搜索缓存、文件文本可被重新填回。performSearch 第一页已有 seq 校验，不能据此覆盖其他路径。

所需修复：所有私有请求开始时捕获 session/user generation，响应读取完成后、每次 DOM/数组/缓存写入前检查；退出/登录切换递增 generation 并 abort 活动 fetch。旧 401 也只能清理其所属 session，不能退出已登录的新账户。

## 阻塞：旧密码发送路径仍可到达

当前初始 `currentMode='single'`，模式尚未确定时 auth 按钮已可执行 verifyPassword。`checkAuth()` 的 `/api/auth/status` 失败 catch 还会取 localStorage 旧密码并调用 verifyPassword，发送 POST `/api/auth` 的 password body。

浏览器复现：预置 legacy `web-clipboard-password`，在 accounts 部署中阻断 `/api/auth/status`，刷新并查看网络；或者延迟 status 后点击登录。服务器返回 410 并不能消除客户端发送旧密码的事实。

所需修复：默认 mode 为 unknown/pending；完成可信状态探测前禁用登录和私有操作，探测失败仅显示重试，不降级 legacy，也不读取/发送旧密码。只有明确 legacy status 才允许旧流程。

已验证边界：进入 accounts 后 authFetch 不读取旧密码，XHR header setter 仅附加 CSRF，Socket auth 回调返回空对象；下载 URL 不附 password。configureAccountLogin 会删除旧密码/用户/消息/收藏 localStorage 并清除 wc_auth。但这些正确分支不能替代初始化 gate。

## 阻塞：上传队列、图片处理与退出状态

当前 logout 未调用 cancelUpload；processUploadQueue 在响应完成后无 generation 检查并继续发送剩余项。可复现：A 排队两个文件，延迟首个响应，退出并 B 登录，释放首个响应；A 的返回消息可插入 B 列表，第二个文件会使用当时 B 的 Cookie/CSRF 上传到 B。异步 HEIC 转换、压缩、剪贴板 read/getAsString 完成后也能把 A 的输入加入 B 队列。

所需修复：队列项绑定创建账户 generation；退出 abort 当前 XHR、清空队列并废弃旧进度/finally 回调；每次异步图片/剪贴板处理完成前检查 generation，发请求前验证当前登录账户。

logout 还应清理 textInput、remark/modal 私有预览、image viewer src/currentViewerMessage、setup secret/recovery code 展示及输入。当前只显式关闭 text/file viewer，image viewer 可作为 body 级弹层在退出后继续显示。关闭图片 viewer 还需防止旧原图加载结果重新赋回 src。恢复/setup 内层 await 和登录后 `/auth/me` 也应检查 epoch，避免 reset 后旧 secret/challenge 回写或自动进入工作台。

## Socket 与 Service Worker

Socket 当前单实例，私有事件仅检查 isAuthenticated；跨会话旧事件需要由断连后 generation 绑定或重新创建连接保证不会应用到新账户。服务端 session 校验不能替代客户端对已排队回调的隔离。

SW 当前跳过 `/api/`、`/uploads/`、`/socket.io/` 网络缓存；CLEAR_PRIVATE_CACHE 会遍历缓存清理对应旧请求。需要保留该行为并验证更新后的 SW 已接管页面。退出清理消息为异步 postMessage，无完成确认；客户端应依靠请求路径从不缓存私有数据作为主保证，而不是等待用户退出才删除。当前没有浏览器级真实 SW 验收证据。

## client-realtime task11 修复复验

收到 task11 修复通知后重新执行了延迟响应实验：A 的 `loadInitialMessages()` 请求挂起，切换账户使 `accountEpoch` 增加，再释放响应；结果为 `messages: []`，A-secret 未回填。当前实现同时在 `sessionFetch` 的 body 消费前后检查 epoch，覆盖 `json`、`blob`、`text` 等消费者；初始消息、收藏、分页、重连和上传队列也有代次检查。`currentMode` 初值已改为 `pending`，status 失败保持 pending 并禁用登录，不再 legacy 回退发送 localStorage 旧密码。logout 会先等待服务端注销成功（401 视为已注销），再递增 epoch、abort 请求、清空队列并广播跨 tab logout。

最终复核已确认图片 viewer 边界也已修复：logout 调用 `closeImageViewer()`，清除 `src`、标题、当前消息并 revoke blob URL；`viewOriginalImage()` 捕获请求 epoch 和 viewer message，在 await 后、catch、finally 均阻止旧实例回写。未再发现该退出清理阻塞。

## 运行时补充检查

已读最新 server/config/runtime/createApp/routes/files/messages：

- `AUTH_MODE=accounts` 使 MULTI_USER_MODE 为 true，JSON/附件按 user ID 隔离。
- server 创建 security runtime 后 SELECT 非删除用户并逐个 loadPersistedState(id)，再注册清理任务并启动 app；不是仅加载 legacy userPasswordMap。
- createApp 在 accounts 缺 authService 时拒绝启动，注入 authService/securityRouter；routes 选择 createAuthRouter 并挂 securityRouter。
- files 的 requireAuthOrCookie 检测 authService 后走 requireAuth，messages auth-verify 同样走 session 验证；旧密码旁路不能直接落入 legacy 分支。
- runtime 使用外部 AUTH_KEY_FILE，拒绝非 regular file、多个硬链接、group/other 权限、错误长度；生产要求 HTTPS origins，开发 HTTP 只允许显式 loopback。`node --test app/test/security/runtime.test.js` 通过 1/1。
- runtime 当前 lstat/read 是两步，可信 key 父目录和部署不可被非授权写入是前提；本轮未模拟恶意主机写入者。
- server 的 `.mode` 仍按 MULTI_USER_MODE 写 multi，不能据此宣称具备 accounts 备份/迁移模式契约。SQLite 成功备份、真实迁移和恢复未在本轮实现或完成；fail-closed 只是保护性阻塞，不是成功备份验收。

## task15 P1 复查

task15 首轮已通过静态与 VM 复查：设备 session 列表、reauth 操作和撤销接口均通过 `authFetch`，响应 body 消费后检查 `accountEpoch`；logout/跨 tab epoch 机制仍覆盖这些请求。重新认证 grant 在确认撤销前暂存，用户取消确认时清除 grant；撤销目标由服务端返回的冻结摘要/目标绑定决定。`node --check app/public/app.js app/public/service-worker.js` 与 `git diff --check` 均通过。

仍有产品功能风险而非已验证竞态：`index.html` 中 history/password/TOTP 相关按钮存在，但当前 app.js 只接线了设备刷新、撤销其他/全部和 reauth；`security-password-btn`、`security-factor-btn`、`security-factor-disable` 没有点击处理，`security-history` 也没有加载历史事件的请求或渲染。因此这些控件目前不能宣称已实现，用户无法从 UI 修改密码、绑定/停用 TOTP 或查看安全历史。应接入对应 API，并复用 reauth、epoch、错误和清理规则；在接线前建议隐藏/禁用这些按钮避免误导。

## 验证限制

已检查 playwright、@playwright/test、puppeteer、jsdom，均未安装。没有安装依赖、启动替代服务或接触生产。当前证据包括静态路径审查、真实函数的 Node vm 延迟响应复现、runtime 单元测试；完整浏览器 Cookie/SW/下载/多 tab 账户切换验收仍待具备环境后执行。
