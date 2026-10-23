# DoNote 工作台前端与全量弹窗交互深度分析及优化方案
**【团队「前端开发组」全链路接力交付报告】**

> **审查与分析范围**：`app/public/app.html`（1290 行）、`app/public/style.css`（5988 行）、`app/public/app.js`（6590+ 行）、`app/public/share.html`、`app/public/share.js`、`app/public/avatar-editor-new.html` 及后端路由契约（`app/src/routes/messages.js`、`app/src/private-unlock.js`）。
> **接力团队**：1. UI/UX 设计师 → 2. 前端工程师 → 3. 测试工程师 → 4. 代码审查员（已加载 `user-code-review` 技能）。

---

## 目录
1. [第一棒：UI/UX 设计师 —— 工作台与 14 个弹窗/浮层交互体验诊断](#第一棒uiux-设计师--工作台与-14-个弹窗浮层交互体验诊断)
2. [第二棒：前端工程师 —— 架构、状态流、DOM/事件修复与响应式重构方案](#第二棒前端工程师--架构状态流dom事件修复与响应式重构方案)
3. [第三棒：测试工程师 —— 单元测试、集成测试与 E2E 自动化测试方案](#第三棒测试工程师--单元测试集成测试与-e2e-自动化测试方案)
4. [第四棒：代码审查员（Code Review）—— 缺陷分级清单与安全/性能/质量修复指南](#第四棒代码审查员code-review--缺陷分级清单与安全性能质量修复指南)
5. [实施路线图与优先级矩阵（P0 / P1 / P2）](#实施路线图与优先级矩阵p0--p1--p2)

---

## 第一棒：UI/UX 设计师 —— 工作台与 14 个弹窗/浮层交互体验诊断

### 1.1 工作台整体架构与视觉层级梳理
当前 DoNote 工作台采用 **Apple Notes / Finder + Paste Pinboard** 的设计语言，整体分为四大核心区域：
1. **顶栏（`.app-topbar`）**：左区品牌 + 视图切换 Tabs（`全部` / `收藏` / 预留 `共享`）；中区组合式搜索框（`全部/备注` 范围切换 + 搜索输入 + `/` 快捷键提示）；右区卡片缩放滑块（`.topbar-zoom-control`）、全局隐私解锁按钮（`#private-unlock-global-btn`）、实时连接状态胶囊（`.connection-pill`）、主题切换（`#theme-toggle`）及用户头像/设置浮层入口（`#display-settings-btn`）。
2. **主画布（`#workspace-scroll` / `#favorites-list`）**：带左侧贯穿式时间轴（`.messages-list::before`）、日期折叠分组（`.timeline-date-divider`）与 CSS Grid 自适应等高卡片流（`--card-col-width` 与 `--card-scale` 无感缩放），支持五类语义色带卡片（`text` 暖金黄、`code` 苹果蓝、`link` 翠绿、`image` 洋红、`file` 暖橙）。
3. **底部悬浮 Dock（`.floating-dock-wrapper`）**：包含按需展开的轻量输入抽屉（`#composer-area`）与分类筛选胶囊栏（`.floating-filter-dock`，含 6 种内容类型 + 动态分组标签 `#category-chips` + 窄屏「新建」入口）。
4. **全局反馈与辅助浮层**：网络断连横幅（`#network-banner`）、上传进度条（`#upload-progress-container`）、回到最新浮动按钮（`#scroll-bottom-btn`）、移动端一键保存 FAB（`#mobile-fab`）、全屏拖拽上传提示层（`#drop-overlay`）与底部 Toast（`#toast`）。

### 1.2 现有工作台交互痛点（看不懂、找不到、点不动、状态不明）

| 区域 / 控件 | 现状问题与源码定位 | 用户体验影响 | 具体修改建议（精确到选择器/区域） |
|---|---|---|---|
| **顶栏「隐私解锁」按钮**<br>`#private-unlock-global-btn` | `app.html:214` 放置在顶栏右侧，但在 `app.js:5430` 仅获取了 DOM 引用，**未绑定任何点击事件**，且未按 `currentMode === 'accounts'` 或是否存在 `private` 卡片控制显隐。 | **点不动 / 状态不明**：用户看到顶栏常驻「隐私解锁」按钮，点击毫无反应；单用户/无隐私卡片时也暴露该按钮，造成认知困惑。 | 1. 绑定 `#private-unlock-global-btn` 点击事件调用 `openPrivateUnlockModal(null)`；<br>2. 仅当存在 `msg.private === true` 的卡片时显示该按钮，并在全局解锁生效期间切换文案为 `已解锁 · 剩余 Xm` 或高亮状态。 |
| **触屏端与窄屏卡片操作能力断层**<br>`.message-actions` & `.paste-card-meta` | `style.css:4846` 在 `@media (max-width: 640px)` 中定义 `.paste-card-meta { display: none; }` 隐藏了底部分组与备注入口；同时 `style.css:4937` 在 `@media (hover: none) and (pointer: coarse)` 中定义 `.message.paste-card .message-actions { display: none !important; }`。 | **找不到 / 点不动**：在手机/iPad 等触屏设备上，用户只能「单击复制、双击预览」，**完全无法在移动端收藏、删除、添加备注、设置分组或加/解隐私锁**！所有卡片管理功能在移动端 100% 丧失。 | 1. 移动端卡片右上角或右下角保留一个紧凑的 `⋯` 更多操作触发器（或在双击打开的 Quick Look 预览弹窗顶栏补齐「收藏 / 备注 / 分组 / 删除」操作入口）；<br>2. 避免粗暴 `display: none !important` 切断全部管理路径。 |
| **底部 Dock「文件」筛选胶囊被永久隐藏**<br>`.filter-chip[data-filter="file"]` | `app.html:433` 中文件筛选按钮写死了 `class="filter-chip hidden" aria-hidden="true" tabindex="-1"`，同时 `app.js:5633` 拖拽非图片文件时弹出 Toast 称“不支持普通文件附件”，但后端与粘贴上传实际支持 `file` 类型卡片。 | **看不懂 / 认知冲突**：系统既有文件卡片渲染（`.variant-file`）与文件预览器（`#file-viewer`），首页落地页也宣传支持「文件」，但工作台拖拽拦截了普通文件且隐藏了「文件」筛选胶囊。 | 统一产品心智：若支持文件同步，应在 `handleDrop` 中改用 `handleFileUpload(files)`（`app.js:4743` 已实现该函数但未被 `handleDrop` 调用！），并移除 `.filter-chip[data-filter="file"]` 的 `hidden` 类。 |
| **备注自动补全下拉缺失 DOM 容器**<br>`#remark-autocomplete` | `app.js:6411` 完整实现了备注自动补全逻辑（`const remarkAutocompleteEl = document.getElementById('remark-autocomplete')`），且 `style.css:1659` 编写了 `.remark-autocomplete` 样式，但 **`app.html:1206` 的 `.remark-input-wrapper` 中根本没有 `<div id="remark-autocomplete">` 节点**，且 `remarkInput` 未绑定 `updateRemarkAutocomplete`！ | **找不到**：精心编写的备注历史分类自动补全功能在界面上完全不触发。 | 在 `app.html` 的 `.remark-input-wrapper` 内补齐 `<div id="remark-autocomplete" class="remark-autocomplete hidden" role="listbox"></div>`，并在 `remarkInput` 的 `input`/`focus`/`keydown` 中接入自动补全函数。 |
| **敏感文本验证交互割裂**<br>`sensitiveCredentials()` | `app.js:5901` 解锁或取消敏感文本（`msg.sensitive`）时，直接调用浏览器原生阻塞式 `window.prompt('请输入密码...')` 和 `window.prompt('请输入动态验证码')`。 | **体验割裂**：与全站精致的 Apple HIG 毛玻璃弹窗风格格格不入，且 `window.prompt` 输入密码时**明文回显**，存在严重肩窥泄密风险！ | 废弃 `window.prompt`，复用或扩展 `#security-reauth` / 轻量级密码验证 Modal（使用 `type="password"` 密文输入框 + 验证码输入框）。 |
| **安全设置确认使用原生 `window.confirm`**<br>`submitSecurityReauth()` | `app.js:3644` 与 `3657` 在撤销会话、停用动态验证码时调用原生 `window.confirm(...)`，而项目中已有现成的 `#confirm-modal`（`showConfirmModal`）。 | **视觉不一致**：同一工作台中删除/清空用自定义 `#confirm-modal`，安全设置却弹出系统原生阻塞对话框。 | 统一封装返回 Promise 的 `confirmDialog(title, message, danger)`，全站替换 `window.confirm`。 |

### 1.3 全站 14 个模态弹窗与浮层交互一致性审计
我们对 `app.html` 中的 **13 个 `.modal` 弹窗 + 1 个 `#display-settings-popover` 设置浮层 + 1 个卡片内联删除确认 `.card-delete-confirm-pop`** 进行了逐一核对：

| 序号 | 弹窗 ID / 名称 | 触发入口 | 右上角关闭按钮 | 点击遮罩关闭 | `Esc` 键关闭 | 焦点管理（打开聚焦 / 关闭归还） | 核心 UI/UX 缺陷 |
|---|---|---|---|---|---|---|---|
| 1 | `#display-settings-popover`<br>工作台设置浮层 | 顶栏头像按钮 | ❌ 无（点击外部关闭） | ✅ 支持 | ❌ **不支持** | ❌ 未聚焦首项 | 打开关于/头像弹窗时调用了未定义的 `closeSettingsPopover()` 导致报错，浮层不关闭！ |
| 2 | `#confirm-modal`<br>通用确认弹窗 | 清空未收藏 | ❌ 无 | ✅ 支持 | ❌ **不支持** | ❌ 未自动聚焦取消/确认 | 缺少 `Esc` 关闭；未支持回车快捷确认或焦点锁定。 |
| 3 | `#enrollment-modal`<br>绑定身份验证器 | 首次登录/安全设置 | ❌ 无（强制流程有跳过键） | ❌ 无 | ❌ **不支持** | ⚠️ 仅打开时聚焦输入框 | 当从安全设置主动触发（`enrollmentExplicit`）时，用户无法按 `Esc` 或右上角关闭取消。 |
| 4 | `#security-modal`<br>安全设置（双栏） | 设置浮层 → 安全设置 | ✅ SVG 图标 | ❌ **不支持** | ❌ **不支持** | ❌ 无 | 1. 点击遮罩和按 `Esc` 均无法关闭；<br>2. 切换到「安全日志」Tab 时不会自动加载日志，右侧一片空白，必须手动点「查看摘要」。 |
| 5 | `#admin-modal`<br>账户管理 | 设置浮层 → 账户管理 | ✅ SVG 图标 | ✅ 支持 | ❌ **不支持** | ❌ 无 | 按 `Esc` 无法关闭；用户行操作按钮过多（3个按钮）在窄屏下换行拥挤。 |
| 6 | `#avatar-editor-modal`<br>编辑头像 | 设置浮层 → 编辑头像 | ✅ SVG 图标 | ✅ 支持 | ❌ **不支持** | ❌ 无 | 1. 触发时因 `closeSettingsPopover` 未定义直接抛异常中断；<br>2. 自定义字符需先点「预览」再点「保存」，多此一举，应输入即实时预览。 |
| 7 | `#private-unlock-modal`<br>隐私解锁弹窗 | 卡片锁图标 / 遮罩 | ✅ SVG 图标 | ⚠️ 仅绑定 `#private-unlock-modal`，但内部 `.private-unlock-backdrop` 拦截了点击！ | ❌ **不支持** | ⚠️ 打开聚焦发送按钮 | 1. `.private-unlock-backdrop` 盖在 `.modal` 上，导致 `e.target === privateUnlockModal` 永不成立，**点击遮罩无法关闭**；<br>2. 确认解锁时引用未定义变量直接崩溃。 |
| 8 | `#about-modal`<br>关于 DoNote | 设置浮层 → 关于我们 | ✅ SVG 图标 | ✅ 支持 | ❌ **不支持** | ❌ 无 | 触发时同样因 `closeSettingsPopover()` 未定义导致异常，底层设置菜单不收起。 |
| 9 | `#image-compress-modal`<br>大图上传提示 | 粘贴/拖拽 >3MB 图片 | ❌ 无 | ✅ 支持 | ✅ 支持（独立监听） | ❌ 无 | 按钮垂直堆叠无图标区分，缺少默认焦点（回车无法直接选择推荐的「高清压缩上传」）。 |
| 10 | `#title-modal`<br>选择分组 | 卡片底部分组胶囊 | ❌ **无关闭按钮**（右侧放了「管理分组」） | ✅ 支持 | ❌ **不支持** | ❌ 未聚焦新建输入框 | 标题栏右侧被「管理分组」占据，无 `×` 按钮，且不支持 `Esc` 关闭。 |
| 11 | `#groups-manager-modal`<br>管理分组 | 选择分组 → 管理分组 | ✅ SVG 图标 | ✅ 支持 | ❌ **不支持** | ❌ 无 | 关闭「管理分组」后直接回到工作台，未返回上一级「选择分组」弹窗，打断给当前卡片设分组的任务流。 |
| 12 | `#remark-modal`<br>编辑备注 | 卡片顶栏/底部备注按钮 | ❌ **无关闭按钮** | ✅ 支持 | ✅ 支持 | ✅ 打开聚焦 `textarea` | 标题栏 `.modal-header-row` 只有标题没有右上角关闭按钮；自动补全未生效。 |
| 13 | `#image-viewer`<br>图片 Quick Look | 点击图片卡片 | ❌ **顶栏无关闭按钮** | ✅ 支持 | ✅ 支持 | ❌ 无 | 1. `app.js:5649` 查找 `.image-viewer-close`，但 `app.html:1221` 中**根本没有关闭按钮**；<br>2. 移动端缺少双指捏合缩放或关闭按钮提示，全屏图片时点击边缘极难退出。 |
| 14 | `#text-viewer` / `#file-viewer`<br>文本/代码/链接/文件预览 | 点击对应卡片 | ❌ **顶栏无关闭按钮** | ✅ 支持 | ✅ 支持 | ❌ 无 | `app.js:5848` 与 `6029` 查找 `#text-viewer-close`、`#file-viewer-close`，但 `app.html` 顶栏中**均未渲染关闭按钮**！触屏端或小屏弹窗占满 92vw×84vh 时，用户找不到明确的关闭按钮。 |

---

## 第二棒：前端工程师 —— 架构、状态流、DOM/事件修复与响应式重构方案

作为前端工程师，我深入检查了 `app.js`、`app.html` 和 `style.css` 的真实代码逻辑，发现了 **5 个会导致功能直接报错或失效的阻断性前端 Bug**，以及多处状态同步与交互架构缺陷，以下给出可直接落地的工程优化方案。

### 2.1 阻断性运行时 Bug 修复方案（P0 级）

#### Bug 1：打开「关于我们」和「编辑头像」时调用未定义的 `closeSettingsPopover()` 抛出 `ReferenceError`
- **根因定位**：
  - `app.js:615` 在 `initDisplaySettings()` 内部定义了局部箭头函数 `const togglePopover = (open) => { ... }`，并未在全局定义 `closeSettingsPopover()`。
  - 但在 `app.js:3368`（`aboutOpen` 点击事件）和 `app.js:3416`（`avatarEditTrigger` 点击事件）中直接调用了 `closeSettingsPopover()`。
  - **严重后果**：在 `avatarEditTrigger` 点击事件中，`closeSettingsPopover()` 位于函数末尾，虽弹窗打开但控制台报 `Uncaught ReferenceError: closeSettingsPopover is not defined`，且下拉菜单未关闭；在 `aboutOpen` 中同样报错且设置菜单悬停在弹窗下方。同时 `securityOpen` 和 `adminOpen` 甚至没调关闭浮层。
- **修复代码**：
  ```javascript
  // 在全局作用域导出统一关闭函数（替换 initDisplaySettings 内的局部封闭逻辑）
  function closeSettingsPopover() {
    if (!displaySettingsPopover || !displaySettingsBtn) return;
    displaySettingsPopover.classList.add('hidden');
    displaySettingsBtn.setAttribute('aria-expanded', 'false');
  }
  // 在 securityOpen / adminOpen / aboutOpen / avatarEditTrigger / clearAllBtn 点击时统一调用 closeSettingsPopover()
  ```

#### Bug 2：隐私解锁弹窗（`#private-unlock-modal`）点击「解锁」时抛出 `ReferenceError: selectedUnlockDuration is not defined` 且前后端契约不匹配
- **根因定位**：
  - 后端 `app/src/routes/messages.js:393` 与 `app/src/private-unlock.js:6` 要求 `/api/auth/email/private-unlock` 和 `/api/messages/private/verify` 请求体必须传入 `{ scope, messageId, duration, hours }`（由 `privateUnlockTarget(req.body)` 校验，否则直接返回 `400 INVALID_PRIVATE_UNLOCK`）。
  - 前端 `app.js:5437` 虽然写了 `readPrivateUnlockSelection()`，但在 `privateUnlockSendBtn`（`5531` 行）发送时只传了 `{ action: 'private' }`（缺少 `scope/duration`），在 `privateUnlockConfirm`（`5563` 行）只传了 `{ challenge, code }`，且在 `5574` 行调用了 **`applyPrivateUnlock(selectedUnlockDuration)`** —— 而 `selectedUnlockDuration` 在整个仓库中**根本未定义**，且 `applyPrivateUnlock(scope, messageId, expiresAt)`（`234` 行）需要 3 个参数！
- **修复代码**：
  ```javascript
  // 1. 发送验证码时校验并锁定 selection：
  const selection = readPrivateUnlockSelection();
  if (!selection) {
    showPrivateUnlockError('请先选择有效的解锁范围与时长');
    return;
  }
  privateUnlockSelection = selection;
  const r = await authFetch('/api/auth/email/private-unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'private', ...selection })
  });

  // 2. 验证确认时携带同一 selection 并按服务端返回结构处理：
  const activeSelection = privateUnlockSelection || readPrivateUnlockSelection();
  const r = await authFetch('/api/messages/private/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: privateUnlockChallenge, code, ...activeSelection })
  });
  const d = await r.json();
  if (!d.permanent) {
    applyPrivateUnlock(d.scope, d.messageId, d.expiresAt);
  }
  closePrivateUnlockModal();
  renderMessages();
  if (currentTab === 'favorites') renderFavorites();
  ```

#### Bug 3：邮箱验证码登录成功分支调用未定义的 `handleSuccessfulLogin(data)`
- **根因定位**：
  - `app.js:3873` 在邮箱验证码二次验证分支中写了 `if (response.ok && data.token) { await handleSuccessfulLogin(data); ... }`。
  - 搜索全仓，`handleSuccessfulLogin` **从未定义**！且后端 `/api/auth/login/verify` 是通过设置 `HttpOnly` Cookie 并返回 `{ ok: true }`，接着前端应请求 `/api/auth/me` 获取 `user` 与 `csrfToken` 后调用 `enterChatMode()`（正如 `3920` 行密码登录分支所做的那样）。
- **修复代码**：
  將邮箱验证码二次验证与密码 MFA 验证逻辑合并复用，验证成功后统一调用 `/api/auth/me` 初始化 `accountUser`、`accountSessionId`、`accountCsrfToken` 并执行 `enterChatMode()`。

#### Bug 4：拖拽上传文件被 `handleDrop` 错误拦截，现有的 `handleFileUpload` 沦为死代码
- **根因定位**：
  - `app.js:4743` 完整定义了 `handleFileUpload(files)`（自动分离图片与普通文件并入队上传）。
  - 但 `app.js:5633` 的 `handleDrop(e)` 却手动分离了 `otherFiles` 并弹出 `showToast('本项目为纯剪贴板，仅支持文字与图片截图同步，不支持普通文件附件')`，导致用户无法拖拽上传普通文件。
- **修复代码**：
  将 `handleDrop` 简化为直接调用 `await handleFileUpload(files)`，同时更新 `#drop-overlay` 提示文案为「松开即可上传图片与文件」。

#### Bug 5：Quick Look 查看器（`#image-viewer` / `#text-viewer` / `#file-viewer`）关闭按钮缺失导致自动化测试与触屏关闭失败
- **根因定位**：
  - `app/test-browser/image-preview.js:55` 明确断言 `await page.locator('.image-viewer-close').click()`；`app.js:5649`、`5848`、`6029` 也都查询了关闭按钮，但 `app.html` 的三个查看器顶栏 `.paste-modal-header-actions` 中漏掉了关闭按钮。
- **修复代码**：
  在 `#image-viewer`、`#text-viewer`、`#file-viewer` 的 `.paste-modal-header-actions` 最右侧统一补齐标准关闭按钮（带 `.image-viewer-close` / `#text-viewer-close` / `#file-viewer-close`），兼顾桌面端、移动端与 E2E 测试脚本。

### 2.2 模态框（Modal）统一生命周期管理器设计
当前 14 个弹窗各自为政：有的用 `e.target === modal` 判断遮罩点击，有的内部嵌套了 `.modal-backdrop` 导致点击失效；`Escape` 监听器在全局写了 3 处却只覆盖了 5 个弹窗（`#security-modal`、`#admin-modal`、`#about-modal`、`#avatar-editor-modal`、`#title-modal`、`#groups-manager-modal`、`#private-unlock-modal`、`#confirm-modal` 均不支持 `Esc` 关闭）。

**工程重构方案 —— 引入轻量级 `ModalManager`（约 45 行原生 JS，零外部依赖）**：
```javascript
const ModalManager = (() => {
  const stack = []; // [{ el, onClose, triggerEl }]

  function open(modalEl, { onClose, focusSelector } = {}) {
    if (!modalEl) return;
    closeSettingsPopover();
    const triggerEl = document.activeElement;
    modalEl.classList.remove('hidden');
    const existingIdx = stack.findIndex(item => item.el === modalEl);
    if (existingIdx !== -1) stack.splice(existingIdx, 1);
    stack.push({ el: modalEl, onClose, triggerEl });

    requestAnimationFrame(() => {
      const target = (focusSelector && modalEl.querySelector(focusSelector))
        || modalEl.querySelector('input:not([disabled]):not(.hidden), textarea:not([disabled]), button.btn-primary:not([disabled])');
      target?.focus?.();
    });
  }

  function closeTop() {
    while (stack.length > 0) {
      const top = stack.pop();
      if (!top.el.classList.contains('hidden')) {
        if (typeof top.onClose === 'function') top.onClose();
        else top.el.classList.add('hidden');
        top.triggerEl?.focus?.();
        return true;
      }
    }
    return false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!displaySettingsPopover?.classList.contains('hidden')) {
        e.preventDefault();
        closeSettingsPopover();
        return;
      }
      if (closeTop()) e.preventDefault();
    }
  });

  return { open, closeTop };
})();
```
- **收益**：
  1. 全站 14 个弹窗 + 设置浮层 100% 支持 `Esc` 按层级栈顶依次关闭（例如从 `#title-modal` 打开 `#groups-manager-modal`，按 `Esc` 优先关闭管理面板并可回退到选择分组弹窗）；
  2. 弹窗打开自动将焦点移入主输入/主操作控件，关闭后自动将焦点归还给触发按钮，满足无障碍（WAI-ARIA Dialog）标准；
  3. 修复 `#private-unlock-modal` 遮罩点击不关闭问题（为 `.private-unlock-backdrop` 绑定点击关闭）。

### 2.3 工作台与复杂弹窗细节交互升级
1. **「安全设置」弹窗（`#security-modal`）Tab 切换按需加载**：
   - 当前点击左侧「安全日志」（`data-panel="history"`）时，右侧 `#security-history` 为空，用户必须再点一次「查看摘要」才有数据。
   - **优化**：在 `switchPane(panelId)` 中，当 `panelId === 'history'` 且 `#security-history` 为空时，自动调用 `loadSecurityHistory(false)` 加载安全事件摘要。
2. **「编辑头像」弹窗（`#avatar-editor-modal`）交互简化**：
   - 将 `#avatar-custom-input` 的 `input` 事件直接绑定实时预览（当输入有效单字符时立即更新 `#avatar-preview-large` 和 `currentAvatarSelection`），无需强制用户先点「预览」按钮才能点「保存」。
3. **「分组选择」与「分组管理」弹窗串联**：
   - 从 `#title-modal` 点击「管理分组」进入 `#groups-manager-modal` 时，记录来源状态 `openedFromTitleModal = currentTitleMessage`；关闭分组管理弹窗时，若 `openedFromTitleModal` 存在，自动重新打开 `#title-modal` 并刷新分组列表，形成无缝闭环。

---

## 第三棒：测试工程师 —— 单元测试、集成测试与 E2E 自动化测试方案

基于测试金字塔原则，针对本次发现的工作台与弹窗交互问题，设计三层自动化验证体系，复用项目现有的 `node:test` 与 `Playwright`（`app/test-browser/`）。

### 3.1 单元测试（Unit Tests，基于 `node:test` + `vm` 沙箱）
聚焦核心纯函数与状态计算逻辑，覆盖等价类、边界值与异常路径：

| 测试用例命名 | 测试目标 | 输入与边界条件 | 预期断言结果 |
|---|---|---|---|
| `test_clampCardSize_boundaries` | 卡片缩放尺寸边界裁剪 | `80`, `520`, `300`, `0`, `-50`, `9999`, `NaN`, `'invalid'`, `null` | 小于 80 返回 `80`；大于 520 返回 `520`；非法值返回默认值 `300`；`--card-scale` 精确计算且 `dataset.cardDensity` 正确切换 `micro`/`compact`/`normal` |
| `test_detectPasteCardSpec_variants` | 5 类卡片语义识别 | 纯文本、单行/多行 URL、含 ```` ``` ```` 代码块、启发式代码（3行+关键字）、图片（含/不含原图）、文件（带/不带后缀） | 准确返回 `text` / `link` / `code` / `image` / `file` 及其 `metaText` |
| `test_readPrivateUnlockSelection_validation` | 隐私解锁参数构造与校验 | 1) `scope='current'`, `messageId=null`<br>2) `scope='all'`, `duration='600'`<br>3) `duration='custom'`, `hours='0'` / `'168.5'` / `'1.5'` / `'abc'`<br>4) `duration='permanent'` | 1) 返回 `null`（防空 ID 提交）<br>2) 返回 `{ scope: 'all', duration: '600' }`<br>3) `0`、`168.5`、`abc` 均返回 `null`，`'1.5'` 合法通过<br>4) 返回 `{ scope, duration: 'permanent' }` |
| `test_prunePrivateUnlocks_and_relock` | 隐私解锁到期自动重锁状态机 | 模拟单卡到期时间戳 `now - 10` 与全局未到期 `now + 60000` | 过期条目从 `privateCardUnlockExpiresAt` 清除，`isPrivateCardUnlocked` 返回准确布尔值 |

### 3.2 集成测试（Integration Tests，前后端契约对齐验证）
重点验证前端请求载荷与后端路由校验规则的一致性：
1. **`test_private_unlock_api_contract`**：
   - 验证前端 `privateUnlockSendBtn` 发送的 JSON 载荷包含 `privateUnlockTarget` 所需的 `{ action: 'private', scope, messageId, duration, hours }`；
   - 验证 `/api/messages/private/verify` 在 `duration: '600'` 时返回 `{ success: true, permanent: false, scope, messageId, expiresAt }`，前端 `applyPrivateUnlock` 正确接收 `(scope, messageId, expiresAt)` 三个参数，不再抛出 `selectedUnlockDuration is not defined`。
2. **`test_email_code_login_verify_flow`**：
   - 模拟邮箱验证码登录两步流程（`/api/auth/login` → `/api/auth/login/verify` → `/api/auth/me`），验证不触发 `ReferenceError: handleSuccessfulLogin is not defined` 且能正常进入工作台并挂载 CSRF Token。

### 3.3 端到端浏览器测试（E2E Tests，扩展 `app/test-browser/`）
在现有 `app/test-browser/image-preview.js` 基础上，新增 `workspace-modals.e2e.js`：
1. **全量弹窗開闭与 `Esc` 回归测试**：
   - 依次触发设置浮层、`#about-modal`、`#avatar-editor-modal`、`#security-modal`、`#admin-modal`、`#title-modal`、`#groups-manager-modal`、`#remark-modal`、`#confirm-modal`、`#image-viewer`、`#text-viewer`、`#file-viewer`；
   - 断言 `page.on('pageerror')` 数组长度为 `0`（捕获如 `closeSettingsPopover is not defined` 等一切未捕获异常）；
   - 断言每个弹窗按 `Escape` 键或点击遮罩/右上角关闭按钮后均能添加 `.hidden` 类并恢复焦点。
2. **多视口响应式测试（Desktop `1440×900` vs Mobile `375×812`）**：
   - 在 `375×812` 触屏模拟下，验证页面无横向滚动条（`document.documentElement.scrollWidth <= 375`）、底部筛选 Dock 可横向滑动、移动端卡片能够完成复制、预览、收藏、备注与删除全流程。

---

## 第四棒：代码审查员（Code Review）—— 缺陷分级清单与安全/性能/质量修复指南

> 已加载并严格遵循 `user-code-review` 技能规范，从**功能正确性、安全隐患、性能问题、代码质量、可维护性**五个维度对工作台前端代码进行逐行审查。

### 4.1 审查发现汇总表

| 编号 | 文件与行号 | 严重程度 | 类型 | 问题简述 |
|---|---|---|---|---|
| **CR-01** | `app/public/app.js:1168, 2266, 2299, 5243, 5304, 6447` | **Critical** | 安全 (DOM XSS) | 多处使用 `innerHTML` 直接拼接未经 `escapeHTML` 转义的用户输入（`remark`、`title`、分组名 `name`），存在存储型/反射型 DOM XSS 漏洞 |
| **CR-02** | `app/public/app.js:5574` | **Critical** | 功能正确性 | 隐私解锁确认回调使用未定义变量 `selectedUnlockDuration`，且未向后端传递 `scope/duration` 参数，导致隐私解锁功能 100% 报错不可用 |
| **CR-03** | `app/public/app.js:3368, 3416` | **Critical** | 功能正确性 | 调用未定义函数 `closeSettingsPopover()`，导致点击「关于我们」和「编辑头像」抛出未捕获 `ReferenceError` |
| **CR-04** | `app/public/app.js:3873` | **Critical** | 功能正确性 | 邮箱验证码登录成功分支调用未定义函数 `handleSuccessfulLogin(data)`，导致邮箱验证码登录在最后一步必然失败 |
| **CR-05** | `app/public/app.js:5901, 5906` | **Major** | 安全 / 交互 | 敏感内容密码验证使用 `window.prompt` 明文输入密码，易被肩窥且破坏安全输入规范 |
| **CR-06** | `app/public/app.html:1206` & `app/public/app.js:6411` | **Major** | 功能正确性 | 备注自动补全容器 `#remark-autocomplete` 在 HTML 中缺失，且 `remarkInput` 未绑定触发函数，导致 70 行自动补全代码完全失效 |
| **CR-07** | `app/public/app.html:214` & `app/public/app.js:5430` | **Major** | 功能正确性 | 顶栏 `#private-unlock-global-btn` 按钮未绑定事件监听器，点击无响应 |
| **CR-08** | `app/public/app.html:1221, 1255, 1278` | **Major** | 功能 / 可访问性 | `#image-viewer`、`#text-viewer`、`#file-viewer` 缺失顶栏关闭按钮 DOM，导致 `app.js` 绑定落空且 E2E 测试 `.image-viewer-close` 失败 |
| **CR-09** | `app/public/app.js:500, 1280` | **Major** | 性能问题 | `renderCategoryChips()` 和 `renderTimelineList()` 在每次单卡状态变更或新消息到达时全量重建所有 DOM 节点并重复遍历全部消息数组 |
| **CR-10** | `app/public/app.js:3223` | **Minor** | 代码质量 | `catch` 块中重复书写两遍完全相同的 `currentMode = 'pending'; authBtn.disabled = true;` |
| **CR-11** | `app/public/avatar-editor-new.html` | **Minor** | 可维护性 | 工作区残留未被引用的草稿片段文件 `avatar-editor-new.html`（内容已合并入 `app.html`），易造成后续维护混淆 |

---

### 4.2 逐项详细审查报告与修复代码示例

#### [CR-01] 多处 `innerHTML` 未转义用户可控字符串导致 DOM XSS 风险
```
文件: app/public/app.js
行号: 500, 1168, 1844, 1877, 1889, 2266, 2299, 5243, 5304, 6447
严重程度: Critical
类型: [安全]
问题描述:
虽然消息正文 `msg.content` 经过了 `escapeHTML()` 处理，但卡片的 `remark`（备注）、`title`（分类标题）和 `userGroups`（分组名称）在以下 6 处被直接拼入 `innerHTML` 而未转义：
1. 行 500: `btn.innerHTML = '<span class="category-chip-dot" ...></span>' + name`
2. 行 1844/2299: `tag.innerHTML = '<span ...></span>' + cleanTitle`
3. 行 1877/2266: `entryBtn.innerHTML = '<span ...></span><span class="card-remark-entry-text">' + cleanRemark + '</span>'`
4. 行 5243: `btn.innerHTML = '<span ...></span><span class="group-picker-name">' + name + '</span>'`
5. 行 5304: `row.innerHTML = '...<span class="groups-manager-name">' + name + '</span>...'`
6. 行 6447: `btn.innerHTML = '...<span class="remark-autocomplete-item-text">' + remark + '</span>...'`
影响:
若用户输入包含 `<img src=x onerror=...>` 的备注或分组名称（或跨设备同步、共享导入），会在所有打开工作台的客户端触发存储型 DOM XSS，可执行任意脚本或窃取当前解锁的敏感剪贴板内容。
建议:
凡是使用 `innerHTML` 拼接动态文本处，一律包裹 `escapeHTML()`，或改用安全的 DOM API（`document.createElement` + `textContent`）。
```
**修复示例**：
```javascript
// 原代码 (app.js:2266)
entryBtn.innerHTML = cleanRemark
  ? `<span class="card-remark-entry-dot"></span><span class="card-remark-entry-text">${cleanRemark}</span>`
  : '<span class="card-remark-entry-plus">+</span><span>备注</span>';

// 修复后
entryBtn.innerHTML = cleanRemark
  ? `<span class="card-remark-entry-dot"></span><span class="card-remark-entry-text">${escapeHTML(cleanRemark)}</span>`
  : '<span class="card-remark-entry-plus">+</span><span>备注</span>';
```

---

#### [CR-02] 隐私解锁验证参数缺失与未定义变量引用导致功能崩溃
```
文件: app/public/app.js
行号: 5531-5580
严重程度: Critical
类型: [功能]
问题描述:
1. `privateUnlockSendBtn` 点击发送验证码时未调用 `readPrivateUnlockSelection()` 获取 `scope`、`messageId`、`duration`、`hours`，导致后端 `privateUnlockTarget(req.body)` 校验直接抛 400 错误；
2. `privateUnlockConfirm` 点击确认解锁时未上传 `selection`，且第 5574 行调用 `applyPrivateUnlock(selectedUnlockDuration)` 引用了不存在的变量 `selectedUnlockDuration`。
影响:
隐私卡片解锁全流程在发送验证码和确认验证码两个环节均会失败。
建议:
在发送验证码前通过 `readPrivateUnlockSelection()` 读取并冻结选项，发往 `/api/auth/email/private-unlock` 与 `/api/messages/private/verify`，并用服务端返回的 `{ scope, messageId, expiresAt }` 调用 `applyPrivateUnlock(d.scope, d.messageId, d.expiresAt)`。
```

---

#### [CR-03] `closeSettingsPopover()` 未定义导致头像编辑器与关于弹窗报错
```
文件: app/public/app.js
行号: 615, 3368, 3416
严重程度: Critical
类型: [功能]
问题描述:
`initDisplaySettings()` 内部仅定义了局部的 `togglePopover`，而 `aboutOpen`（3368行）与 `avatarEditTrigger`（3416行）调用了全局未定义的 `closeSettingsPopover()`。
影响:
点击设置菜单中的「关于我们」或「编辑头像」时控制台抛出 `ReferenceError: closeSettingsPopover is not defined`，且设置浮层不会关闭，遮挡在模态框之上或残留显示。
建议:
将 `closeSettingsPopover()` 提升为模块级函数，并在打开任何模态框（安全设置、账户管理、关于我们、编辑头像、清空确认）时统一调用。
```

---

#### [CR-04] 邮箱验证码登录调用未定义函数 `handleSuccessfulLogin`
```
文件: app/public/app.js
行号: 3872-3876
严重程度: Critical
类型: [功能]
问题描述:
邮箱验证码登录在 `/api/auth/login/verify` 响应后判断 `if (response.ok && data.token)` 并调用未定义的 `handleSuccessfulLogin(data)`。同时后端 `issue()` 在 Cookie 模式下并不返回 `data.token`（而是设置 Cookie 并返回 `{ ok: true }`）。
影响:
使用「验证码登录」Tab 登录的用户在输入正确 6 位验证码后无法进入工作台。
建议:
移除未定义的 `handleSuccessfulLogin` 分支，复用下方统一的 `/api/auth/me` 会话拉取与 `enterChatMode()` 逻辑。
```

---

#### [CR-05] 敏感文本验证使用 `window.prompt` 明文输入密码
```
文件: app/public/app.js
行号: 5895-5910
严重程度: Major
类型: [安全 / 质量]
问题描述:
`sensitiveCredentials()` 使用 `window.prompt(message)` 获取用户当前登录密码与动态验证码。
影响:
1. `window.prompt` 输入框为明文展示，用户在公共场所输入密码极易泄密；
2. 阻塞主线程（导致 WebSocket 心跳与倒计时暂停），且在部分移动端 WebView / PWA 独立窗口模式下 `window.prompt` 会被静默拦截返回 `null`。
建议:
改为异步 Promise 驱动的轻量级自定义验证弹窗（复用 `.modal` 样式，`input[type="password"]` + 验证码输入）。
```

---

#### [CR-06] 卡片列表高频全量重绘（`appendSingleMessage` 与 `renderMessages`）
```
文件: app/public/app.js
行号: 2158-2169
严重程度: Major
类型: [性能]
问题描述:
每当用户粘贴一条新消息或通过 Socket 收到一条新消息时，`appendSingleMessage(msg)` 直接调用 `renderMessages({ scrollBottom: true })`，清空整个 `messagesList.innerHTML = ''` 并重新创建所有卡片的 DOM、重新绑定所有事件监听器、重新触发所有图片懒加载观察器。
影响:
当工作台加载了数百条历史记录与图片卡片时，每次粘贴新内容都会引发明显的 DOM 重排与图片闪烁。
建议:
当 `currentTypeFilter === 'all' && !currentCategoryFilter && !searchState.active` 时，若顶部已存在「今天」的日期分割线（`.timeline-date-divider[data-date-group="..."]`），直接 `createMessageElement(msg)` 并使用 `divider.after(newCardEl)` 增量插入顶部，仅给新卡片添加 `.is-new` 动画类，实现 $O(1)$ 零闪烁插入。
```

---

## 五、 实施路线图与优先级矩阵（P0 / P1 / P2）

为确保改动稳妥、零回归风险，建议按以下三个阶段推进实施：

| 阶段 | 优先级 | 核心改造项 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| **阶段一：阻断性 Bug 与安全漏洞清零** | **P0（立即执行）** | 1. 修复 6 处 `innerHTML` 未转义导致的 DOM XSS（CR-01）；<br>2. 修复 `closeSettingsPopover` 未定义报错（CR-03）；<br>3. 修复隐私解锁 `selectedUnlockDuration` 崩溃与前后端参数契约（CR-02）；<br>4. 修复邮箱验证码登录 `handleSuccessfulLogin` 未定义问题（CR-04）；<br>5. 接线顶栏 `#private-unlock-global-btn` 与拖拽文件上传 `handleFileUpload`。 | `app/public/app.js` | 1. 控制台零 `ReferenceError`；<br>2. 含特殊 HTML 字符的备注/分组名正常纯文本渲染；<br>3. 隐私解锁与邮箱验证码登录全流程跑通。 |
| **阶段二：全站弹窗规范化与组件补齐** | **P1（高优迭代）** | 1. 引入 `ModalManager` 统一管理 14 个弹窗的 `Esc` 关闭、遮罩点击（修复 `#private-unlock-modal` 遮罩失效）与焦点归还；<br>2. 为 `#image-viewer`、`#text-viewer`、`#file-viewer`、`#title-modal`、`#remark-modal` 补齐右上角关闭按钮；<br>3. 补齐 `#remark-autocomplete` DOM 节点并激活备注自动补全；<br>4. 将 `window.prompt`（敏感文本验证）与 `window.confirm`（安全设置确认）替换为自定义模态框。 | `app/public/app.html`<br>`app/public/app.js`<br>`app/public/style.css` | 1. 任意弹窗按 `Esc` 或点遮罩均可关闭；<br>2. `app/test-browser/image-preview.js` E2E 测试 100% 通过；<br>3. 备注输入时正常弹出历史备注补全列表。 |
| **阶段三：移动端闭环、性能优化与清理** | **P2（体验精进）** | 1. 移动端卡片或 Quick Look 预览器内补齐「收藏 / 备注 / 分组 / 删除」操作入口，解决触屏端无法管理卡片的问题；<br>2. 优化 `appendSingleMessage` 为顶部增量 DOM 插入，消除全量重绘闪烁；<br>3. 安全设置切到「安全日志」自动加载摘要；头像自定义字符输入即预览；<br>4. 清理未引用的 `app/public/avatar-editor-new.html` 及 `app.js` 重复语句。 | `app/public/app.html`<br>`app/public/app.js`<br>`app/public/style.css` | 1. 375px 触屏视口下可完整执行卡片增删改查与收藏；<br>2. 粘贴新卡片时已有图片卡片零闪烁。 |
