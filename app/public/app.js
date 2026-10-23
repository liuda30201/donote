const socket = io({
  autoConnect: false,
  auth: (cb) => {
    if (currentMode === 'accounts') return cb({});
    cb({
      password: localStorage.getItem('web-clipboard-password') || '',
      userId: localStorage.getItem('web-clipboard-user-id') || ''
    });
  }
});

const PAGE_SIZE = 30;
const TOP_LOAD_THRESHOLD = 60;
const ORIGINAL_FETCH_TIMEOUT = 5000;
const THUMBNAIL_MAX_EDGE = 1200;
const LARGE_IMAGE_THRESHOLD_BYTES = 3 * 1024 * 1024;
const HD_COMPRESS_MAX_EDGE = 3840;

const authSection = document.getElementById('auth-section');
const chatSection = document.getElementById('chat-section');
const passwordInput = document.getElementById('password-input');
const togglePasswordBtn = document.getElementById('toggle-password-btn');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');

// 邮箱验证码登录元素
const passwordTab = document.getElementById('password-tab');
const emailCodeTab = document.getElementById('email-code-tab');
const usernameInput = document.getElementById('username-input');
const passwordLoginArea = document.getElementById('password-login-area');
const emailCodeLoginArea = document.getElementById('email-code-login-area');
const emailLoginCode = document.getElementById('email-login-code');
const sendEmailCodeBtn = document.getElementById('send-email-code-btn');
const emailCodeHint = document.getElementById('email-code-hint');

let currentLoginMethod = 'password'; // 'password' 或 'email-code'
let emailCodeCountdown = 0;
let emailCodeTimer = null;
let emailCodeChallenge = null;

const messagesList = document.getElementById('messages-list');
const favoritesList = document.getElementById('favorites-list');
const textInput = document.getElementById('text-input');
const sendTextBtn = document.getElementById('send-text');
const composerArea = document.getElementById('composer-area');
const toggleComposerBtn = document.getElementById('toggle-composer-btn');
const closeComposerBtn = document.getElementById('close-composer-btn');
const sensitiveTextInput = document.getElementById('sensitive-text-input');
const clearAllBtn = document.getElementById('clear-all');
const logoutBtn = document.getElementById('logout-btn');
const securityOpen = document.getElementById('security-open');
const securityModal = document.getElementById('security-modal');
const securityClose = document.getElementById('security-close');
const securityStatus = document.getElementById('security-status');
const securitySessions = document.getElementById('security-sessions');
const securityHistory = document.getElementById('security-history');
const securityReauth = document.getElementById('security-reauth');
const securityPassword = document.getElementById('security-password');
const securityCode = document.getElementById('security-code');
const securityEdit = document.getElementById('security-edit');
const securityNewPassword = document.getElementById('security-new-password');
const securityNewCode = document.getElementById('security-new-code');
const securityFactorSecret = document.getElementById('security-factor-secret');
const adminOpen = document.getElementById('admin-open');
const adminModal = document.getElementById('admin-modal');
const adminUsers = document.getElementById('admin-users');
const adminStatus = document.getElementById('admin-status');
const adminEditor = document.getElementById('admin-editor');
const adminConfirmation = document.getElementById('admin-confirmation');
const adminSummary = document.getElementById('admin-summary');
const adminClose = document.getElementById('admin-close');
const aboutOpen = document.getElementById('about-open');
const aboutModal = document.getElementById('about-modal');
const aboutClose = document.getElementById('about-close');
const avatarEditTrigger = document.getElementById('avatar-edit-trigger');
const avatarEditorModal = document.getElementById('avatar-editor-modal');
const avatarEditorClose = document.getElementById('avatar-editor-close');
const avatarEditorCancel = document.getElementById('avatar-editor-cancel');
const avatarEditorSave = document.getElementById('avatar-editor-save');
const avatarPreviewLarge = document.getElementById('avatar-preview-large');
const avatarCustomInput = document.getElementById('avatar-custom-input');
const avatarCustomPreview = document.getElementById('avatar-custom-preview');
const avatarPresetGrid = document.getElementById('avatar-preset-grid');
let adminGeneration = 0;
let adminPending = null;
const securityReauthBtn = document.getElementById('security-reauth-btn');
let securityCompleteState = null;
let securityGeneration = 0;
// A single TOTP-confirm response may deliver recovery codes after its own revocation.
let pendingSelfSecurityOp = null;
function cancelSelfSecurityDelivery() { pendingSelfSecurityOp = null; }
function canDeliverSelfSecurity(op) {
  return pendingSelfSecurityOp === op && currentMode === 'accounts' &&
    (op.revokedEpoch == null
      ? accountEpoch === op.epoch && accountUser?.id === op.userId && securityGeneration === op.generation
      : accountEpoch === op.revokedEpoch && !isAuthenticated && accountUser == null);
}
let verificationSettings = null;
let verificationGeneration = 0;
let verificationEmailChallenge = null;
let verificationCurrentChallenge = null;
let securityEmailChallenge = null;
let verificationBusy = false;
const verificationField = id => document.getElementById(id);
function clearVerificationSecrets() {
  verificationGeneration += 1; verificationBusy = false;
  verificationEmailChallenge = null; verificationCurrentChallenge = null; securityEmailChallenge = null;
  for (const id of ['verification-password', 'verification-current-code', 'verification-email', 'verification-new-email-code']) verificationField(id).value = '';
  verificationField('verification-new-email').classList.add('hidden');
}
function updateVerificationFields() {
  const method = verificationField('verification-method').value;
  verificationField('verification-email-fields').classList.toggle('hidden', method !== 'email');
  verificationField('verification-save').disabled = method === 'email' && !verificationSettings?.emailAvailable;
  verificationField('verification-current-factor').classList.toggle('hidden', verificationSettings?.method === 'password');
  verificationField('verification-current-code-label').textContent = verificationSettings?.method === 'email' ? '当前邮箱验证码' : '当前身份验证器验证码';
  verificationField('verification-send-current').classList.toggle('hidden', verificationSettings?.method !== 'email');
  verificationField('security-code-label').textContent = verificationSettings?.method === 'email' ? '当前邮箱验证码' : '动态验证码（如已启用）';
  verificationField('security-send-code').classList.toggle('hidden', verificationSettings?.method !== 'email');
}
async function loadVerificationSettings() {
  const epoch = accountEpoch; const generation = securityGeneration;
  const response = await authFetch('/api/auth/verification'); const data = await response.json();
  if (epoch !== accountEpoch || generation !== securityGeneration) return null;
  if (!response.ok) throw new Error('验证偏好读取失败，请重新打开安全设置');
  verificationSettings = data;
  verificationField('verification-controls').classList.toggle('hidden', Boolean(data.managed));
  verificationField('verification-summary').textContent = data.managed ? '管理员账户由安全策略管理，固定使用密码与身份验证器验证。' : `当前：${({ password: '仅密码', email: '邮箱验证码', totp: '身份验证器' })[data.method] || '未知'}${data.emailHint ? ` · ${data.emailHint}` : ''}${!data.emailAvailable ? '。邮件服务暂不可用。' : ''}`;
  verificationField('verification-method').value = data.method;
  updateVerificationFields(); return data;
}
async function requestEmailCode(action, targetSessionId) {
  const response = await authFetch('/api/auth/email/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(targetSessionId ? { targetSessionId } : {}) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '验证码发送失败'); return data;
}
async function runVerificationOperation(task) {
  if (verificationBusy || !verificationSettings || verificationSettings.managed) return;
  const epoch = accountEpoch; const generation = verificationGeneration; const security = securityGeneration;
  const isCurrent = () => epoch === accountEpoch && generation === verificationGeneration && security === securityGeneration;
  verificationBusy = true;
  try { await task(isCurrent); }
  catch (error) { if (isCurrent() && error.name !== 'AbortError') { securityStatus.textContent = error.message || '验证方式设置失败'; if (error.code === 'TOTP_SETUP_REQUIRED') securityStatus.textContent = '请先点击“绑定身份验证器”，完成绑定后再选择此方式。'; } }
  finally { if (isCurrent()) verificationBusy = false; }
}
verificationField('verification-method').addEventListener('change', () => { clearVerificationSecrets(); updateVerificationFields(); });
verificationField('verification-email').addEventListener('input', () => {
  verificationGeneration += 1; verificationBusy = false; verificationEmailChallenge = null;
  verificationField('verification-new-email-code').value = ''; verificationField('verification-new-email').classList.add('hidden');
});
verificationField('verification-send-current').addEventListener('click', () => runVerificationOperation(async isCurrent => {
  const data = await requestEmailCode('verification.change'); if (!isCurrent()) return;
  verificationCurrentChallenge = data.challenge; securityStatus.textContent = `验证码已发送至当前邮箱 ${data.emailHint || ''}`;
}));
verificationField('verification-save').addEventListener('click', () => runVerificationOperation(async isCurrent => {
  const method = verificationField('verification-method').value;
  const body = { password: verificationField('verification-password').value, code: verificationField('verification-current-code').value.trim(), emailChallenge: verificationCurrentChallenge };
  if (verificationSettings.method === 'email' && !body.emailChallenge) throw new Error('请先发送当前邮箱验证码并填写');
  if (method === 'email') { const email = verificationField('verification-email'); if (!email.value.trim() || !email.reportValidity()) throw new Error('请输入有效的新邮箱'); body.email = email.value.trim(); } else body.method = method;
  const response = await authFetch(method === 'email' ? '/api/auth/email/start' : '/api/auth/verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!isCurrent()) return;
  if (!response.ok) { const error = new Error(data.error || '验证方式设置失败'); error.code = data.code || data.error; throw error; }
  verificationField('verification-password').value = ''; verificationField('verification-current-code').value = ''; verificationCurrentChallenge = null;
  if (method === 'email') { verificationEmailChallenge = data.challenge; verificationField('verification-new-email').classList.remove('hidden'); securityStatus.textContent = `请输入新邮箱 ${data.emailHint || ''} 收到的验证码`; verificationField('verification-new-email-code').focus(); }
  else { await logout(false, false); showToast('验证方式已更新，请重新登录'); }
}));
verificationField('verification-confirm-email').addEventListener('click', () => runVerificationOperation(async isCurrent => {
  if (!verificationEmailChallenge) throw new Error('请先验证当前身份并发送新邮箱验证码');
  const response = await authFetch('/api/auth/email/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: verificationEmailChallenge, code: verificationField('verification-new-email-code').value.trim() }) });
  const data = await response.json(); if (!isCurrent()) return; if (!response.ok) throw new Error(data.error || '新邮箱验证失败');
  await logout(false, false); showToast('邮箱验证已启用，请重新登录');
}));
verificationField('security-send-code').addEventListener('click', async () => {
  const epoch = accountEpoch; const generation = securityGeneration; const button = verificationField('security-send-code'); button.disabled = true;
  try { const data = await requestEmailCode(securityGrantAction, securityTarget); if (epoch !== accountEpoch || generation !== securityGeneration) return; securityEmailChallenge = data.challenge; securityStatus.textContent = `验证码已发送至 ${data.emailHint || '当前邮箱'}`; }
  catch (error) { if (epoch === accountEpoch && generation === securityGeneration) securityStatus.textContent = error.message; }
  finally { if (epoch === accountEpoch && generation === securityGeneration) button.disabled = false; }
});
let securityGrant = null;
let securityGrantAction = null;
let securityTarget = null;
const themeToggleBtn = document.getElementById('theme-toggle');
const layoutToggleBtn = document.getElementById('layout-toggle');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomText = document.getElementById('scroll-bottom-text');
const favoritesBadge = document.getElementById('favorites-badge');
const currentUserEl = document.getElementById('current-user');
const connectionStatus = document.getElementById('connection-status');
const messageCount = document.getElementById('message-count');
const expireInfo = document.getElementById('expire-info');
const toastEl = document.getElementById('toast');
const tabs = document.querySelectorAll('.tab');

const imageCompressModal = document.getElementById('image-compress-modal');
const imageCompressMsg = document.getElementById('image-compress-message');
const imageCompressBtn = document.getElementById('image-compress-btn');
const imageOriginalBtn = document.getElementById('image-original-btn');
const imageCancelBtn = document.getElementById('image-cancel-btn');
const limitDurationChk = document.getElementById('limit-duration-chk');
const loginDurationSelect = document.getElementById('login-duration-select');

let expireCheckInterval = null;

let currentXhr = null;
let uploadQueue = [];
let isUploading = false;

let messages = [];
let favorites = [];
let hasMoreMessages = false;
let initialLoaded = false;
let isInitialLoading = false;
let isLoadingOlder = false;
let isReconnectRefreshing = false;
let imageProcessingCount = 0;
let isAuthenticated = false;
let requirePassword = true;
let currentTab = 'messages';
let currentTypeFilter = 'all'; // 'all' | 'text' | 'code' | 'link' | 'image' | 'file'
let currentCategoryFilter = null; // null = 不筛选, string = 按分类标题筛选
let privateGlobalUnlockExpiresAt = 0;
const privateCardUnlockExpiresAt = new Map();
let privateRelockTimer = null; // 最近一次隐私解锁到期计时器
function prunePrivateUnlocks() {
  const now = Date.now(); let expired = false;
  if (privateGlobalUnlockExpiresAt && privateGlobalUnlockExpiresAt <= now) { privateGlobalUnlockExpiresAt = 0; expired = true; }
  for (const [id, expiresAt] of privateCardUnlockExpiresAt) if (expiresAt <= now) { privateCardUnlockExpiresAt.delete(id); expired = true; }
  return expired;
}
function isPrivateCardUnlocked(messageId) {
  prunePrivateUnlocks();
  return privateGlobalUnlockExpiresAt > Date.now() || (privateCardUnlockExpiresAt.get(messageId) || 0) > Date.now();
}
function schedulePrivateRelock() {
  if (privateRelockTimer) clearTimeout(privateRelockTimer);
  const deadlines = [...privateCardUnlockExpiresAt.values()];
  if (privateGlobalUnlockExpiresAt) deadlines.push(privateGlobalUnlockExpiresAt);
  if (!deadlines.length) { privateRelockTimer = null; return; }
  privateRelockTimer = setTimeout(() => {
    const expired = prunePrivateUnlocks();
    privateRelockTimer = null;
    if (expired) {
      renderMessages();
      if (currentTab === 'favorites') renderFavorites();
      if (searchState.active) renderSearchResults();
      showToast('隐私解锁已到期，卡片已重新加锁');
    }
    schedulePrivateRelock();
  }, Math.max(0, Math.min(...deadlines) - Date.now()));
}
function applyPrivateUnlock(scope, messageId, expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  if (scope === 'all') privateGlobalUnlockExpiresAt = expiresAt;
  else if (scope === 'current' && typeof messageId === 'string') privateCardUnlockExpiresAt.set(messageId, expiresAt);
  else return false;
  schedulePrivateRelock();
  return true;
}
function clearPrivateUnlockState() {
  privateGlobalUnlockExpiresAt = 0;
  privateCardUnlockExpiresAt.clear();
  if (privateRelockTimer) clearTimeout(privateRelockTimer);
  privateRelockTimer = null;
}
const filterChips = document.querySelectorAll('.filter-chip');
let userId = null; // 多用户模式下的用户 ID
let currentMode = 'pending'; // 服务端确认前禁止凭据请求
let accountChallenge = null;
let accountStage = 'login';
let registrationChallenge = null;
let registrationMode = false;
let registrationAvailable = false;
let accountCsrfToken = null;
let accountEpoch = 0;
let accountAbortController = null;
let accountUser = null;
let accountSessionId = null;
let accountRevalidation = null;

// Revalidate restored or foregrounded pages before retaining private account state.
// A different profile Cookie must not leave this page showing the previous user.
function revalidateVisibleAccount() {
  if (currentMode !== 'accounts' || !isAuthenticated || accountRevalidation) return accountRevalidation;
  const epoch = accountEpoch;
  const task = (async () => {
    try {
      const response = await sessionFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Session verification failed');
      const me = await response.json();
      if (epoch !== accountEpoch) return;
      if (me.user?.id !== accountUser?.id || me.sessionId !== accountSessionId) {
        await logout(false, false, true);
        return;
      }
      accountCsrfToken = me.csrfToken || null;
    } catch {
      if (epoch === accountEpoch) await logout(false, false, true);
    }
  })();
  accountRevalidation = task;
  task.finally(() => { if (accountRevalidation === task) accountRevalidation = null; });
  return task;
}
window.addEventListener('pageshow', event => { if (event.persisted) revalidateVisibleAccount(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clearSensitiveViewerState(); else revalidateVisibleAccount(); });
window.addEventListener('pagehide', clearSensitiveViewerState);
const accountLogoutChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('donote-session') : null;
function accountRequestOptions(options = {}) {
  if (currentMode !== 'accounts') return options;
  if (!accountAbortController) accountAbortController = new AbortController();
  return { ...options, signal: options.signal || accountAbortController.signal };
}
if (accountLogoutChannel) accountLogoutChannel.onmessage = event => { if (event.data?.type === 'logout' && currentMode === 'accounts') logout(false, false, true); };
let shouldStickToBottom = false; // 是否应该保持在底部

// ========== 主题模式 (Light / Dark) ==========
const iconSun = themeToggleBtn ? themeToggleBtn.querySelector('.icon-sun') : null;
const iconMoon = themeToggleBtn ? themeToggleBtn.querySelector('.icon-moon') : null;

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (themeToggleBtn) {
      themeToggleBtn.title = '当前为深色模式，点击切换浅色模式';
      if (iconSun && iconMoon) {
        iconSun.classList.remove('hidden');
        iconMoon.classList.add('hidden');
      }
    }
  } else if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (themeToggleBtn) {
      themeToggleBtn.title = '当前为浅色模式，点击切换深色模式';
      if (iconSun && iconMoon) {
        iconSun.classList.add('hidden');
        iconMoon.classList.remove('hidden');
      }
    }
  } else {
    document.documentElement.removeAttribute('data-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (themeToggleBtn) {
      themeToggleBtn.title = '切换深色/浅色模式';
      if (iconSun && iconMoon) {
        iconSun.classList.toggle('hidden', !prefersDark);
        iconMoon.classList.toggle('hidden', prefersDark);
      }
    }
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('web-clipboard-theme');
  applyTheme(savedTheme);
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      let nextTheme;
      if (current === 'dark') {
        nextTheme = 'light';
      } else if (current === 'light') {
        nextTheme = 'dark';
      } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        nextTheme = prefersDark ? 'light' : 'dark';
      }
      localStorage.setItem('web-clipboard-theme', nextTheme);
      applyTheme(nextTheme);
    });
  }
}
initTheme();

// ========== 布局模式 (Grid / List) ==========
const layoutGridBtn = document.getElementById('layout-grid-btn');
const layoutListBtn = document.getElementById('layout-list-btn');

function applyLayout(layout) {
  const isList = layout === 'list';
  if (messagesList) messagesList.classList.toggle('layout-list', isList);
  if (favoritesList) favoritesList.classList.toggle('layout-list', isList);
  if (layoutToggleBtn) {
    layoutToggleBtn.textContent = isList ? '⊞' : '☰';
    layoutToggleBtn.title = isList ? '切换为网格多列视图' : '切换为单列卡片视图';
  }
  if (layoutGridBtn) layoutGridBtn.classList.toggle('active', !isList);
  if (layoutListBtn) layoutListBtn.classList.toggle('active', isList);
}

function initLayout() {
  const savedLayout = localStorage.getItem('web-clipboard-layout') || 'grid';
  applyLayout(savedLayout);
  if (layoutToggleBtn) {
    layoutToggleBtn.addEventListener('click', () => {
      const currentIsList = messagesList ? messagesList.classList.contains('layout-list') : false;
      const nextLayout = currentIsList ? 'grid' : 'list';
      localStorage.setItem('web-clipboard-layout', nextLayout);
      applyLayout(nextLayout);
    });
  }
  if (layoutGridBtn) {
    layoutGridBtn.addEventListener('click', () => {
      localStorage.setItem('web-clipboard-layout', 'grid');
      applyLayout('grid');
    });
  }
  if (layoutListBtn) {
    layoutListBtn.addEventListener('click', () => {
      localStorage.setItem('web-clipboard-layout', 'list');
      applyLayout('list');
    });
  }
}
initLayout();

const cardSizeSlider = document.getElementById('card-size-slider');
const popoverCardSizeSlider = document.getElementById('popover-card-size-slider');
const cardSizeReset = document.getElementById('card-size-reset');
const popoverCardSizeReset = document.getElementById('popover-card-size-reset');
const cardZoomOutBtn = document.getElementById('card-zoom-out');
const cardZoomInBtn = document.getElementById('card-zoom-in');
const cardSizeValue = document.getElementById('card-size-value');
const displaySettingsBtn = document.getElementById('display-settings-btn');
const displaySettingsPopover = document.getElementById('display-settings-popover');
const historyExpandBtn = document.getElementById('history-expand-btn');
const historyCollapseBtn = document.getElementById('history-collapse-btn');
const workspaceScrollEl = document.getElementById('workspace-scroll');
const sharesList = document.getElementById('shares-list');
const sharesBadge = document.getElementById('shares-badge');

let shares = [];
// 记录用户在当次会话中手动展开或折叠过的日期分组: dateKey -> boolean(collapsed)
const userToggledDateGroups = new Map();

function isHistoryDefaultCollapsed() {
  return localStorage.getItem('web-clipboard-history-default') === 'collapse';
}

function applyHistoryDefaultUI() {
  const collapsed = isHistoryDefaultCollapsed();
  if (historyExpandBtn) historyExpandBtn.classList.toggle('active', !collapsed);
  if (historyCollapseBtn) historyCollapseBtn.classList.toggle('active', collapsed);
}

function initHistoryCollapseSetting() {
  applyHistoryDefaultUI();
  if (historyExpandBtn) {
    historyExpandBtn.addEventListener('click', () => {
      localStorage.setItem('web-clipboard-history-default', 'expand');
      userToggledDateGroups.clear();
      applyHistoryDefaultUI();
      if (searchState.active) {
        renderSearchResults();
      } else {
        renderMessages();
      }
      if (currentTab === 'favorites') {
        renderFavorites();
      }
    });
  }
  if (historyCollapseBtn) {
    historyCollapseBtn.addEventListener('click', () => {
      localStorage.setItem('web-clipboard-history-default', 'collapse');
      userToggledDateGroups.clear();
      applyHistoryDefaultUI();
      if (searchState.active) {
        renderSearchResults();
      } else {
        renderMessages();
      }
      if (currentTab === 'favorites') {
        renderFavorites();
      }
    });
  }
}
initHistoryCollapseSetting();

// ========== Paste Pinboard 内容类型筛选栏 ==========
function initTypeFilterBar() {
  if (!filterChips || filterChips.length === 0) return;
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const nextFilter = chip.dataset.filter || 'all';
      if (currentTypeFilter === nextFilter) return;
      currentTypeFilter = nextFilter;
      filterChips.forEach((c) => {
        c.classList.toggle('active', c.dataset.filter === currentTypeFilter);
      });
      if (searchState.active) {
        renderSearchResults();
      } else {
        renderMessages({ scrollBottom: true });
      }
      if (currentTab === 'favorites') {
        renderFavorites();
      }
    });
  });
}
initTypeFilterBar();

// ========== 分类聚合 & 筛选 ==========

// 从备注字符串生成稳定颜色（hsl）
function remarkToColor(remark) {
  let hash = 0;
  for (let i = 0; i < remark.length; i++) {
    hash = ((hash << 5) - hash) + remark.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return { bg: `hsl(${hue}, 55%, 88%)`, text: `hsl(${hue}, 50%, 30%)`, dot: `hsl(${hue}, 55%, 55%)` };
}

// 统计所有消息里出现的分组名称（去空、去重、按出现次数降序）
function aggregateCategories(msgs) {
  const counts = new Map();
  for (const m of msgs) {
    const r = typeof m.title === 'string' ? m.title.trim() : '';
    if (r) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

// 统计所有消息里出现的历史备注说明（去空、去重、按出现次数降序，供备注弹窗自动补全）
function aggregateRemarks(msgs) {
  const counts = new Map();
  for (const m of msgs) {
    const r = typeof m.remark === 'string' ? m.remark.trim() : '';
    if (r) counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([remark, count]) => ({ remark, count }));
}

const categoryChipsEl = document.getElementById('category-chips');
const categoryDividerEl = document.getElementById('category-divider');

function renderCategoryChips() {
  if (!categoryChipsEl) return;
  const allMsgs = [...messages, ...favorites];
  // 合并服务端分组列表与消息中已使用的分组名，统计每个分组的卡片数
  const groupNameSet = new Set(userGroups);
  for (const m of allMsgs) {
    const t = typeof m?.title === 'string' ? m.title.trim() : '';
    if (t) groupNameSet.add(t);
  }
  const cats = [...groupNameSet].map(name => ({
    name,
    count: allMsgs.filter(m => m.title === name).length
  })).filter(c => c.count > 0);

  categoryChipsEl.innerHTML = '';

  if (cats.length === 0) {
    if (categoryDividerEl) categoryDividerEl.classList.add('hidden');
    return;
  }

  if (categoryDividerEl) categoryDividerEl.classList.remove('hidden');

  cats.forEach(({ name, count }) => {
    const { bg, text, dot } = remarkToColor(name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-chip';
    if (currentCategoryFilter === name) btn.classList.add('active');
    btn.innerHTML = `<span class="category-chip-dot" style="background:${dot}"></span>${escapeHTML(name)}`;
    btn.title = `${count} 条`;
    btn.addEventListener('click', () => {
      currentCategoryFilter = currentCategoryFilter === name ? null : name;
      renderCategoryChips();
      if (searchState.active) renderSearchResults(); else renderMessages({ scrollBottom: true });
    });
    categoryChipsEl.appendChild(btn);
  });
}

const CARD_SIZE_MIN = 80;
const CARD_SIZE_MAX = 520;
const CARD_SIZE_STEP = 20;
const CARD_SIZE_DEFAULT = 300; // 严格位于 [80, 520] 正中间 (80 + 520) / 2 = 300
let currentCardSize = CARD_SIZE_DEFAULT;
let cardSizeSaveTimer = null;

// ========== 卡片同比例无感缩放与设置面板 ==========
function clampCardSize(size) {
  const num = Number(size);
  if (!Number.isFinite(num)) return CARD_SIZE_DEFAULT;
  return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, Math.round(num)));
}

function applyCardSize(size) {
  const numSize = clampCardSize(size);
  currentCardSize = numSize;
  const scale = +(numSize / CARD_SIZE_DEFAULT).toFixed(4);
  const percent = Math.round(scale * 100);

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--card-col-width', `${numSize}px`);
  rootStyle.setProperty('--card-scale', String(scale));
  document.documentElement.dataset.cardDensity = numSize < 140 ? 'micro' : (numSize < 210 ? 'compact' : 'normal');

  if (cardSizeSlider && cardSizeSlider.value !== String(numSize)) {
    cardSizeSlider.value = String(numSize);
  }
  if (popoverCardSizeSlider && popoverCardSizeSlider.value !== String(numSize)) {
    popoverCardSizeSlider.value = String(numSize);
  }
  if (cardSizeValue) {
    cardSizeValue.textContent = `${percent}%`;
  }
  if (cardZoomOutBtn) {
    cardZoomOutBtn.disabled = numSize <= CARD_SIZE_MIN;
  }
  if (cardZoomInBtn) {
    cardZoomInBtn.disabled = numSize >= CARD_SIZE_MAX;
  }
}

function saveAndApplyCardSize(size, { immediateSave = false } = {}) {
  const clamped = clampCardSize(size);
  applyCardSize(clamped);
  if (immediateSave) {
    if (cardSizeSaveTimer) clearTimeout(cardSizeSaveTimer);
    try {
      localStorage.setItem('web-clipboard-card-size', String(clamped));
    } catch (e) {}
  } else {
    if (cardSizeSaveTimer) clearTimeout(cardSizeSaveTimer);
    cardSizeSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem('web-clipboard-card-size', String(clamped));
      } catch (e) {}
    }, 120);
  }
}

function initCardSize() {
  const savedRaw = localStorage.getItem('web-clipboard-card-size');
  // 若本地是旧版默认 320，迁移到新版居中默认 300，保证滑块默认在正中央
  const initialSize = (!savedRaw || savedRaw === '320') ? CARD_SIZE_DEFAULT : clampCardSize(savedRaw);
  applyCardSize(initialSize);

  if (cardSizeSlider) {
    cardSizeSlider.addEventListener('input', (e) => {
      saveAndApplyCardSize(e.target.value);
    });
    cardSizeSlider.addEventListener('change', (e) => {
      saveAndApplyCardSize(e.target.value, { immediateSave: true });
    });
  }

  if (popoverCardSizeSlider) {
    popoverCardSizeSlider.addEventListener('input', (e) => {
      saveAndApplyCardSize(e.target.value);
    });
    popoverCardSizeSlider.addEventListener('change', (e) => {
      saveAndApplyCardSize(e.target.value, { immediateSave: true });
    });
  }

  if (cardZoomOutBtn) {
    cardZoomOutBtn.addEventListener('click', () => {
      saveAndApplyCardSize(currentCardSize - CARD_SIZE_STEP, { immediateSave: true });
    });
  }

  if (cardZoomInBtn) {
    cardZoomInBtn.addEventListener('click', () => {
      saveAndApplyCardSize(currentCardSize + CARD_SIZE_STEP, { immediateSave: true });
    });
  }

  if (cardSizeReset) {
    cardSizeReset.addEventListener('click', () => {
      saveAndApplyCardSize(CARD_SIZE_DEFAULT, { immediateSave: true });
    });
  }

  if (popoverCardSizeReset) {
    popoverCardSizeReset.addEventListener('click', () => {
      saveAndApplyCardSize(CARD_SIZE_DEFAULT, { immediateSave: true });
    });
  }
}
initCardSize();

// 设置弹窗开闭逻辑
function closeSettingsPopover() {
  if (!displaySettingsPopover || !displaySettingsBtn) return;
  displaySettingsPopover.classList.add('hidden');
  displaySettingsBtn.setAttribute('aria-expanded', 'false');
}

function initDisplaySettings() {
  if (!displaySettingsBtn || !displaySettingsPopover) return;

  const togglePopover = (open) => {
    const shouldOpen = open !== undefined ? open : displaySettingsPopover.classList.contains('hidden');
    displaySettingsPopover.classList.toggle('hidden', !shouldOpen);
    displaySettingsBtn.setAttribute('aria-expanded', String(shouldOpen));
  };

  displaySettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    // 更新用户信息显示
    const popoverUserInfoBar = document.getElementById('popover-user-info-bar');
    const popoverCompactAvatar = document.getElementById('popover-compact-avatar');
    const popoverCompactName = document.getElementById('popover-compact-name');
    const popoverCompactEmail = document.getElementById('popover-compact-email');
    const popoverUserDivider = document.getElementById('popover-user-divider');

    if (currentMode === 'accounts' && accountUser) {
      if (popoverUserInfoBar && popoverCompactAvatar && popoverCompactName) {
        popoverUserInfoBar.classList.remove('hidden');
        if (popoverUserDivider) popoverUserDivider.classList.remove('hidden');

        // 应用存储的头像
        const storedAvatar = getStoredAvatar();
        if (storedAvatar.type === 'emoji' || storedAvatar.type === 'icon') {
          if (storedAvatar.value === 'tg-plane') {
            popoverCompactAvatar.innerHTML = `
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="color: #0088cc;">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
              </svg>
            `;
          } else {
            popoverCompactAvatar.textContent = storedAvatar.value;
          }
        } else {
          popoverCompactAvatar.textContent = storedAvatar.value.toUpperCase();
        }

        popoverCompactName.textContent = accountUser.displayName || accountUser.username;
        if (popoverCompactEmail) {
          popoverCompactEmail.textContent = accountUser.username;
        }
      }
    } else {
      if (popoverUserInfoBar) popoverUserInfoBar.classList.add('hidden');
      if (popoverUserDivider) popoverUserDivider.classList.add('hidden');
    }

    togglePopover();
  });

  displaySettingsPopover.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('click', () => {
    if (!displaySettingsPopover.classList.contains('hidden')) {
      togglePopover(false);
    }
  });
}
initDisplaySettings();

// 搜索栏快捷键徽章（根据平台展示 ⌘K 或 /）
(function initSearchShortcutHint() {
  const kbd = document.getElementById('search-shortcut-kbd');
  if (!kbd) return;
  const isMac = navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  kbd.textContent = isMac ? '⌘K' : '/';
})();

// 底部 dock 两侧快捷键淡提示（左 复制 / 右 粘贴，桌面端）
(function initDockSideHints() {
  const isMac = navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const copy = document.getElementById('dock-hint-copy');
  const paste = document.getElementById('dock-hint-paste');
  if (copy) copy.textContent = isMac ? '⌘C  复制' : 'Ctrl+C  复制';
  if (paste) paste.textContent = isMac ? '⌘V  粘贴' : 'Ctrl+V  粘贴';
})();

// 密码框明文/密文切换
if (togglePasswordBtn && passwordInput) {
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    togglePasswordBtn.setAttribute('aria-pressed', String(isPassword));
    const eyeIcon = togglePasswordBtn.querySelector('.icon-eye');
    const eyeOffIcon = togglePasswordBtn.querySelector('.icon-eye-off');
    if (eyeIcon && eyeOffIcon) {
      eyeIcon.classList.toggle('hidden', isPassword);
      eyeOffIcon.classList.toggle('hidden', !isPassword);
    }
  });
}

// Every body consumer rechecks the login generation after its asynchronous read.
async function sessionFetch(url, options = {}) {
  const epoch = accountEpoch;
  const response = await fetch(url, accountRequestOptions(options));
  const assertCurrent = () => { if (epoch !== accountEpoch) throw new DOMException('Stale session', 'AbortError'); };
  assertCurrent();
  for (const method of ['json', 'blob', 'text', 'arrayBuffer', 'formData']) {
    const consume = response[method].bind(response);
    response[method] = async (...args) => { assertCurrent(); const body = await consume(...args); assertCurrent(); return body; };
  }
  return response;
}

// 统一的带凭证 Fetch 拦截包装
async function authFetch(url, options = {}) {
  const requestEpoch = accountEpoch;
  const headers = { ...options.headers };
  if (currentMode === 'accounts') {
    if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = accountCsrfToken || '';
    const response = await sessionFetch(url, { ...accountRequestOptions(options), credentials: 'same-origin', cache: 'no-store', headers });
    if (requestEpoch !== accountEpoch) throw new DOMException('Stale session', 'AbortError');
    if (response.status === 401) { clearSensitiveViewerState(); logout(false, false); throw new Error('SESSION_INVALID'); }
    return response;
  }
  const savedPassword = localStorage.getItem('web-clipboard-password');
  const savedUserId = localStorage.getItem('web-clipboard-user-id');

  if (savedPassword) {
    headers['x-access-password'] = savedPassword;
  }
  if (savedUserId) {
    headers['x-user-id'] = savedUserId;
  }

  // 认证 Cookie（wc_auth）由反向代理下发，必须在同源请求中携带
  return sessionFetch(url, { ...options, credentials: 'same-origin', headers });
}

const topLoadingIndicator = document.createElement('div');
topLoadingIndicator.className = 'messages-top-loading hidden';
topLoadingIndicator.textContent = '正在加载更早消息...';
messagesList.parentElement.insertBefore(topLoadingIndicator, messagesList);

// ========== 顶部搜索栏（直接挂靠在 topbar，不占用主展示区） ==========
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 300000;
const SEARCH_DEBOUNCE_MS = 500;
const SEARCH_CACHE_MAX = 20;
const SEARCH_PAGE_SIZE = 50;

const searchInput = document.getElementById('toolbar-search');
const searchClearBtn = document.getElementById('toolbar-clear');
const searchShortcutKbd = document.getElementById('search-shortcut-kbd');
const toolbarStatus = document.getElementById('toolbar-status');
const loadOlderBtn = document.getElementById('load-older-btn');

function syncSearchAdornments() {
  const hasQuery = Boolean(searchInput && searchInput.value.trim());
  if (searchClearBtn) {
    searchClearBtn.classList.toggle('hidden', !hasQuery);
  }
  if (searchShortcutKbd) {
    searchShortcutKbd.classList.toggle('hidden', hasQuery || searchState.active);
  }
}

const searchState = {
  active: false,
  q: '',
  type: 'all',
  range: 'all',
  results: null,
  hasMore: false,
  total: 0,
  isLoading: false,
  cache: new Map(),
  seq: 0
};

let searchDebounceTimer = null;
let searchLastKey = '';

function rangeToFrom(range) {
  const now = Date.now();
  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

function setToolbarStatus(text, searching = false) {
  if (!toolbarStatus) return;
  toolbarStatus.textContent = text || '';
  toolbarStatus.classList.toggle('searching', Boolean(searching));
}

// 缓存按查询键存放，超过上限丢弃最早的一条（LRU）
function cacheSearchResult(key, data) {
  searchState.cache.delete(key);
  searchState.cache.set(key, data);
  while (searchState.cache.size > SEARCH_CACHE_MAX) {
    const oldest = searchState.cache.keys().next().value;
    searchState.cache.delete(oldest);
  }
}

function updateLoadOlderButton() {
  if (!loadOlderBtn) return;
  const show = searchState.active
    ? (searchState.hasMore && (searchState.results || []).length > 0)
    : hasMoreMessages;
  loadOlderBtn.classList.toggle('hidden', !show);
}

async function fetchSearchResults({ q, type, range, before, limit = SEARCH_PAGE_SIZE }) {
  const requestEpoch = accountEpoch;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  if (type && type !== 'all') params.set('type', type);
  const from = rangeToFrom(range);
  if (Number.isFinite(from)) params.set('from', String(from));
  if (Number.isFinite(before)) params.set('before', String(before));
  if (currentMode === 'multi' && userId) params.set('userId', userId);

  const response = await authFetch(`/api/messages/search?${params.toString()}`);
  if (response.status === 429) {
    const error = new Error('rate limited');
    error.code = 'RATE_LIMITED';
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
}

function renderSearchLoading() {
  messagesList.innerHTML = '<div class="messages-loading">搜索中...</div>';
}

function renderSearchResults() {
  const results = searchState.results || [];

  if (results.length === 0) {
    messagesList.innerHTML = `
      <div class="empty-state messages-empty">
        <p>没有匹配的结果</p>
        <p style="font-size: 0.8rem; margin-top: 8px;">换个关键词，或放宽类型 / 时间筛选</p>
      </div>
    `;
  } else {
    renderTimelineList(results, messagesList, { forceExpand: true });
  }

  setToolbarStatus(`找到 ${searchState.total} 条`, false);
  clearAllBtn.disabled = true;
  updateLoadOlderButton();
}

function applySearchResult(key, data) {
  if (key !== searchLastKey) return;
  searchState.active = true;
  searchState.isLoading = false;
  searchState.q = searchInput ? searchInput.value.trim() : '';
  searchState.results = Array.isArray(data.messages) ? data.messages : [];
  searchState.hasMore = Boolean(data.hasMore);
  searchState.total = Number.isFinite(data.total) ? data.total : searchState.results.length;
  renderSearchResults();
}

function exitSearchMode() {
  const wasActive = searchState.active;
  searchState.active = false;
  searchState.results = null;
  searchState.hasMore = false;
  searchState.total = 0;
  searchState.isLoading = false;
  searchState.seq += 1;
  searchLastKey = '';
  setToolbarStatus('', false);
  syncSearchAdornments();
  if (wasActive) {
    renderMessages();
  } else {
    updateLoadOlderButton();
  }
}

async function performSearch({ force = false } = {}) {
  const q = searchInput ? searchInput.value.trim() : '';

  syncSearchAdornments();

  if (!q) {
    exitSearchMode();
    return;
  }

  const key = `all:${q}`;
  if (!force && key === searchLastKey && searchState.active) return;
  searchLastKey = key;

  // 命中缓存：直接渲染，避免重复请求（限流是全站共享的 120 次/分钟）
  if (searchState.cache.has(key)) {
    const cached = searchState.cache.get(key);
    searchState.cache.delete(key);
    searchState.cache.set(key, cached);
    applySearchResult(key, cached);
    return;
  }

  searchState.active = true;
  searchState.isLoading = true;
  setToolbarStatus('搜索中…', true);
  renderSearchLoading();

  const seq = ++searchState.seq;
  try {
    const data = await fetchSearchResults({ q });
    if (seq !== searchState.seq) return;
    cacheSearchResult(key, data);
    applySearchResult(key, data);
  } catch (error) {
    if (seq !== searchState.seq) return;
    searchState.isLoading = false;
    if (error && error.code === 'RATE_LIMITED') {
      setToolbarStatus('请求过于频繁', false);
      showToast('请求过于频繁，请稍后再试');
    } else {
      setToolbarStatus('搜索失败', false);
      showToast('搜索失败');
      console.error(error);
    }
    if (!searchState.results) {
      exitSearchMode();
    }
  }
}

function scheduleSearch() {
  syncSearchAdornments();
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    performSearch();
  }, SEARCH_DEBOUNCE_MS);
}

async function loadMoreSearchResults() {
  if (searchState.isLoading || !searchState.hasMore) return;
  const results = searchState.results || [];
  if (results.length === 0) return;

  const oldest = results[results.length - 1].timestamp;
  if (!Number.isFinite(oldest)) return;

  searchState.isLoading = true;
  setToolbarStatus('加载中…', true);
  if (loadOlderBtn) loadOlderBtn.disabled = true;

  try {
    const data = await fetchSearchResults({
      q: searchState.q,
      before: oldest
    });
    const more = Array.isArray(data.messages) ? data.messages : [];
    const seen = new Set(results.map((m) => m.id));
    const appended = more.filter((m) => !seen.has(m.id));

    searchState.results = results.concat(appended);
    searchState.hasMore = Boolean(data.hasMore);

    renderTimelineList(searchState.results, messagesList, { forceExpand: true });

    setToolbarStatus(`找到 ${searchState.total} 条`, false);
  } catch (error) {
    if (error && error.code === 'RATE_LIMITED') {
      showToast('请求过于频繁，请稍后再试');
    } else {
      showToast('加载更多结果失败');
      console.error(error);
    }
    setToolbarStatus(`找到 ${searchState.total} 条`, false);
  } finally {
    searchState.isLoading = false;
    if (loadOlderBtn) loadOlderBtn.disabled = false;
    updateLoadOlderButton();
  }
}

if (searchInput) {
  searchInput.addEventListener('input', scheduleSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      performSearch({ force: true });
    }
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener('click', () => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    exitSearchMode();
  });
}

if (loadOlderBtn) loadOlderBtn.addEventListener('click', () => loadOlderMessages());

const imageObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        if (!img.src) {
          img.src = img.dataset.src;
        }
        imageObserver.unobserve(img);
      });
    }, { rootMargin: '200px' })
  : null;

let toastTimer = null;
function showToast(message, actionText = null, onAction = null) {
  if (toastTimer) clearTimeout(toastTimer);
  const toastText = document.getElementById('toast-text');
  const toastAction = document.getElementById('toast-action');

  if (toastText) {
    toastText.textContent = message;
  } else if (toastEl) {
    toastEl.textContent = message;
  }

  if (toastAction) {
    if (actionText && typeof onAction === 'function') {
      toastAction.textContent = actionText;
      toastAction.classList.remove('hidden');
      toastAction.onclick = () => {
        onAction();
        toastEl.classList.add('hidden');
      };
    } else {
      toastAction.classList.add('hidden');
      toastAction.onclick = null;
    }
  }

  if (toastEl) {
    toastEl.classList.remove('hidden');
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
      toastTimer = null;
    }, 2800);
  }
}

function flashButtonCopied(btn, originalHTML = null) {
  if (!btn) return;
  const isIconBtn = btn.classList.contains('card-icon-btn');
  const prevHTML = originalHTML !== null ? originalHTML : btn.innerHTML;
  btn.classList.add('btn-copied');
  if (isIconBtn) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  } else {
    btn.textContent = '✓ 已复制';
  }
  setTimeout(() => {
    btn.classList.remove('btn-copied');
    btn.innerHTML = prevHTML;
  }, 1400);
}

function getImageContent(content) {
  if (typeof content === 'string') {
    return { thumbnail: content, hasOriginal: false };
  }
  if (content && typeof content === 'object') {
    const thumbnail = typeof content.thumbnail === 'string' ? content.thumbnail : '';
    const original = typeof content.original === 'string' ? content.original : '';
    const hasOriginal = typeof content.hasOriginal === 'boolean'
      ? content.hasOriginal
      : Boolean(original && original !== thumbnail);
    return { thumbnail: thumbnail || original, original, hasOriginal };
  }
  return { thumbnail: '', hasOriginal: false };
}

function getFileContent(content) {
  if (!content || typeof content !== 'object') {
    return { name: '未知文件', size: 0, mimeType: '', url: '' };
  }
  return {
    name: typeof content.name === 'string' ? content.name : '未知文件',
    size: Number.isFinite(content.size) ? content.size : 0,
    mimeType: typeof content.mimeType === 'string' ? content.mimeType : '',
    url: typeof content.url === 'string' ? content.url : ''
  };
}

function setImageProcessing(active) {
  imageProcessingCount += active ? 1 : -1;
  imageProcessingCount = Math.max(imageProcessingCount, 0);

  const isProcessing = imageProcessingCount > 0;
  const imageProcessingState = document.getElementById('image-processing-state');
  if (!imageProcessingState) return;
  imageProcessingState.classList.toggle('hidden', !isProcessing);
  imageProcessingState.textContent = isProcessing
    ? `图片处理中${imageProcessingCount > 1 ? ` (${imageProcessingCount})` : ''}...`
    : '';
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderSmartText(text) {
  if (!text) return '';

  const placeholders = [];
  let html = escapeHTML(text);

  // 1. 提取 ``` 多行代码块并占位（极简无冗余头部，由卡片统一复制）
  html = html.replace(/```(\w*)\n([\s\S]*?)\n?```/g, (match, lang, code) => {
    const placeholder = `___CODE_BLOCK_PLACEHOLDER_${placeholders.length}___`;
    placeholders.push({
      placeholder,
      content: `<div class="code-block-wrapper"><pre class="code-block"><code>${code}</code></pre></div>`
    });
    return placeholder;
  });

  // 2. 提取 ` 行内代码并占位
  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const placeholder = `___INLINE_CODE_PLACEHOLDER_${placeholders.length}___`;
    placeholders.push({
      placeholder,
      content: `<code class="inline-code">${code}</code>`
    });
    return placeholder;
  });

  // 3. 智能渲染 URL 链接
  const urlRegex = /(\bhttps?:\/\/[^\s<]+[^.,?\s<])/gi;
  html = html.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener" class="message-link">${url}</a>`;
  });

  // 4. 将剩余文本的换行符 \n 替换为 <br>
  html = html.replace(/\n/g, '<br>');

  // 5. 将代码块和行内代码占位符还原回去
  for (const item of placeholders) {
    html = html.replace(item.placeholder, item.content);
  }

  return html;
}

window.copySnippetCode = async function(btn) {
  if (!btn) return;
  const wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  const codeEl = wrapper.querySelector('code');
  if (!codeEl) return;
  const text = codeEl.textContent || '';
  await copyTextToClipboard(text);
  flashButtonCopied(btn, '已复制');
};

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${
    date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }`;
}

function updateMessageCount() {
  messageCount.textContent = `${messages.length} 条消息`;
  clearAllBtn.disabled = messages.length === 0;
}

function updateExpireInfo(hours) {
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    expireInfo.textContent = `数据保留 ${days} 天`;
    return;
  }
  expireInfo.textContent = `数据保留 ${hours} 小时`;
}

function setTopLoading(visible) {
  topLoadingIndicator.classList.toggle('hidden', !visible);
}

function renderLoadingState() {
  messagesList.innerHTML = '<div class="messages-loading">正在加载消息...</div>';
  updateMessageCount();
}

function renderEmptyState() {
  const isMac = navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const copyHint = isMac ? '⌘C' : 'Ctrl+C';
  const pasteHint = isMac ? '⌘V' : 'Ctrl+V';
  messagesList.innerHTML = `
    <div class="empty-state messages-empty">
      <div class="empty-state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="2" width="8" height="4" rx="1"></rect>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
          <path d="M9 12h6"></path>
          <path d="M9 16h4"></path>
        </svg>
      </div>
      <p class="empty-state-title">剪贴板暂无内容</p>
      <div class="empty-state-shortcuts">
        <div class="empty-state-shortcut-row">
          <span>在任意处复制</span>
          <kbd class="inline-code">${copyHint}</kbd>
        </div>
        <div class="empty-state-shortcut-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="5 12 12 19 19 12"></polyline></svg>
        </div>
        <div class="empty-state-shortcut-row">
          <span>回到这里粘贴</span>
          <kbd class="inline-code">${pasteHint}</kbd>
        </div>
      </div>
    </div>
  `;
  updateMessageCount();
}

function observeImage(img) {
  if (!img.dataset.src) return;
  if (img.dataset.src.startsWith('data:')) {
    img.src = img.dataset.src;
    return;
  }
  if (imageObserver) {
    imageObserver.observe(img);
    return;
  }
  img.src = img.dataset.src;
}

function createImageContent(msg) {
  const imageContent = getImageContent(msg.content);
  const thumbnailUrl = imageContent.thumbnail;
  const wrapper = document.createElement('div');
  wrapper.className = 'message-content image';

  const placeholder = document.createElement('div');
  placeholder.className = 'image-placeholder';
  placeholder.textContent = '图片加载中…';

  const img = document.createElement('img');
  img.alt = '剪贴板图片';
  img.className = 'message-image loading';
  img.dataset.src = thumbnailUrl;
  img.loading = 'lazy';
  img.decoding = 'async';

  img.addEventListener('load', () => {
    img.classList.remove('loading');
    wrapper.classList.add('is-loaded');
    placeholder.classList.add('hidden');
  });

  img.addEventListener('error', () => {
    placeholder.textContent = '图片加载失败';
    img.classList.add('hidden');
  });

  wrapper.title = '点击预览大图';
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('aria-label', '预览图片');
  wrapper.tabIndex = 0;
  wrapper.addEventListener('click', () => openImageViewer(msg));
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openImageViewer(msg);
    }
  });

  wrapper.appendChild(placeholder);
  wrapper.appendChild(img);
  observeImage(img);
  return wrapper;
}

// 5 类内容的精致语义 SVG 小图标（用于弹窗顶栏左侧与文件摘要图标）
const PASTE_VARIANT_ICONS = {
  text: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 7V5h16v2"></path>
      <path d="M12 5v14"></path>
      <path d="M9 19h6"></path>
    </svg>
  `,
  code: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6"></polyline>
      <polyline points="8 6 2 12 8 18"></polyline>
      <line x1="14" y1="4" x2="10" y2="20"></line>
    </svg>
  `,
  link: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  `,
  image: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3.5" ry="3.5"></rect>
      <circle cx="8.5" cy="8.5" r="1.8" fill="currentColor"></circle>
      <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21"></path>
    </svg>
  `,
  file: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="8" y1="13" x2="16" y2="13"></line>
      <line x1="8" y1="17" x2="13" y2="17"></line>
    </svg>
  `
};

// Paste 官网原版风格：卡片右上角出血裁切式 (Bleed & Clipped) Apple 拟物应用大角标 SVG
const PASTE_CORNER_APP_GRAPHICS = {
  // 文本 (Text)：还原截图中的 Apple Notes 备忘录纸页（左侧圆角白底 + 顶部浅亮黄条 + 细密虚线撕页孔 + 两条灰色横线直抵边缘）
  text: `
    <svg viewBox="0 0 60 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g filter="url(#pasteCornerShadowText)">
        <path d="M18 0H60V50H10V8C10 3.58172 13.5817 0 18 0Z" fill="#FFFFFF"/>
        <path d="M18 0H60V10H10V8C10 3.58172 13.5817 0 18 0Z" fill="#FFE033"/>
        <line x1="10" y1="11.5" x2="60" y2="11.5" stroke="#E5E7EB" stroke-width="1.2" stroke-dasharray="1.5 2"/>
        <line x1="17" y1="24" x2="54" y2="24" stroke="#CBD5E1" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="17" y1="35" x2="54" y2="35" stroke="#CBD5E1" stroke-width="1.8" stroke-linecap="round"/>
      </g>
      <defs>
        <filter id="pasteCornerShadowText" x="4" y="-2" width="60" height="56" filterUnits="userSpaceOnUse">
          <feDropShadow dx="-2" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.12"/>
        </filter>
      </defs>
    </svg>
  `,
  // 代码 (Code)：还原截图第一排第 2 张的 Apple Xcode 蔚蓝锤子 (Xcode Hammer) 拟物角标
  code: `
    <svg viewBox="0 0 60 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g filter="url(#pasteCornerShadowCode)">
        <path d="M22 0H60V50H10V12C10 5.37258 15.3726 0 22 0Z" fill="url(#xcodeTileGrad)"/>
      </g>
      <line x1="16" y1="39" x2="54" y2="39" stroke="rgba(255,255,255,0.35)" stroke-width="1.5" stroke-dasharray="2 3"/>
      <g transform="rotate(-38 35 25)">
        <rect x="32.2" y="18" width="5.6" height="24" rx="2.5" fill="url(#xcodeHandleGrad)"/>
        <path d="M22 12.5C22 11.1 23.1 10 24.5 10H43.5C45.5 10 47 11.8 46.5 13.8L45.4 17.5H24.5C23.1 17.5 22 16.4 22 15V12.5Z" fill="url(#xcodeHeadGrad)"/>
      </g>
      <defs>
        <filter id="pasteCornerShadowCode" x="4" y="-2" width="60" height="56" filterUnits="userSpaceOnUse">
          <feDropShadow dx="-2" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.15"/>
        </filter>
        <linearGradient id="xcodeTileGrad" x1="35" y1="0" x2="35" y2="50" gradientUnits="userSpaceOnUse">
          <stop stop-color="#38B6FF"/>
          <stop offset="1" stop-color="#0062E3"/>
        </linearGradient>
        <linearGradient id="xcodeHandleGrad" x1="32" y1="18" x2="38" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="#64748B"/>
          <stop offset="1" stop-color="#1E293B"/>
        </linearGradient>
        <linearGradient id="xcodeHeadGrad" x1="22" y1="10" x2="47" y2="18" gradientUnits="userSpaceOnUse">
          <stop stop-color="#F8FAFC"/>
          <stop offset="1" stop-color="#94A3B8"/>
        </linearGradient>
      </defs>
    </svg>
  `,
  // 链接 (Link)：还原截图中的白底圆章 / Safari 气泡角标
  link: `
    <svg viewBox="0 0 60 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g filter="url(#pasteCornerShadowLink)">
        <path d="M22 0H60V50H8V14C8 6.26801 14.268 0 22 0Z" fill="#FFFFFF"/>
      </g>
      <circle cx="34" cy="25" r="20.5" fill="url(#safariDialGrad)"/>
      <circle cx="34" cy="25" r="17.8" stroke="rgba(255,255,255,0.55)" stroke-width="1.4" stroke-dasharray="1.2 2.5"/>
      <polygon points="34,25 30.8,21.8 46.2,12.8 37.2,28.2" fill="#FF3B30"/>
      <polygon points="34,25 37.2,28.2 21.8,37.2 30.8,21.8" fill="#FFFFFF"/>
      <circle cx="34" cy="25" r="1.8" fill="#E2E8F0"/>
      <defs>
        <filter id="pasteCornerShadowLink" x="2" y="-2" width="62" height="56" filterUnits="userSpaceOnUse">
          <feDropShadow dx="-2" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.14"/>
        </filter>
        <linearGradient id="safariDialGrad" x1="34" y1="4" x2="34" y2="46" gradientUnits="userSpaceOnUse">
          <stop stop-color="#35C0FF"/>
          <stop offset="1" stop-color="#0066F5"/>
        </linearGradient>
      </defs>
    </svg>
  `,
  // 图片 (Image)：还原截图第一排第 1、4 张的 Apple Photos 七彩相册花朵
  image: `
    <svg viewBox="0 0 60 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g filter="url(#pasteCornerShadowImg)">
        <path d="M22 0H60V50H10V12C10 5.37258 15.3726 0 22 0Z" fill="#FFFFFF"/>
      </g>
      <g opacity="0.9">
        <ellipse cx="35" cy="14.5" rx="5.2" ry="8.8" fill="#FF9500"/>
        <ellipse cx="35" cy="35.5" rx="5.2" ry="8.8" fill="#007AFF"/>
        <ellipse cx="24.5" cy="25" rx="8.8" ry="5.2" fill="#FF2D55"/>
        <ellipse cx="45.5" cy="25" rx="8.8" ry="5.2" fill="#34C759"/>
        <ellipse cx="42.4" cy="17.6" rx="5.2" ry="8.8" transform="rotate(45 42.4 17.6)" fill="#FFCC00"/>
        <ellipse cx="27.6" cy="32.4" rx="5.2" ry="8.8" transform="rotate(45 27.6 32.4)" fill="#5856D6"/>
        <ellipse cx="27.6" cy="17.6" rx="8.8" ry="5.2" transform="rotate(45 27.6 17.6)" fill="#FF3B30"/>
        <ellipse cx="42.4" cy="32.4" rx="8.8" ry="5.2" transform="rotate(45 42.4 32.4)" fill="#30D158"/>
      </g>
      <defs>
        <filter id="pasteCornerShadowImg" x="4" y="-2" width="60" height="56" filterUnits="userSpaceOnUse">
          <feDropShadow dx="-2" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.14"/>
        </filter>
      </defs>
    </svg>
  `,
  // 文件 (File)：还原截图第三排第 3 张的 macOS Finder 双色笑脸 (Finder Smiley) 拟物角标
  file: `
    <svg viewBox="0 0 60 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g filter="url(#pasteCornerShadowFile)">
        <path d="M22 0H60V50H10V12C10 5.37258 15.3726 0 22 0Z" fill="#E8F3FF"/>
        <path d="M22 0H36C33.5 14 33.5 28 36 50H10V12C10 5.37258 15.3726 0 22 0Z" fill="url(#finderLeftGrad)"/>
      </g>
      <rect x="24" y="15" width="3.2" height="7" rx="1.6" fill="#1E293B"/>
      <rect x="44" y="15" width="3.2" height="7" rx="1.6" fill="#1E293B"/>
      <path d="M35.5 15V26.5C35.5 28 34.5 28.8 32.8 28.8" stroke="#1E293B" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M23.5 34.5C28.5 39.8 41.5 39.8 46.5 34.5" stroke="#1E293B" stroke-width="2.6" stroke-linecap="round"/>
      <defs>
        <filter id="pasteCornerShadowFile" x="4" y="-2" width="60" height="56" filterUnits="userSpaceOnUse">
          <feDropShadow dx="-2" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.14"/>
        </filter>
        <linearGradient id="finderLeftGrad" x1="23" y1="0" x2="23" y2="50" gradientUnits="userSpaceOnUse">
          <stop stop-color="#38B6FF"/>
          <stop offset="1" stop-color="#0A84FF"/>
        </linearGradient>
      </defs>
    </svg>
  `
};

function detectPasteCardSpec(msg) {
  if (msg.type === 'image') {
    const imageData = getImageContent(msg.content);
    let fmt = 'IMG';
    const src = imageData.original || imageData.thumbnail || '';
    const m = src.match(/^data:image\/([a-zA-Z0-9+.-]+);/i) || src.match(/\.([a-zA-Z0-9]{3,4})(?:\?|$)/);
    if (m && m[1]) {
      fmt = m[1].toUpperCase().replace('JPEG', 'JPG');
    }
    return {
      variant: 'image',
      defaultTitle: '图片',
      metaText: imageData.hasOriginal ? `${fmt} · HD` : fmt,
      iconSvg: PASTE_VARIANT_ICONS.image
    };
  }

  if (msg.type === 'file') {
    const fileData = getFileContent(msg.content);
    const extMatch = (fileData.name || '').match(/\.([a-zA-Z0-9]{1,8})$/);
    const ext = extMatch ? extMatch[1].toUpperCase() : 'FILE';
    return {
      variant: 'file',
      defaultTitle: '文件',
      metaText: `${formatFileSize(fileData.size)} · ${ext}`,
      iconSvg: PASTE_VARIANT_ICONS.file
    };
  }

  const raw = String(msg.content || '').trim();
  const charCount = raw.length;
  const lineCount = raw ? raw.split('\n').length : 0;
  const isSingleUrl = /^https?:\/\/[^\s]+$/i.test(raw);
  const isCode = /```[\s\S]*```/.test(raw) || (lineCount >= 3 && /[{}();=]/.test(raw) && /^\s*(const|let|var|function|import|export|class|def|public|private|if|for|return|#include|<\w+)/m.test(raw));

  if (isSingleUrl) {
    let host = 'URL';
    try {
      host = new URL(raw).hostname.replace(/^www\./, '');
    } catch (e) {}
    return {
      variant: 'link',
      defaultTitle: '链接',
      metaText: host,
      iconSvg: PASTE_VARIANT_ICONS.link
    };
  }

  if (isCode) {
    return {
      variant: 'code',
      defaultTitle: '代码',
      metaText: `${charCount} chars · ${lineCount} lines`,
      iconSvg: PASTE_VARIANT_ICONS.code
    };
  }

  return {
    variant: 'text',
    defaultTitle: '文本',
    metaText: lineCount > 1 ? `${charCount} 字符 · ${lineCount} 行` : `${charCount} 字符`,
    iconSvg: PASTE_VARIANT_ICONS.text
  };
}

function bindMobileCardTaps(card, { isTouchDevice, copy, open, onError }) {
  if (!isTouchDevice()) return;

  const DOUBLE_TAP_MS = 320;
  const MAX_TAP_MOVEMENT = 18;
  let lastTapAt = 0;
  let lastTapTarget = null;
  let suppressClickUntil = 0;

  card.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('button, a, input, textarea, select, audio, video, .paste-card-title, .card-delete-wrapper')) return;
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;

    const now = performance.now();
    const isDoubleTap = now - lastTapAt <= DOUBLE_TAP_MS && target.closest('.message-content') === lastTapTarget;
    if (isDoubleTap) {
      lastTapAt = 0;
      lastTapTarget = null;
      suppressClickUntil = now + DOUBLE_TAP_MS;
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(open()).catch(onError);
      return;
    }

    lastTapAt = now;
    lastTapTarget = target.closest('.message-content');
    if (!lastTapTarget) lastTapTarget = card;
    window.setTimeout(() => {
      if (lastTapAt && performance.now() - lastTapAt >= DOUBLE_TAP_MS) {
        lastTapAt = 0;
        lastTapTarget = null;
        Promise.resolve(copy()).catch(onError);
      }
    }, DOUBLE_TAP_MS);
  }, { capture: true });

  card.addEventListener('click', (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('button, a, input, textarea, select, audio, video, .paste-card-title, .card-delete-wrapper')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
}

function createMessageElement(msg, isFavoritesView = false) {
  const spec = detectPasteCardSpec(msg);
  const messageEl = document.createElement('div');
  messageEl.className = `message paste-card variant-${spec.variant}`;
  if (msg.favorite) {
    messageEl.classList.add('favorited');
  }
  messageEl.dataset.id = msg.id;
  messageEl.dataset.variant = spec.variant;
  messageEl.dataset.defaultTitle = spec.defaultTitle;

  // Paste 极简顶部彩色栏：平时左侧留空（仅在用户设置自定义备注时显示标题），鼠标移入卡片时工具按钮在左侧浮现；右侧常驻 Apple 拟物应用大角标
  const headerEl = document.createElement('div');
  headerEl.className = 'message-header';

  const headerLeftEl = document.createElement('div');
  headerLeftEl.className = 'message-header-left';

  // 常驻类型名 + 时间（桌面端为顶部色带内双行；移动端叠加在卡片内容之上）
  const labelsEl = document.createElement('div');
  labelsEl.className = 'paste-card-labels';

  const typeLabelEl = document.createElement('span');
  typeLabelEl.className = 'paste-card-type-label';
  typeLabelEl.textContent = spec.defaultTitle;
  typeLabelEl.setAttribute('aria-hidden', 'true');
  labelsEl.appendChild(typeLabelEl);

  const headerTimeEl = document.createElement('span');
  headerTimeEl.className = 'paste-card-header-time';
  headerTimeEl.textContent = formatTime(msg.timestamp);
  labelsEl.appendChild(headerTimeEl);

  headerLeftEl.appendChild(labelsEl);

  const titleEl = document.createElement('span');
  titleEl.className = 'paste-card-title hidden';
  titleEl.textContent = msg.title || '';
  headerLeftEl.appendChild(titleEl);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'message-actions';

  // 收藏按钮（高对比纯白圆润微胶囊按钮，鼠标悬停时在顶部左侧工具区展示）
  const favoriteBtn = document.createElement('button');
  favoriteBtn.type = 'button';
  favoriteBtn.className = 'card-icon-btn card-secondary-action message-favorite-action';
  if (msg.favorite) favoriteBtn.classList.add('active');
  favoriteBtn.title = msg.favorite ? '取消收藏' : '加入收藏';
  favoriteBtn.setAttribute('aria-label', msg.favorite ? '取消收藏' : '加入收藏');
  favoriteBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="${msg.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
    </svg>
  `;
  favoriteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(msg.id, !msg.favorite);
  });
  actionsEl.appendChild(favoriteBtn);

  if (msg.sensitive && currentMode === 'accounts') {
    const sensitiveBtn = document.createElement('button'); sensitiveBtn.type = 'button'; sensitiveBtn.className = 'card-icon-btn card-secondary-action'; sensitiveBtn.title = '取消敏感标记'; sensitiveBtn.setAttribute('aria-label', sensitiveBtn.title); sensitiveBtn.textContent = 'S';
    sensitiveBtn.addEventListener('click', async e => { e.stopPropagation(); const credentials = await sensitiveCredentials('请输入密码以取消敏感标记'); if (!credentials) return; const r = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/sensitive/reauth`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'unmark', ...credentials }) }); if (!r.ok) { showToast('验证失败'); return; } const g = await r.json(); const u = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/sensitive/state`, { method:'POST', headers:{'Content-Type':'application/json','X-Sensitive-Grant':g.token}, body:JSON.stringify({ sensitive:false }) }); if (!u.ok) { showToast('取消敏感失败'); return; } refreshMessagesAfterReconnect(); });
    actionsEl.appendChild(sensitiveBtn);
  }

  // 删除按钮 + 简单的二次确认弹出按钮（按“收藏 · 复制 · 删除”顺序挂载在复制按钮之后）
  const deleteWrapperEl = document.createElement('div');
  deleteWrapperEl.className = 'card-delete-wrapper';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'card-icon-btn card-danger-action message-delete-action';
  deleteBtn.title = '删除记录';
  deleteBtn.setAttribute('aria-label', '删除记录');
  deleteBtn.setAttribute('aria-expanded', 'false');
  deleteBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  `;

  const deleteConfirmPop = document.createElement('div');
  deleteConfirmPop.className = 'card-delete-confirm-pop hidden';
  deleteConfirmPop.innerHTML = `
    <button type="button" class="card-delete-confirm-btn">确认删除</button>
  `;

  const confirmDeleteBtn = deleteConfirmPop.querySelector('.card-delete-confirm-btn');
  confirmDeleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteConfirmPop.classList.add('hidden');
    deleteBtn.setAttribute('aria-expanded', 'false');
    deleteMessage(msg.id);
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = deleteConfirmPop.classList.contains('hidden');
    document.querySelectorAll('.card-delete-confirm-pop:not(.hidden)').forEach((pop) => {
      if (pop !== deleteConfirmPop) {
        pop.classList.add('hidden');
        const prevBtn = pop.parentElement?.querySelector('.message-delete-action');
        if (prevBtn) prevBtn.setAttribute('aria-expanded', 'false');
      }
    });
    deleteConfirmPop.classList.toggle('hidden', !isHidden);
    deleteBtn.setAttribute('aria-expanded', String(isHidden));
  });

  messageEl.addEventListener('mouseleave', () => {
    if (!deleteConfirmPop.classList.contains('hidden')) {
      deleteConfirmPop.classList.add('hidden');
      deleteBtn.setAttribute('aria-expanded', 'false');
    }
  });

  deleteWrapperEl.appendChild(deleteBtn);
  deleteWrapperEl.appendChild(deleteConfirmPop);

  headerLeftEl.appendChild(actionsEl);
  headerEl.appendChild(headerLeftEl);

  const headerRightEl = document.createElement('div');
  headerRightEl.className = 'message-header-right';

  // 右上角 Apple 风格应用拟物角标（常驻展示在右上角，不再被悬停工具按钮遮挡）
  const cornerAppBadgeEl = document.createElement('div');
  cornerAppBadgeEl.className = 'paste-header-corner-app';
  cornerAppBadgeEl.setAttribute('aria-hidden', 'true');
  cornerAppBadgeEl.innerHTML = PASTE_CORNER_APP_GRAPHICS[spec.variant] || PASTE_CORNER_APP_GRAPHICS.text;
  headerRightEl.appendChild(cornerAppBadgeEl);

  // 底部常驻信息栏（展示字符数/尺寸/格式参数；时间已移至顶栏）
  const metaFooterEl = document.createElement('div');
  metaFooterEl.className = 'paste-card-meta';
  const metaTextSpan = document.createElement('span');
  metaTextSpan.className = 'paste-card-meta-text';
  metaTextSpan.textContent = spec.metaText;
  metaFooterEl.appendChild(metaTextSpan);

  // 底部常驻分组入口（点击打开分组选择弹窗）
  const titleEntryBtn = document.createElement('button');
  titleEntryBtn.type = 'button';
  titleEntryBtn.className = 'card-remark-entry card-title-entry' + (msg.title ? ' has-remark' : '');
  titleEntryBtn.title = msg.title ? `分组：${msg.title} · 点击修改` : '设置分组';
  titleEntryBtn.setAttribute('aria-label', msg.title ? '修改分组' : '设置分组');
  if (msg.title) {
    const { dot } = remarkToColor(msg.title);
    titleEntryBtn.innerHTML = `<span class="card-remark-entry-dot" style="background:${dot}"></span><span class="card-remark-entry-text">${escapeHTML(msg.title)}</span>`;
  } else {
    titleEntryBtn.innerHTML = '<span class="card-remark-entry-plus">#</span><span>分组</span>';
  }
  titleEntryBtn.addEventListener('click', (e) => { e.stopPropagation(); openTitleModal(msg); });
  metaFooterEl.appendChild(titleEntryBtn);

  // 底部常驻备注入口（淡显，最多显示 10 个字符，点击打开备注弹窗）
  const remarkEntryBtn = document.createElement('button');
  remarkEntryBtn.type = 'button';
  remarkEntryBtn.className = 'card-remark-entry' + (msg.remark ? ' has-remark' : '');
  remarkEntryBtn.title = msg.remark ? `备注：${msg.remark} · 点击修改` : '添加备注';
  remarkEntryBtn.setAttribute('aria-label', msg.remark ? '修改备注' : '添加备注');
  remarkEntryBtn.innerHTML = msg.remark
    ? `<span class="card-remark-entry-dot"></span><span class="card-remark-entry-text">${escapeHTML(formatCardRemarkPreview(msg.remark))}</span>`
    : '<span class="card-remark-entry-plus">+</span><span>备注</span>';
  remarkEntryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRemarkModal(msg);
  });
  metaFooterEl.appendChild(remarkEntryBtn);

  let primaryHeaderAction = null;

  if (msg.type === 'text') {
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content text is-collapsed';
    if (spec.variant === 'code') {
      const cleanCode = String(msg.content || '').replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      const HL = window.WBHighlight;
      contentEl.innerHTML = HL
        ? `<div class="code-block-wrapper"><pre class="code-block"><code>${HL.highlight(cleanCode, 'js')}</code></pre></div>`
        : renderSmartText(msg.content);
  } else if (spec.variant === 'link') {
    const rawUrl = String(msg.content || '').trim();
    let host = spec.metaText || 'URL';
    let pathTitle = rawUrl.replace(/^https?:\/\//i, '');
    try {
      const u = new URL(rawUrl);
      host = u.hostname.replace(/^www\./, '');
      const cleanPath = decodeURIComponent(u.pathname || '').replace(/^\/+|\/+$/g, '');
      pathTitle = cleanPath ? cleanPath.split('/').slice(-2).join(' / ') : host;
    } catch (e) {}

    contentEl.classList.add('is-link-card');
    contentEl.innerHTML = `
      <div class="paste-link-banner">
        <div class="paste-link-banner-orb"></div>
        <div class="paste-link-favicon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>
      </div>
      <div class="paste-link-footer">
        <div class="paste-link-title">${escapeHTML(pathTitle)}</div>
        <div class="paste-link-domain">${escapeHTML(rawUrl.replace(/^https?:\/\/(www\.)?/i, ''))}</div>
      </div>
    `;
  } else {
    contentEl.innerHTML = renderSmartText(msg.content);
  }
    contentEl.title = '点击弹出预览详情 · 点击顶部彩色条直接复制';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'card-icon-btn primary-copy';
    copyBtn.title = '复制内容';
    copyBtn.setAttribute('aria-label', '复制内容');
    copyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;

    primaryHeaderAction = async () => {
      if (msg.private && !isPrivateCardUnlocked(msg.id)) { openPrivateUnlockModal(msg.id); return; }
      await copyTextToClipboard(msg.content);
      flashButtonCopied(copyBtn, copyBtn.innerHTML);
      headerEl.classList.add('header-copied-flash');
      setTimeout(() => headerEl.classList.remove('header-copied-flash'), 600);
    };

    contentEl.addEventListener('click', (e) => {
      if (e.target.closest('a.message-link')) return;
      e.stopPropagation();
      openTextViewer(msg);
    });

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await primaryHeaderAction();
    });

    messageEl.appendChild(headerEl);
    messageEl.appendChild(contentEl);
    actionsEl.appendChild(copyBtn);
  } else if (msg.type === 'image') {
    const imageContent = createImageContent(msg);
    const imgEl = imageContent.querySelector('img');
    if (imgEl) {
      imgEl.addEventListener('load', () => {
        if (imgEl.naturalWidth && imgEl.naturalHeight) {
          metaTextSpan.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
        }
      });
    }
    messageEl.appendChild(headerEl);
    messageEl.appendChild(imageContent);

    // 保留无障碍与自动化测试兼容节点，视觉隐藏不占空间
    const previewBtn = document.createElement('button');
    previewBtn.className = 'sr-only message-preview-action';
    previewBtn.textContent = '预览图片';
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openImageViewer(msg);
    });
    actionsEl.appendChild(previewBtn);

    const imageData = getImageContent(msg.content);

    const copyImageBtn = document.createElement('button');
    copyImageBtn.type = 'button';
    copyImageBtn.className = 'card-icon-btn primary-copy';
    copyImageBtn.title = imageData.hasOriginal ? '复制原图' : '复制图片';
    copyImageBtn.setAttribute('aria-label', imageData.hasOriginal ? '复制原图' : '复制图片');
    copyImageBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;

    primaryHeaderAction = async () => {
      if (msg.private && !isPrivateCardUnlocked(msg.id)) { openPrivateUnlockModal(msg.id); return; }
      if (imageData.hasOriginal) {
        await copyOriginalImageWithFallback(msg);
        flashButtonCopied(copyImageBtn, copyImageBtn.innerHTML);
        headerEl.classList.add('header-copied-flash');
        setTimeout(() => headerEl.classList.remove('header-copied-flash'), 600);
      } else {
        const ok = await copyImageToClipboard(imageData.thumbnail, {
          successToast: '图片已复制到剪贴板',
          failureToast: '复制图片失败'
        });
        if (ok) {
          flashButtonCopied(copyImageBtn, copyImageBtn.innerHTML);
          headerEl.classList.add('header-copied-flash');
          setTimeout(() => headerEl.classList.remove('header-copied-flash'), 600);
        }
      }
    };

    copyImageBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await primaryHeaderAction();
    });
    actionsEl.appendChild(copyImageBtn);
  } else if (msg.type === 'file') {
    const fileData = getFileContent(msg.content);
    const extMatch = (fileData.name || '').match(/\.([a-zA-Z0-9]{1,6})$/);
    const extBadgeText = extMatch ? extMatch[1].toUpperCase() : 'FILE';
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content file';

    const docGraphicEl = document.createElement('div');
    docGraphicEl.className = 'paste-doc-sheet';
    docGraphicEl.innerHTML = `
      <svg viewBox="0 0 72 88" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M8 10C8 5.58172 11.5817 2 16 2H46L64 20V78C64 82.4183 60.4183 86 56 86H16C11.5817 86 8 82.4183 8 78V10Z" fill="#E4E7EC" stroke="#D0D5DD" stroke-width="1.5"/>
        <path d="M46 2L64 20H52C48.6863 20 46 17.3137 46 14V2Z" fill="#FAFAFA"/>
        <rect x="33" y="20" width="6" height="26" rx="1.5" fill="#98A2B3" opacity="0.45"/>
        <rect x="29" y="34" width="14" height="16" rx="3" fill="#98A2B3" opacity="0.65"/>
      </svg>
      <span class="paste-doc-ext">${escapeHTML(extBadgeText)}</span>
    `;
    contentEl.appendChild(docGraphicEl);

    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.textContent = fileData.name;
    contentEl.appendChild(nameEl);

    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }
    const mediaUrl = `/api/messages/${msg.id}/file-stream?${params.toString()}`;

    if (fileData.mimeType && fileData.mimeType.startsWith('audio/')) {
      const audioEl = document.createElement('audio');
      audioEl.src = mediaUrl;
      audioEl.controls = true;
      audioEl.className = 'message-audio';
      contentEl.appendChild(audioEl);
    }

    if (fileData.mimeType && fileData.mimeType.startsWith('video/')) {
      const videoEl = document.createElement('video');
      videoEl.src = mediaUrl;
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      videoEl.className = 'message-video';
      contentEl.appendChild(videoEl);
    }

    messageEl.appendChild(headerEl);
    messageEl.appendChild(contentEl);

    contentEl.classList.add('is-previewable');
    contentEl.title = '点击打开文件详情弹窗 · 点击顶部彩色条复制文件名';
    contentEl.addEventListener('click', (e) => {
      if (e.target.closest('audio, video')) return;
      e.stopPropagation();
      openFileViewer(msg);
    });

    const copyFileBtn = document.createElement('button');
    copyFileBtn.type = 'button';
    copyFileBtn.className = 'card-icon-btn primary-copy';
    copyFileBtn.title = '复制文件名';
    copyFileBtn.setAttribute('aria-label', '复制文件名');
    copyFileBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;

    primaryHeaderAction = async () => {
      await copyTextToClipboard(fileData.name || '');
      flashButtonCopied(copyFileBtn, copyFileBtn.innerHTML);
      headerEl.classList.add('header-copied-flash');
      setTimeout(() => headerEl.classList.remove('header-copied-flash'), 600);
    };

    copyFileBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await primaryHeaderAction();
    });
    actionsEl.appendChild(copyFileBtn);
  }

  // 隐私按钮
  const privateBtn = document.createElement('button');
  privateBtn.type = 'button';
  privateBtn.className = 'card-icon-btn card-secondary-action card-private-action';
  if (msg.private) privateBtn.classList.add('active');
  privateBtn.title = msg.private ? (isPrivateCardUnlocked(msg.id) ? '调整此卡片隐私解锁' : '解锁此卡片') : '设为隐私';
  privateBtn.setAttribute('aria-label', privateBtn.title);
  privateBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  `;
  privateBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (msg.private) {
      // 解除隐私：需要邮箱验证码
      openPrivateUnlockModal(msg.id);
    } else {
      // 打上隐私标记：无需验证，直接提交
      try {
        const r = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/private/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) { const d = await r.json(); showToast(d.code === 'MESSAGE_NOT_FOUND' ? '卡片不存在' : '操作失败'); }
      } catch { showToast('操作失败，请重试'); }
    }
  });
  actionsEl.appendChild(privateBtn);

  // 隐私状态遮罩（锁定且会话未解锁时才叠遮罩）
  if (msg.private && !isPrivateCardUnlocked(msg.id)) {
    messageEl.classList.add('is-private');
    const lockOverlay = document.createElement('button');
    lockOverlay.type = 'button';
    lockOverlay.className = 'private-lock-overlay';
    lockOverlay.setAttribute('aria-label', '解锁此隐私卡片');
    lockOverlay.title = '解锁此隐私卡片';
    lockOverlay.innerHTML = `
      <div class="private-lock-badge">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
    `;
    lockOverlay.addEventListener('click', (e) => {
      e.stopPropagation();
      openPrivateUnlockModal(msg.id);
    });
    messageEl.appendChild(lockOverlay);
  }

  // 顶部工具区严格只保留：收藏、复制、删除 三个按钮
  actionsEl.appendChild(deleteWrapperEl);

  // 点击卡片顶部彩色色带的非功能按钮区域，直接触发复制（含文本、图片、链接、代码、文件）
  // 移动端：单击内容区即复制（主力交互，无需找按钮）
  // 桌面端：双击卡片任意空白处即复制，单击内容区仍打开详情
  const isTouchDevice = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  if (isTouchDevice()) {
    messageEl.classList.add('touch-card');
  }

  headerEl.title = msg.type === 'image' ? '点击色带直接复制图片' : '点击色带直接复制内容';
  headerEl.addEventListener('click', async (e) => {
    if (e.target.closest('button, .card-delete-wrapper, .paste-card-title')) return;
    e.stopPropagation();
    if (msg.private && !isPrivateCardUnlocked(msg.id)) { openPrivateUnlockModal(msg.id); return; }
    if (primaryHeaderAction) await primaryHeaderAction();
  });

  // 桌面端维持原有双击复制；触屏双击由下方的连续 tap 识别，不依赖 dblclick。
  messageEl.addEventListener('dblclick', async (e) => {
    if (isTouchDevice() || e.pointerType === 'touch') return;
    if (e.target.closest('button, .card-delete-wrapper, .paste-card-title, a.message-link')) return;
    e.stopPropagation();
    e.preventDefault();
    if (msg.private && !isPrivateCardUnlocked(msg.id)) { openPrivateUnlockModal(msg.id); return; }
    if (primaryHeaderAction) await primaryHeaderAction();
  });

  bindMobileCardTaps(messageEl, {
    isTouchDevice,
    copy: () => {
      if (msg.private && !isPrivateCardUnlocked(msg.id)) return openPrivateUnlockModal(msg.id);
      if (msg.sensitive && currentMode === 'accounts') return openTextViewer(msg);
      return primaryHeaderAction?.();
    },
    open: () => {
      if (msg.private && !isPrivateCardUnlocked(msg.id)) return openPrivateUnlockModal(msg.id);
      if (msg.type === 'image') return openImageViewer(msg);
      if (msg.type === 'file') return openFileViewer(msg);
      return openTextViewer(msg);
    },
    onError: () => showToast('操作失败，请重试')
  });
  if (isTouchDevice()) {
    const content = messageEl.querySelector('.message-content');
    if (content) content.title = '单击复制 · 快速双击查看';
    headerEl.title = '单击复制 · 快速双击查看';
  }

  headerEl.appendChild(headerRightEl);

  messageEl.appendChild(metaFooterEl);
  if (msg.private && !isPrivateCardUnlocked(msg.id)) {
    messageEl.querySelectorAll('button:not(.private-lock-overlay):not(.card-private-action), a, input, textarea, select, audio[controls], video[controls], [tabindex]').forEach(control => {
      if ('disabled' in control) control.disabled = true;
      control.tabIndex = -1;
      control.setAttribute('aria-hidden', 'true');
    });
  }
  return messageEl;
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getTimelineDateInfo(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return { key: 'unknown', label: '', isToday: true };
  }
  const d = new Date(timestamp);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const msgDateStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const isToday = msgDateStart === todayStart;

  let label;
  if (isToday) {
    label = `今天 · ${m}月${day}日`;
  } else if (msgDateStart === yesterdayStart) {
    label = `昨天 · ${m}月${day}日`;
  } else if (now.getTime() - timestamp < 7 * 86400000) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    label = `${weekdays[d.getDay()]} · ${m}月${day}日`;
  } else if (y === now.getFullYear()) {
    label = `${m}月${day}日`;
  } else {
    label = `${y}年${m}月${day}日`;
  }

  return { key, label, isToday };
}

function renderTimelineList(items, container, { isFavoritesView = false, forceExpand = false } = {}) {
  // 按顶部 Pinboard 类型胶囊筛选（全部 / 文本 / 代码 / 链接 / 图片 / 文件）
  let filteredItems = currentTypeFilter === 'all'
    ? items
    : items.filter((msg) => detectPasteCardSpec(msg).variant === currentTypeFilter);

  // 按分类标题筛选
  if (currentCategoryFilter) {
    filteredItems = filteredItems.filter((msg) => (typeof msg.title === 'string' ? msg.title.trim() : '') === currentCategoryFilter);
  }

  if (filteredItems.length === 0) {
    const filterNames = { text: '文本', code: '代码', link: '链接', image: '图片', file: '文件' };
    const filterLabel = filterNames[currentTypeFilter] || '';
    const categoryLabel = currentCategoryFilter ? `「${escapeHTML(currentCategoryFilter)}」分类下` : '';
    container.innerHTML = `
      <div class="empty-state messages-empty">
        <p class="empty-state-title">${categoryLabel}当前没有${filterLabel}类型的记录</p>
        <p class="empty-state-desc">可点击上方「全部」或取消分类筛选查看所有剪贴板历史</p>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();
  // 时间线按从新到旧排序（最新的在最上方）
  const sorted = filteredItems.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const groups = [];
  let currentGroup = null;

  sorted.forEach((msg) => {
    const info = getTimelineDateInfo(msg.timestamp);
    if (!currentGroup || currentGroup.key !== info.key) {
      currentGroup = {
        key: info.key,
        label: info.label,
        isToday: info.isToday,
        items: []
      };
      groups.push(currentGroup);
    }
    currentGroup.items.push(msg);
  });

  const defaultHistoryCollapsed = isHistoryDefaultCollapsed();

  groups.forEach((group, groupIndex) => {
    // 最新的一组（如今天，或者没有今天数据时的第一组最近日期）在“默认展开”时展开；
    // 若配置为“历史日期默认折叠”，则非今天的历史日期组默认折叠
    let isCollapsed = false;
    if (!forceExpand) {
      if (userToggledDateGroups.has(group.key)) {
        isCollapsed = userToggledDateGroups.get(group.key);
      } else if (defaultHistoryCollapsed && !group.isToday && groupIndex > 0) {
        isCollapsed = true;
      } else if (defaultHistoryCollapsed && !group.isToday && groups.length > 1) {
        isCollapsed = true;
      }
    }

    const msgElements = group.items.map((msg) => {
      const el = createMessageElement(msg, isFavoritesView);
      el.dataset.dateGroup = group.key;
      if (isCollapsed) {
        el.classList.add('timeline-group-collapsed');
      }
      return el;
    });

    if (group.label) {
      const divider = document.createElement('div');
      divider.className = 'timeline-date-divider' + (isCollapsed ? ' is-collapsed' : '');
      divider.dataset.dateGroup = group.key;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'timeline-date-badge';
      btn.setAttribute('aria-expanded', String(!isCollapsed));
      btn.title = isCollapsed ? '点击展开该日期记录' : '点击折叠该日期记录';
      btn.innerHTML = `
        <svg class="timeline-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
        <span class="timeline-date-text">${group.label}</span>
        <span class="timeline-date-count">${group.items.length}</span>
      `;

      btn.addEventListener('click', () => {
        const nextCollapsed = !divider.classList.contains('is-collapsed');
        userToggledDateGroups.set(group.key, nextCollapsed);
        divider.classList.toggle('is-collapsed', nextCollapsed);
        btn.setAttribute('aria-expanded', String(!nextCollapsed));
        btn.title = nextCollapsed ? '点击展开该日期记录' : '点击折叠该日期记录';
        msgElements.forEach((el) => {
          el.classList.toggle('timeline-group-collapsed', nextCollapsed);
        });
      });

      divider.appendChild(btn);
      fragment.appendChild(divider);
    }

    msgElements.forEach((el) => fragment.appendChild(el));
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

function renderMessages({ scrollBottom = false } = {}) {
  // 搜索态下消息流由搜索结果接管，避免 socket 推送覆盖
  if (searchState.active) {
    return;
  }

  if (isInitialLoading && messages.length === 0) {
    renderLoadingState();
    return;
  }

  if (messages.length === 0) {
    renderEmptyState();
    return;
  }

  renderTimelineList(messages, messagesList);
  updateMessageCount();
  updateLoadOlderButton();
  renderCategoryChips();

  if (scrollBottom) {
    shouldStickToBottom = true;
    scrollToBottom();
  }
}

function removeSingleMessage(id) {
  // 从数据数组中移除
  messages = messages.filter((m) => m.id !== id);
  favorites = favorites.filter((f) => f.id !== id);

  try {
    if (currentMode !== 'accounts') localStorage.setItem('web-clipboard-cached-messages', JSON.stringify(messages.slice(0, 50)));
    if (currentMode !== 'accounts') localStorage.setItem('web-clipboard-cached-favorites', JSON.stringify(favorites));
  } catch (e) {}

  // 搜索态下同步从结果集中移除，并保持计数正确
  if (searchState.active && Array.isArray(searchState.results)) {
    searchState.results = searchState.results.filter((m) => m.id !== id);
    searchState.total = Math.max(0, searchState.total - 1);
  }

  const removeElement = (container, emptyHandler) => {
    if (!container) return;
    const msgEl = container.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
    if (msgEl) {
      msgEl.classList.add('deleting');
      setTimeout(() => {
        msgEl.remove();
        if (emptyHandler) emptyHandler();
      }, 200);
    } else if (emptyHandler) {
      emptyHandler();
    }
  };

  removeElement(messagesList, () => {
    if (searchState.active) {
      if ((searchState.results || []).length === 0) {
        renderSearchResults();
      } else {
        setToolbarStatus(`找到 ${searchState.total} 条`, false);
      }
      updateLoadOlderButton();
    } else {
      updateMessageCount();
      if (messages.length === 0) {
        renderEmptyState();
      }
    }
  });

  if (favoritesList) {
    removeElement(favoritesList, () => {
      if (currentTab === 'favorites' && favorites.length === 0) {
        renderFavorites();
      }
    });
  }
}

function appendSingleMessage(msg) {
  if (!messagesList) return;
  // 搜索态下新消息不进结果列表
  if (searchState.active) {
    return;
  }

  // 最新消息排在最上方：直接重绘时间线分组并回到顶部
  const info = getTimelineDateInfo(msg.timestamp);
  userToggledDateGroups.set(info.key, false);
  renderMessages({ scrollBottom: true });

  try {
    if (currentMode !== 'accounts') localStorage.setItem('web-clipboard-cached-messages', JSON.stringify(messages.slice(0, 50)));
  } catch (e) {}
}

function updateSingleMessageFavorite(id, favorite) {
  // 同步搜索态结果集
  if (searchState.active && Array.isArray(searchState.results)) {
    const sr = searchState.results.find((m) => m.id === id);
    if (sr) sr.favorite = favorite;
  }

  const updateElement = (container) => {
    if (!container) return;
    const msgEl = container.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
    if (msgEl) {
      if (favorite) {
        msgEl.classList.add('favorited');
      } else {
        msgEl.classList.remove('favorited');
      }
      const favBtn = msgEl.querySelector('.message-favorite-action');
      if (favBtn) {
        favBtn.classList.toggle('active', Boolean(favorite));
        favBtn.title = favorite ? '取消收藏' : '加入收藏';
        favBtn.setAttribute('aria-label', favorite ? '取消收藏' : '加入收藏');
        favBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        `;
      }
    }
  };

  updateElement(messagesList);
  if (currentTab === 'favorites') {
    renderFavorites();
  }
}

function formatCardRemarkPreview(remark) {
  const clean = typeof remark === 'string' ? remark.replace(/\s+/g, ' ').trim() : '';
  if (!clean) return '';
  const chars = Array.from(clean);
  return chars.length > 10 ? `${chars.slice(0, 10).join('')}...` : clean;
}

function updateSingleMessageRemark(id, remark) {
  const cleanRemark = typeof remark === 'string' ? remark : '';
  const msgInList = messages.find((m) => m.id === id);
  if (msgInList) msgInList.remark = cleanRemark;
  const favInList = favorites.find((f) => f.id === id);
  if (favInList) favInList.remark = cleanRemark;

  const updateElement = (container) => {
    if (!container) return;
    const msgEl = container.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
    if (!msgEl) return;

    // 同步底部备注入口按钮（不含 card-title-entry，最多显示 10 个字符）
    const entryBtns = msgEl.querySelectorAll('.card-remark-entry:not(.card-title-entry)');
    entryBtns.forEach(entryBtn => {
      entryBtn.classList.toggle('has-remark', Boolean(cleanRemark));
      entryBtn.title = cleanRemark ? `备注：${cleanRemark} · 点击修改` : '添加备注';
      entryBtn.setAttribute('aria-label', cleanRemark ? '修改备注' : '添加备注');
      entryBtn.innerHTML = cleanRemark
        ? `<span class="card-remark-entry-dot"></span><span class="card-remark-entry-text">${escapeHTML(formatCardRemarkPreview(cleanRemark))}</span>`
        : '<span class="card-remark-entry-plus">+</span><span>备注</span>';
    });
  };

  updateElement(messagesList);
  updateElement(favoritesList);
  syncActiveViewerRemark(id, cleanRemark);
}

function updateSingleMessageTitle(id, title) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const msgInList = messages.find((m) => m.id === id);
  if (msgInList) msgInList.title = cleanTitle || undefined;
  const favInList = favorites.find((f) => f.id === id);
  if (favInList) favInList.title = cleanTitle || undefined;

  const updateElement = (container) => {
    if (!container) return;
    const msgEl = container.querySelector(`.message[data-id="${CSS.escape(id)}"]`);
    if (!msgEl) return;

    const titleEl = msgEl.querySelector('.paste-card-title');
    if (titleEl) titleEl.textContent = cleanTitle;

    // 同步底部中间分组入口按钮（文案统一为“分组”）
    const titleEntryBtn = msgEl.querySelector('.card-title-entry');
    if (titleEntryBtn) {
      titleEntryBtn.classList.toggle('has-remark', Boolean(cleanTitle));
      titleEntryBtn.title = cleanTitle ? `分组：${cleanTitle} · 点击修改` : '设置分组';
      titleEntryBtn.setAttribute('aria-label', cleanTitle ? '修改分组' : '设置分组');
      titleEntryBtn.innerHTML = cleanTitle
        ? `<span class="card-remark-entry-dot" style="background:${remarkToColor(cleanTitle).dot}"></span><span class="card-remark-entry-text">${escapeHTML(cleanTitle)}</span>`
        : '<span class="card-remark-entry-plus">#</span><span>分组</span>';
    }
  };

  updateElement(messagesList);
  updateElement(favoritesList);
  renderCategoryChips();
}

function scrollToBottom() {
  const scrollTarget = workspaceScrollEl || messagesList;
  if (scrollTarget) {
    scrollTarget.scrollTop = 0;
  }
}

function checkAuth() {
  currentMode = 'pending';
  authBtn.disabled = true;
  // Session 模式只用 HttpOnly Cookie 恢复，不从浏览器存储读取密码。
  if (currentMode === 'accounts') {
    sessionFetch('/api/auth/me', accountRequestOptions({ credentials: 'same-origin', cache: 'no-store' })).then(async response => {
      if (!response.ok) throw new Error('login required');
      const data = await response.json(); accountUser = data.user; accountSessionId = data.sessionId || null; userId = data.user?.id || null; accountCsrfToken = data.csrfToken || null; enterChatMode();
    }).catch(() => { document.documentElement.classList.remove('preload-auth'); authSection.classList.remove('hidden'); chatSection.classList.add('hidden'); });
    return;
  }
  // 检查是否已超过设定的登录有效时长
  const expireTimeStr = localStorage.getItem('web-clipboard-login-expires');
  if (expireTimeStr) {
    const expireTime = parseInt(expireTimeStr, 10);
    if (!isNaN(expireTime) && Date.now() >= expireTime) {
      localStorage.removeItem('web-clipboard-password');
      localStorage.removeItem('web-clipboard-user-id');
      localStorage.removeItem('web-clipboard-login-expires');
      clearProxyAuthCookie();
    }
  }

  // 先检查运行模式和是否需要密码
  sessionFetch('/api/auth/status', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((data) => {
      if (!['accounts', 'single', 'multi'].includes(data.mode)) throw new Error('未知认证模式');
      currentMode = data.mode;
      authBtn.disabled = false;
      requirePassword = data.requirePassword;
      if (currentMode === 'accounts') {
        registrationAvailable = data.registration === true;
        configureAccountLogin();
        sessionFetch('/api/auth/me', accountRequestOptions({ credentials: 'same-origin', cache: 'no-store' })).then(async response => {
          if (!response.ok) throw new Error('login required');
          const me = await response.json(); accountUser = me.user; accountSessionId = me.sessionId || null; userId = me.user?.id || null; accountCsrfToken = me.csrfToken || null; enrollmentPending = Boolean(me.requiresFactorSetup); enrollmentOptional = Boolean(me.optionalFactorSetup); enterChatMode();
        }).catch(() => { document.documentElement.classList.remove('preload-auth'); authSection.classList.remove('hidden'); chatSection.classList.add('hidden'); });
        return;
      }

      // 无密码模式下隐藏退出按钮
      if (!requirePassword) {
        logoutBtn.style.display = 'none';
        // 无密码模式（单用户），直接进入
        enterChatMode();
        return;
      }

      // 有密码模式，检查本地缓存的 userId 和密码
      const savedUserId = localStorage.getItem('web-clipboard-user-id');
      const savedPassword = localStorage.getItem('web-clipboard-password');

      if (currentMode === 'multi' && savedUserId && savedPassword) {
        // 多用户模式：有缓存的 userId 和密码
        verifyPassword(savedPassword, savedUserId);
      } else if (savedPassword) {
        // 单用户模式：只有密码
        verifyPassword(savedPassword);
      }
    })
    .catch((error) => {
      console.error('获取认证状态失败:', error);
      // 认证模式未知时禁止使用旧密码回退，避免向 accounts 服务发送旧凭据。
      currentMode = 'pending'; authBtn.disabled = true;
      authError.textContent = '无法确认认证模式，请刷新后重试'; authError.classList.remove('hidden');
    });
}

function setRegistrationMode(enabled) {
  registrationMode = Boolean(enabled);
  document.getElementById('registration-fields')?.classList.toggle('hidden', !registrationMode);
  document.getElementById('registration-toggle')?.classList.toggle('hidden', !registrationAvailable);
  document.getElementById('registration-toggle').textContent = registrationMode ? '返回登录' : '注册';
  authBtn.textContent = registrationMode ? (registrationChallenge ? '确认邮箱并创建账户' : '发送验证码') : '登录';
  document.getElementById('username-label')?.classList.remove('hidden');
  document.getElementById('username-input')?.classList.remove('hidden');
  document.getElementById('password-help')?.classList.toggle('hidden', !registrationMode);
  document.getElementById('account-advanced')?.classList.add('hidden');
  document.getElementById('account-reset-btn')?.classList.add('hidden');
  document.getElementById('account-factor-fields')?.classList.add('hidden');
  if (!registrationMode) {
    registrationChallenge = null;
    document.getElementById('registration-code-fields')?.classList.add('hidden');
    document.getElementById('registration-code').value = '';
  } else {
    document.getElementById('registration-code-fields')?.classList.toggle('hidden', !registrationChallenge);
  }
}
function configureAccountLogin() {
  securityOpen?.classList.remove('hidden');
  if (accountUser?.role === 'admin') adminOpen?.classList.remove('hidden');
  const label = document.getElementById('username-label'); const input = document.getElementById('username-input');
  if (label) label.classList.remove('hidden'); if (input) input.classList.remove('hidden');
  const passwordLabel = document.querySelector('label[for="password-input"]'); if (passwordLabel) passwordLabel.textContent = '密码';
  document.getElementById('account-advanced')?.classList.add('hidden');
  document.getElementById('registration-toggle')?.classList.toggle('hidden', !registrationAvailable);
  document.getElementById('account-reset-btn')?.classList.add('hidden');
  document.querySelector('.login-duration-container')?.classList.add('hidden');
  for (const key of ['web-clipboard-password', 'web-clipboard-user-id', 'web-clipboard-login-expires', 'web-clipboard-cached-messages', 'web-clipboard-cached-favorites']) localStorage.removeItem(key);
  setRegistrationMode(false);
  clearProxyAuthCookie();
}
let enrollmentPending = false;
let enrollmentOptional = false;
let enrollmentChallenge = null;
let enrollmentGeneration = 0;
let enrollmentExplicit = false;
verificationField('verification-enroll').addEventListener('click', () => {
  beginSecurityAction('factor.replace');
});
async function enrollmentRequest(action, body = {}) {
  const response = await sessionFetch(`/api/auth/enrollment/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': accountCsrfToken || '' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error('绑定未完成，请检查验证码；二维码过期时请刷新页面重试');
  return data;
}
function clearEnrollment() {
  enrollmentGeneration += 1; enrollmentExplicit = false;
  document.getElementById('enrollment-status').textContent = '';
  document.getElementById('enrollment-submit').disabled = false;
  document.getElementById('enrollment-modal').classList.add('hidden');
  document.getElementById('enrollment-qr').removeAttribute('src');
  document.getElementById('enrollment-secret').textContent = '';
  document.getElementById('enrollment-codes').textContent = '';
  document.getElementById('enrollment-code').value = '';
  chatSection.inert = false;
  enrollmentChallenge = null;
}
async function showEnrollment() {
  const modal = document.getElementById('enrollment-modal');
  modal.classList.remove('hidden'); chatSection.inert = true;
  document.getElementById('enrollment-form').classList.remove('hidden');
  document.getElementById('enrollment-recovery').classList.add('hidden');
  document.getElementById('enrollment-skip').classList.toggle('hidden', !enrollmentOptional);
  const status = document.getElementById('enrollment-status'); status.textContent = '正在生成二维码…';
  const epoch = accountEpoch; const generation = ++enrollmentGeneration;
  try {
    const data = await enrollmentRequest('start'); if (epoch !== accountEpoch || generation !== enrollmentGeneration) return; enrollmentChallenge = data.challenge;
    const qr = document.getElementById('enrollment-qr'); qr.src = data.qrCode; qr.classList.remove('hidden');
    document.getElementById('enrollment-secret').textContent = data.secret;
    document.getElementById('enrollment-skip').textContent = enrollmentExplicit ? '取消绑定' : '稍后绑定';
    status.textContent = enrollmentOptional ? '可取消绑定，稍后在安全设置中继续。' : '请先完成绑定，保障账户安全。';
    document.getElementById('enrollment-code').focus();
  } catch (error) { if (epoch === accountEpoch && generation === enrollmentGeneration) status.textContent = error.message; }
}
document.getElementById('enrollment-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = document.getElementById('enrollment-submit'); button.disabled = true;
  const epoch = accountEpoch; const generation = enrollmentGeneration;
  try {
    const data = await enrollmentRequest('confirm', { challenge: enrollmentChallenge, code: document.getElementById('enrollment-code').value.trim() });
    if (epoch !== accountEpoch || generation !== enrollmentGeneration) return;
    enrollmentPending = false; document.getElementById('enrollment-code').value = '';
    document.getElementById('enrollment-form').classList.add('hidden');
    document.getElementById('enrollment-qr').removeAttribute('src'); document.getElementById('enrollment-qr').classList.add('hidden');
    document.getElementById('enrollment-secret').textContent = '';
    document.getElementById('enrollment-codes').textContent = data.recoveryCodes.join('\n');
    document.getElementById('enrollment-recovery').classList.remove('hidden');
    document.getElementById('enrollment-done').focus();
  } catch (error) { if (epoch === accountEpoch && generation === enrollmentGeneration) document.getElementById('enrollment-status').textContent = error.message; }
  finally { if (epoch === accountEpoch && generation === enrollmentGeneration) button.disabled = false; }
});
document.getElementById('enrollment-skip').addEventListener('click', async () => {
  const epoch = accountEpoch; const generation = enrollmentGeneration;
  try {
    if (enrollmentExplicit) { enrollmentPending = false; clearEnrollment(); if (securityModal && !securityModal.classList.contains('hidden')) loadVerificationSettings().catch(() => {}); return; }
    await enrollmentRequest('skip'); if (epoch !== accountEpoch || generation !== enrollmentGeneration) return; enrollmentPending = false; clearEnrollment(); enterChatMode();
  } catch (error) { if (epoch === accountEpoch && generation === enrollmentGeneration) document.getElementById('enrollment-status').textContent = error.message; }
});
document.getElementById('enrollment-done').addEventListener('click', () => { clearEnrollment(); enterChatMode(); });
function enterChatMode() {
  // URL 只表示当前界面；是否登录始终由现有认证流程判断。
  if (location.pathname !== '/app') history.replaceState(null, '', '/app');
  isAuthenticated = true;
  adminOpen?.classList.toggle('hidden', currentMode !== 'accounts' || accountUser?.role !== 'admin');
  securityOpen?.classList.toggle('hidden', currentMode !== 'accounts');

  // 更新顶栏用户头像
  const topbarUserAvatar = document.getElementById('topbar-user-avatar');
  if (topbarUserAvatar && accountUser) {
    const storedAvatar = getStoredAvatar();
    applyAvatarToUI(storedAvatar);
  } else if (topbarUserAvatar) {
    topbarUserAvatar.textContent = 'U';
  }

  authSection.classList.add('hidden');
  chatSection.classList.remove('hidden');
  if (enrollmentPending) { showEnrollment(); return; }
  loadGroups();

  // 重置搜索状态与工具条，确保以完整消息流开始
  searchState.active = false;
  searchState.results = null;
  searchState.hasMore = false;
  searchState.total = 0;
  searchState.isLoading = false;
  searchState.cache.clear();
  searchState.seq += 1;
  searchLastKey = '';
  if (searchInput) searchInput.value = '';
  if (searchClearBtn) searchClearBtn.classList.add('hidden');
  setToolbarStatus('', false);

  // 多用户模式下显示当前用户
  if (currentMode === 'multi' && userId) {
    currentUserEl.textContent = `👤 ${userId}`;
    currentUserEl.classList.remove('hidden');
  }

  // 延迟启动 Socket 握手连接并加入房间
  socket.connect();
  if (currentMode === 'multi' && userId) {
    socket.emit('join', userId);
  }

  loadInitialMessages();
  loadFavorites();
  // /api/version 受 auth_request 保护，必须在登录成功后再取，否则稳定 401
  loadVersion();

  // 启动登录有效时长定时检测
  if (expireCheckInterval) clearInterval(expireCheckInterval);
  expireCheckInterval = setInterval(checkLoginExpiration, 1000);
}

function checkLoginExpiration() {
  const expireTimeStr = localStorage.getItem('web-clipboard-login-expires');
  if (!expireTimeStr) return;
  const expireTime = parseInt(expireTimeStr, 10);
  if (isNaN(expireTime)) return;

  if (Date.now() >= expireTime) {
    showToast('登录已过期，自动退出登录');
    logout(false);
  }
}

async function loadVersion() {
  try {
    const response = await sessionFetch('/api/version', { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json();
    const versionEl = document.getElementById('version');
    if (versionEl && data.version) {
      versionEl.textContent = `v${data.version}`;
    }
  } catch (error) {
    console.error('加载版本号失败:', error);
  }
}

function switchTab(tabName) {
  currentTab = tabName;
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
  });
  if (tabName === 'favorites') {
    renderFavorites();
  } else if (tabName === 'shares') {
    renderShares();
  }
}

function renderShares() {
  if (!sharesList) return;
  if (shares.length === 0) {
    sharesList.innerHTML = `
      <div class="empty-state">
        <p>暂无他人共享内容</p>
        <p style="font-size: 0.8rem; margin-top: 8px;">其他成员定向共享给您的剪贴内容将显示在此处</p>
      </div>
    `;
    return;
  }
  const fragment = document.createDocumentFragment();
  shares.forEach((msg) => {
    fragment.appendChild(createMessageElement(msg));
  });
  sharesList.innerHTML = '';
  sharesList.appendChild(fragment);
}

async function loadFavorites() {
  const requestEpoch = accountEpoch;
  // SWR: 优先从本地缓存渲染收藏，提升秒开体验
  try {
    const cachedFav = (currentMode === 'accounts' ? null : localStorage.getItem('web-clipboard-cached-favorites'));
    if (cachedFav && favorites.length === 0) {
      const parsed = JSON.parse(cachedFav);
      if (Array.isArray(parsed) && parsed.length > 0) {
        favorites = parsed;
        updateFavoritesBadge();
        if (currentTab === 'favorites') {
          renderFavorites();
        }
      }
    }
  } catch (e) {}

  try {
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }
    const response = await authFetch(`/api/favorites?${params.toString()}`);
    if (!response.ok) return;
    const data = await response.json();
    if (requestEpoch !== accountEpoch) return;
    favorites = data.messages || [];
    updateFavoritesBadge();
    if (currentTab === 'favorites') {
      renderFavorites();
    }
    try {
      if (currentMode !== 'accounts') localStorage.setItem('web-clipboard-cached-favorites', JSON.stringify(favorites));
    } catch (e) {}
  } catch (error) {
    console.error('加载收藏失败:', error);
  }
}

async function toggleFavorite(id, isFavorite) {
  try {
    const method = isFavorite ? 'POST' : 'DELETE';
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }
    await authFetch(`/api/messages/${id}/favorite?${params.toString()}`, { method });
  } catch (error) {
    showToast('收藏操作失败');
    console.error(error);
  }
}

function updateFavoritesBadge() {
  if (!favoritesBadge) return;
  const count = favorites.length;
  if (count > 0) {
    favoritesBadge.textContent = String(count);
    favoritesBadge.classList.remove('hidden');
  } else {
    favoritesBadge.classList.add('hidden');
  }
}

function renderFavorites() {
  updateFavoritesBadge();
  if (favorites.length === 0) {
    favoritesList.innerHTML = `
      <div class="empty-state">
        <p>暂无收藏</p>
        <p style="font-size: 0.8rem; margin-top: 8px;">点击消息旁的 ☆ 收藏重要内容</p>
      </div>
    `;
    return;
  }

  renderTimelineList(favorites, favoritesList, { isFavoritesView: true });
}

// 反向代理认证 Cookie：nginx 的 add_header 中 $cookie_* 在同一次响应内不可见，
// 因此由前端在登录成功后写入；值 = base64(访问密码)，仅服务端可校验。
function setProxyAuthCookie(password) {
  try {
    const value = btoa(unescape(encodeURIComponent(password)));
    document.cookie = `wc_auth=${value}; Path=/; Max-Age=2592000; Secure; SameSite=Lax`;
  } catch (e) {
    console.error(e);
  }
}

function clearProxyAuthCookie() {
  document.cookie = 'wc_auth=; Path=/; Max-Age=0; Secure; SameSite=Lax';
}

async function logout(showMessage = true, revokeSession = true, fromOtherTab = false, preserveSelfSecurityOp = false) {
  clearSensitiveViewerState();
  clearPrivateUnlockState();
  clearVerificationSecrets(); verificationSettings = null; securityEmailChallenge = null;
  if (!preserveSelfSecurityOp) cancelSelfSecurityDelivery();
  if (currentMode === 'accounts' && revokeSession) {
    const logoutEpoch = accountEpoch;
    try {
      const response = await sessionFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': accountCsrfToken || '' }, body: '{}' });
      if (logoutEpoch !== accountEpoch) return;
      if (!response.ok && response.status !== 401) throw new Error('logout failed');
    } catch { showToast('退出失败，会话可能仍有效，请重试'); return; }
  }
  if (location.pathname === '/app') history.replaceState(null, '', '/login');
  const selfSecurityOp = preserveSelfSecurityOp ? pendingSelfSecurityOp : null;
  accountEpoch += 1;
  accountAbortController?.abort(); accountAbortController = null;
  if (currentXhr) currentXhr.abort(); uploadQueue = []; isUploading = false;
  if (textInput) textInput.value = '';
  resetAccountLogin(Boolean(selfSecurityOp));
  if (currentMode === 'accounts' && !fromOtherTab) accountLogoutChannel?.postMessage({ type: 'logout' });
  socket.disconnect();
  clearProxyAuthCookie();
  localStorage.removeItem('web-clipboard-password');
  localStorage.removeItem('web-clipboard-user-id');
  accountChallenge = null; accountCsrfToken = null; accountUser = null; accountSessionId = null; accountRevalidation = null;
  if (selfSecurityOp) selfSecurityOp.revokedEpoch = accountEpoch; else if (!preserveSelfSecurityOp) pendingSelfSecurityOp = null;
  localStorage.removeItem('web-clipboard-login-expires');
  try {
    localStorage.removeItem('web-clipboard-cached-messages');
    localStorage.removeItem('web-clipboard-cached-favorites');
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PRIVATE_CACHE' });
  } catch (e) {}

  if (expireCheckInterval) {
    clearInterval(expireCheckInterval);
    expireCheckInterval = null;
  }

  userId = null;
  isAuthenticated = false;
  messages = [];
  favorites = [];
  clearPrivateUnlockState();
  updateFavoritesBadge();
  hasMoreMessages = false;
  initialLoaded = false;
  isInitialLoading = false;
  isLoadingOlder = false;
  isReconnectRefreshing = false;
  setTopLoading(false);
  shouldStickToBottom = false;

  // 关闭查看器并重置搜索状态，避免退出后残留私有内容
  closeAdminSettings(); adminOpen?.classList.add('hidden');
  closeSecuritySettings(Boolean(selfSecurityOp));
  if (typeof closeImageViewer === 'function') closeImageViewer();
  if (typeof closeFileViewer === 'function') closeFileViewer();
  if (typeof closeTextViewer === 'function') closeTextViewer();
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  searchState.active = false;
  searchState.results = null;
  searchState.hasMore = false;
  searchState.total = 0;
  searchState.isLoading = false;
  searchState.cache.clear();
  searchState.seq += 1;
  searchLastKey = '';
  if (searchInput) searchInput.value = '';
  if (searchClearBtn) searchClearBtn.classList.add('hidden');
  setToolbarStatus('', false);
  if (loadOlderBtn) loadOlderBtn.classList.add('hidden');

  // 重置到消息tab
  switchTab('messages');

  if (requirePassword) {
    document.documentElement.classList.remove('preload-auth');
    authSection.classList.remove('hidden');
    chatSection.classList.add('hidden');
    authError.classList.add('hidden');
    passwordInput.value = '';
    passwordInput.focus();
  } else {
    // 无密码模式，直接重新进入
    enterChatMode();
  }

  renderEmptyState();
  if (showMessage && requirePassword) {
    showToast('已退出登录');
  }
}

async function fetchMessagesPage({ before, limit = PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (Number.isFinite(before)) {
    params.set('before', String(before));
  }

  // 多用户模式下添加 userId 参数
  if (currentMode === 'multi' && userId) {
    params.set('userId', userId);
  }

  const response = await authFetch(`/api/messages?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to load messages: ${response.status}`);
  }
  return response.json();
}

async function loadInitialMessages() {
  const requestEpoch = accountEpoch;
  // SWR: 优先从本地缓存渲染消息，实现刷新零延迟秒开
  try {
    const cachedMsgStr = (currentMode === 'accounts' ? null : localStorage.getItem('web-clipboard-cached-messages'));
    if (cachedMsgStr && messages.length === 0) {
      const parsed = JSON.parse(cachedMsgStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        messages = parsed;
        renderMessages({ scrollBottom: true });
      }
    }
  } catch (e) {}

  isInitialLoading = messages.length === 0;
  if (isInitialLoading) {
    renderMessages();
  }

  try {
    const data = await fetchMessagesPage({ limit: PAGE_SIZE });
    if (requestEpoch !== accountEpoch) return;
    messages = data.messages || [];
    hasMoreMessages = Boolean(data.hasMore);
    updateExpireInfo(data.expireHours || 168);
    initialLoaded = true;
    isInitialLoading = false;
    renderMessages({ scrollBottom: true });

    // 同步到本地快照缓存
    try {
      if (currentMode !== 'accounts') localStorage.setItem('web-clipboard-cached-messages', JSON.stringify(messages.slice(0, 50)));
    } catch (e) {}
  } catch (error) {
    isInitialLoading = false;
    renderMessages();
    showToast('加载消息失败');
    console.error(error);
  }
}

async function refreshMessagesAfterReconnect() {
  const requestEpoch = accountEpoch;
  if (!initialLoaded || isInitialLoading || isReconnectRefreshing) {
    return;
  }

  isReconnectRefreshing = true;
  try {
    const data = await fetchMessagesPage({ limit: PAGE_SIZE });
    if (requestEpoch !== accountEpoch || !Array.isArray(data.messages)) return;
    messages = data.messages;
    hasMoreMessages = Boolean(data.hasMore);
    updateExpireInfo(data.expireHours || 168);
    renderMessages({ scrollBottom: true });
  } catch (error) {
    showToast('重连后刷新失败');
    console.error(error);
  } finally {
    isReconnectRefreshing = false;
  }
}

async function loadOlderMessages() {
  const requestEpoch = accountEpoch;
  // 搜索态下"加载更早消息"改为加载更多搜索结果
  if (searchState.active) {
    return loadMoreSearchResults();
  }

  if (!hasMoreMessages || isLoadingOlder || isInitialLoading || messages.length === 0) {
    return;
  }

  const oldestTimestamp = messages[0].timestamp;
  if (!Number.isFinite(oldestTimestamp)) {
    return;
  }

  isLoadingOlder = true;
  setTopLoading(true);
  if (loadOlderBtn) loadOlderBtn.disabled = true;

  try {
    const data = await fetchMessagesPage({
      before: oldestTimestamp,
      limit: PAGE_SIZE
    });

    if (requestEpoch !== accountEpoch) return;
    const olderMessages = data.messages || [];
    if (olderMessages.length > 0) {
      messages = olderMessages.concat(messages);
      // 网格卡片布局下不再做滚动位置补偿，改为显式按钮触发
      renderMessages();
    }
    hasMoreMessages = Boolean(data.hasMore);
  } catch (error) {
    showToast('加载更早消息失败');
    console.error(error);
  } finally {
    isLoadingOlder = false;
    setTopLoading(false);
    if (loadOlderBtn) loadOlderBtn.disabled = false;
    updateLoadOlderButton();
  }
}

function accountIdentifierPayload(identifier) {
  return { email: identifier };
}
function showAccountFactorStep({ requirePassword = false, requireFactor = true, email = false, recovery = false } = {}) {
  document.getElementById('account-factor-fields').classList.remove('hidden');
  document.getElementById('account-reset-btn').classList.remove('hidden');
  document.getElementById('account-advanced').classList.toggle('hidden', !recovery);
  for (const id of ['username-input', 'password-input']) document.getElementById(id).disabled = true;
  verificationField('account-code').classList.toggle('hidden', !requireFactor);
  verificationField('account-code-label').classList.toggle('hidden', !requireFactor);
  verificationField('account-code').required = requireFactor;
  verificationField('account-code-label').textContent = email ? '邮箱验证码' : '动态验证码';
  verificationField('account-code').placeholder = email ? '六位邮箱验证码' : '六位动态验证码';
  verificationField('account-new-password').classList.toggle('hidden', !requirePassword);
  document.querySelector('label[for="account-new-password"]').classList.toggle('hidden', !requirePassword);
  verificationField('account-new-password').required = requirePassword;
  authBtn.textContent = '完成验证';
  (requirePassword ? verificationField('account-new-password') : verificationField('account-code')).focus();
}
function resetAccountLogin(preserveSelfSecurityOp = false) {
  if (preserveSelfSecurityOp !== true) cancelSelfSecurityDelivery();
  clearEnrollment(); enrollmentPending = false;
  accountEpoch += 1; accountStage = 'login'; accountChallenge = null;
  setRegistrationMode(false);
  for (const id of ['username-input', 'password-input', 'registration-code']) document.getElementById(id).disabled = false;
  document.getElementById('registration-code').value = '';
  document.getElementById('account-advanced').open = false;
  passwordInput.autocomplete = 'current-password';
  passwordInput.placeholder = '输入密码';
  authBtn.disabled = false;
  verificationField('account-code').required = false; verificationField('account-new-password').required = false;
  for (const id of ['account-code', 'account-new-password', 'account-recovery-code']) { const el = document.getElementById(id); if (el) el.value = ''; }
  for (const id of ['account-setup-secret', 'account-recovery-result']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
  document.getElementById('account-factor-fields')?.classList.add('hidden'); passwordInput.value = ''; authError.classList.add('hidden');
}
document.getElementById('account-reset-btn')?.addEventListener('click', resetAccountLogin);
document.getElementById('account-recovery-btn')?.addEventListener('click', async () => {
  const epoch = accountEpoch;
  if (currentMode !== 'accounts') return;
  const identifier = document.getElementById('username-input').value.trim();
  try {
    const response = await sessionFetch('/api/auth/recovery/start', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...accountIdentifierPayload(identifier), password: passwordInput.value, recoveryCode: document.getElementById('account-recovery-code').value.trim() }) });
    const data = await response.json(); if (epoch !== accountEpoch) return; if (!response.ok) throw new Error(data.error || '恢复失败');
    document.getElementById('account-recovery-code').value = '';
    accountStage = 'setup'; accountChallenge = data.challenge;
    const staged = await sessionFetch('/api/auth/setup/start', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: accountChallenge }) });
    const details = await staged.json(); if (!staged.ok) throw new Error(details.error || '恢复初始化失败');
    if (epoch !== accountEpoch) return;
    accountChallenge = details.challenge; showAccountFactorStep({ requirePassword: true }); document.getElementById('account-setup-secret').textContent = `请设置新密码并在认证器添加密钥：${details.secret}`;
  } catch (error) { if (epoch === accountEpoch && error.name !== 'AbortError') { authError.textContent = error.message; authError.classList.remove('hidden'); } }
});
// Admin operations use an immutable request snapshot and a separate modal generation.
function adminContext() { return { epoch: accountEpoch, generation: adminGeneration, actorId: accountUser?.id }; }
function adminCurrent(context) { return isAuthenticated && currentMode === 'accounts' && accountUser?.role === 'admin' && context.actorId === accountUser.id && context.epoch === accountEpoch && context.generation === adminGeneration; }
function clearAdminOperation() {
  adminGeneration += 1; adminPending = null;
  document.getElementById('admin-authorize').disabled = false;
  for (const id of ['admin-actor-password', 'admin-actor-code', 'admin-target-password', 'admin-username', 'admin-display-name']) document.getElementById(id).value = '';
  adminEditor.classList.add('hidden'); adminConfirmation.classList.add('hidden'); adminSummary.textContent = ''; document.getElementById('admin-target').textContent = '';
}
function closeAdminSettings() { clearAdminOperation(); adminModal.classList.add('hidden'); adminUsers.textContent = ''; adminStatus.textContent = ''; }
function adminError(error) {
  const messages = { LAST_ADMIN: '必须保留至少一位有效管理员', TARGET_CHANGED: '目标账户已变化，请刷新后重新验证', USER_CONFLICT: '用户名已存在，请重新填写', ADMIN_FACTOR_REQUIRED: '需要管理员的正式动态验证码会话', AUTH_RATE_LIMIT: '验证过于频繁，请稍后重试', AUTH_BUSY: '验证服务繁忙，请稍后重试', PASSWORD_POLICY: '密码不符合要求', AUTH_FAILED: '管理员密码或验证码无效', GRANT_REJECTED: '操作授权失效，请重新验证' };
  return messages[error.message] || '操作失败，请刷新后重试';
}
async function adminRequest(path, options = {}) {
  const context = adminContext();
  const headers = { ...options.headers };
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) headers['X-CSRF-Token'] = accountCsrfToken || '';
  const response = await sessionFetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers });
  const data = await response.json();
  if (response.status === 401 && adminCurrent(context)) {
    // Wrong reauthentication factors and expired grants also use 401.
    // Only clear the account if the authenticated session itself is invalid.
    const me = await sessionFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (adminCurrent(context) && me.status === 401) await logout(false, false);
  }
  if (!response.ok) throw new Error(data.code || 'ADMIN_REQUEST_FAILED');
  return data;
}
async function loadAdminUsers(before = null) {
  const context = adminContext(); if (!adminCurrent(context)) return;
  try {
    const data = await adminRequest(`/api/admin/users?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (!adminCurrent(context)) return;
    adminUsers.textContent = '';
    for (const user of data.users || []) {
      const row = document.createElement('div'); row.className = 'popover-meta-item';
      row.textContent = `${user.username} · ${user.displayName || user.display_name || ''} · ${user.role} · ${(user.disabledAt ?? user.disabled_at) != null ? '已禁用' : '有效'}`;
      for (const [label, action] of [['禁用/启用', 'admin.user.disable'], ['修改角色', 'admin.user.role'], ['重置密码', 'admin.user.reset-password']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = label;
        button.addEventListener('click', () => beginAdminAction(action, user)); row.appendChild(button);
      }
      adminUsers.appendChild(row);
    }
    const more = document.getElementById('admin-more'); more.classList.toggle('hidden', (data.users || []).length < 50);
    const lastId = data.users?.at(-1)?.id; more.onclick = () => { if (adminCurrent(context)) loadAdminUsers(lastId); };
    adminStatus.textContent = data.users?.length ? '选择账户操作，每次操作需重新验证管理员身份' : '没有更多账户';
  } catch (error) { if (adminCurrent(context) && error.name !== 'AbortError') adminStatus.textContent = adminError(error); }
}
function beginAdminAction(action, user = null) {
  clearAdminOperation();
  if (currentMode !== 'accounts' || accountUser?.role !== 'admin') return;
  const target = user ? { id: user.id, username: user.username, disabled: (user.disabledAt ?? user.disabled_at) != null } : null;
  adminPending = { action, target };
  document.getElementById('admin-target').textContent = target ? `目标账户：${target.username} (${target.id})${action === 'admin.user.disable' ? (target.disabled ? '，将启用' : '，将禁用') : ''}` : '注册：首次登录必须更改密码';
  document.getElementById('admin-create-fields').classList.toggle('hidden', action !== 'admin.user.create');
  document.getElementById('admin-role-field').classList.toggle('hidden', !['admin.user.create', 'admin.user.role'].includes(action));
  document.getElementById('admin-target-password-field').classList.toggle('hidden', !['admin.user.create', 'admin.user.reset-password'].includes(action));
  document.getElementById('admin-role').value = user?.role || 'user';
  adminEditor.classList.remove('hidden'); adminStatus.textContent = '';
}
async function authorizeAdminOperation(event) {
  event.preventDefault();
  const context = adminContext(); const pending = adminPending;
  if (!pending || !adminCurrent(context)) return;
  let actorPassword = document.getElementById('admin-actor-password').value;
  let actorCode = document.getElementById('admin-actor-code').value.trim();
  const action = pending.action; const targetId = pending.target?.id || null;
  const values = action === 'admin.user.create' ? { username: document.getElementById('admin-username').value.trim().toLowerCase(), displayName: document.getElementById('admin-display-name').value.trim(), role: document.getElementById('admin-role').value, password: document.getElementById('admin-target-password').value } : action === 'admin.user.disable' ? { disabled: !pending.target.disabled } : action === 'admin.user.role' ? { role: document.getElementById('admin-role').value } : { password: document.getElementById('admin-target-password').value };
  const frozen = Object.freeze({ ...values });
  document.getElementById('admin-authorize').disabled = true;
  try {
    const result = await adminRequest('/api/admin/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, targetUserId: targetId, values: frozen, password: actorPassword, code: actorCode }) });
    if (!adminCurrent(context) || adminPending !== pending) return;
    adminPending = Object.freeze({ ...context, action, targetId, values: frozen, grant: result.grant });
    adminEditor.classList.add('hidden');
    const summary = action === 'admin.user.create' ? `创建 ${frozen.username}，显示名称 ${frozen.displayName}，角色 ${frozen.role}，初始密码已设置` : action === 'admin.user.disable' ? `${frozen.disabled ? '禁用' : '启用'} ${pending.target.username}` : action === 'admin.user.role' ? `将 ${pending.target.username} 的角色改为 ${frozen.role}` : `重置 ${pending.target.username} 的密码，要求下次登录更改密码`;
    adminSummary.textContent = `请确认本次授权请求：${summary}。目标：${targetId || '新账户'}。`; adminConfirmation.classList.remove('hidden');
  } catch (error) { if (adminCurrent(context)) { adminPending = null; adminEditor.classList.add('hidden'); adminStatus.textContent = adminError(error); } }
  finally { actorPassword = ''; actorCode = ''; if (adminCurrent(context)) { for (const id of ['admin-actor-password', 'admin-actor-code', 'admin-target-password']) document.getElementById(id).value = ''; document.getElementById('admin-authorize').disabled = false; } }
}
async function confirmAdminOperation() {
  const op = adminPending; if (!op?.grant || !adminCurrent(op)) return;
  adminPending = null; adminConfirmation.classList.add('hidden'); adminSummary.textContent = '';
  const path = op.action === 'admin.user.create' ? '/api/admin/users' : `/api/admin/users/${encodeURIComponent(op.targetId)}/${op.action === 'admin.user.disable' ? 'disabled' : op.action === 'admin.user.role' ? 'role' : 'password'}`;
  try {
    await adminRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Grant': op.grant }, body: JSON.stringify(op.values) });
    if (!adminCurrent(op)) return;
    adminStatus.textContent = '操作完成'; await loadAdminUsers();
  } catch (error) { if (adminCurrent(op)) adminStatus.textContent = adminError(error); }
}
adminOpen?.addEventListener('click', () => { if (currentMode !== 'accounts' || accountUser?.role !== 'admin') return; closeSettingsPopover(); closeAdminSettings(); adminModal.classList.remove('hidden'); loadAdminUsers(); });
document.getElementById('admin-close')?.addEventListener('click', closeAdminSettings);
document.getElementById('admin-refresh')?.addEventListener('click', () => { clearAdminOperation(); loadAdminUsers(); });
document.getElementById('admin-create')?.addEventListener('click', () => beginAdminAction('admin.user.create'));
adminEditor?.addEventListener('submit', authorizeAdminOperation);
document.getElementById('admin-cancel')?.addEventListener('click', clearAdminOperation);
document.getElementById('admin-confirm-cancel')?.addEventListener('click', clearAdminOperation);
document.getElementById('admin-confirm')?.addEventListener('click', confirmAdminOperation);
adminModal?.addEventListener('click', (e) => { if (e.target === adminModal) closeAdminSettings(); });

// 关于我们弹窗
aboutOpen?.addEventListener('click', () => {
  aboutModal?.classList.remove('hidden');
  const versionEl = document.getElementById('about-version');
  if (versionEl && typeof APP_VERSION !== 'undefined') {
    versionEl.textContent = `版本 ${APP_VERSION}`;
  }
  closeSettingsPopover();
});
aboutClose?.addEventListener('click', () => { aboutModal?.classList.add('hidden'); });
aboutModal?.addEventListener('click', (e) => { if (e.target === aboutModal) aboutModal?.classList.add('hidden'); });

// ========== 头像编辑器 ==========
let currentAvatarSelection = { type: '', value: '' };

// 分类标签切换
document.querySelectorAll('.avatar-category-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const category = tab.dataset.category;

    // 切换标签状态
    document.querySelectorAll('.avatar-category-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // 切换内容显示
    document.querySelectorAll('.avatar-category-content').forEach(content => {
      content.classList.toggle('active', content.dataset.category === category);
    });
  });
});

// 打开头像编辑器
avatarEditTrigger?.addEventListener('click', (e) => {
  e.stopPropagation();
  avatarEditorModal?.classList.remove('hidden');

  // 初始化当前头像显示
  const currentAvatar = getStoredAvatar();
  updateAvatarPreview(currentAvatar);

  // 清除之前的选择状态
  currentAvatarSelection = { ...currentAvatar };
  document.querySelectorAll('.avatar-preset-item').forEach(item => {
    item.classList.remove('selected');
    if (item.dataset.type === currentAvatar.type && item.dataset.value === currentAvatar.value) {
      item.classList.add('selected');
    }
  });

  if (currentAvatar.type === 'text') {
    avatarCustomInput.value = currentAvatar.value;
  } else {
    avatarCustomInput.value = '';
  }

  closeSettingsPopover();
});

// 关闭头像编辑器
avatarEditorClose?.addEventListener('click', () => { avatarEditorModal?.classList.add('hidden'); });
avatarEditorCancel?.addEventListener('click', () => { avatarEditorModal?.classList.add('hidden'); });
avatarEditorModal?.addEventListener('click', (e) => { if (e.target === avatarEditorModal) avatarEditorModal?.classList.add('hidden'); });

// 预设图标选择
avatarPresetGrid?.addEventListener('click', (e) => {
  const item = e.target.closest('.avatar-preset-item');
  if (!item) return;

  // 清除其他选中状态
  document.querySelectorAll('.avatar-preset-item').forEach(el => el.classList.remove('selected'));
  item.classList.add('selected');

  // 更新选择状态
  currentAvatarSelection = {
    type: item.dataset.type,
    value: item.dataset.value
  };

  // 更新预览
  updateAvatarPreview(currentAvatarSelection);

  // 清空自定义输入
  if (avatarCustomInput) avatarCustomInput.value = '';
});

// 自定义文字预览
avatarCustomPreview?.addEventListener('click', () => {
  const value = avatarCustomInput?.value.trim();
  if (!value) {
    showToast('请输入一个字符');
    return;
  }

  // 清除预设图标选中状态
  document.querySelectorAll('.avatar-preset-item').forEach(el => el.classList.remove('selected'));

  // 更新选择状态
  currentAvatarSelection = {
    type: 'text',
    value: value
  };

  // 更新预览
  updateAvatarPreview(currentAvatarSelection);
});

// 自定义输入框实时预览与回车确认
avatarCustomInput?.addEventListener('input', () => {
  const value = avatarCustomInput.value.trim();
  if (!value) return;
  document.querySelectorAll('.avatar-preset-item').forEach(el => el.classList.remove('selected'));
  currentAvatarSelection = { type: 'text', value };
  updateAvatarPreview(currentAvatarSelection);
});
avatarCustomInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    avatarCustomPreview?.click();
  }
});

// 保存头像
avatarEditorSave?.addEventListener('click', async () => {
  if (!currentAvatarSelection.type || !currentAvatarSelection.value) {
    showToast('请选择或输入一个头像');
    return;
  }

  try {
    // 保存到本地存储
    localStorage.setItem('web-clipboard-avatar', JSON.stringify(currentAvatarSelection));

    // 如果是账户模式，尝试同步到服务器（可选，失败不影响本地使用）
    if (currentMode === 'accounts' && accountUser) {
      try {
        const response = await authFetch('/api/user/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentAvatarSelection)
        });

        if (!response.ok) {
          console.warn('服务器保存头像失败，但本地已保存');
        }
      } catch (serverError) {
        console.warn('服务器保存头像失败，但本地已保存:', serverError);
      }
    }

    // 更新所有头像显示
    applyAvatarToUI(currentAvatarSelection);

    showToast('头像已更新');
    avatarEditorModal?.classList.add('hidden');
  } catch (error) {
    console.error('保存头像失败:', error);
    showToast('保存头像失败，请重试');
  }
});

// 获取存储的头像
function getStoredAvatar() {
  const stored = localStorage.getItem('web-clipboard-avatar');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error('解析头像数据失败:', e);
    }
  }

  // 默认使用用户名首字母
  if (accountUser) {
    const initial = (accountUser.displayName || accountUser.username || 'U').charAt(0).toUpperCase();
    return { type: 'text', value: initial };
  }

  return { type: 'text', value: 'U' };
}

// 更新头像预览
function updateAvatarPreview(avatar) {
  if (!avatarPreviewLarge) return;

  if (avatar.type === 'emoji' || avatar.type === 'icon') {
    if (avatar.value === 'tg-plane') {
      avatarPreviewLarge.innerHTML = `
        <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" style="color: #0088cc;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
        </svg>
      `;
    } else {
      avatarPreviewLarge.textContent = avatar.value;
    }
  } else {
    avatarPreviewLarge.textContent = avatar.value.toUpperCase();
  }
}

// 应用头像到所有UI元素
function applyAvatarToUI(avatar) {
  // 顶栏头像按钮
  const topbarUserAvatar = document.getElementById('topbar-user-avatar');
  if (topbarUserAvatar) {
    if (avatar.type === 'emoji' || avatar.type === 'icon') {
      if (avatar.value === 'tg-plane') {
        topbarUserAvatar.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="color: #0088cc;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
          </svg>
        `;
      } else {
        topbarUserAvatar.innerHTML = avatar.value;
        // 渲染 Twemoji
        if (typeof twemoji !== 'undefined') {
          twemoji.parse(topbarUserAvatar, {
            folder: 'svg',
            ext: '.svg'
          });
        }
      }
    } else {
      topbarUserAvatar.textContent = avatar.value.toUpperCase();
    }
  }

  // 设置弹窗中的紧凑头像
  const popoverCompactAvatar = document.getElementById('popover-compact-avatar');
  if (popoverCompactAvatar) {
    if (avatar.type === 'emoji' || avatar.type === 'icon') {
      if (avatar.value === 'tg-plane') {
        popoverCompactAvatar.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="color: #0088cc;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
          </svg>
        `;
      } else {
        popoverCompactAvatar.innerHTML = avatar.value;
        // 渲染 Twemoji
        if (typeof twemoji !== 'undefined') {
          twemoji.parse(popoverCompactAvatar, {
            folder: 'svg',
            ext: '.svg'
          });
        }
      }
    } else {
      popoverCompactAvatar.textContent = avatar.value.toUpperCase();
    }
  }
}

async function loadSecuritySessions() {
  const epoch = accountEpoch;
  const generation = securityGeneration;
  try { const response = await authFetch('/api/auth/sessions'); if (epoch !== accountEpoch || generation !== securityGeneration) return; const data = await response.json(); if (epoch !== accountEpoch || generation !== securityGeneration) return;
    securitySessions.textContent = '';
    const heading = document.createElement('p'); heading.textContent = '有效设备'; securitySessions.appendChild(heading);
    for (const row of data.valid || []) {
      const item = document.createElement('div'); item.className = 'popover-meta-item';
      item.textContent = `${row.deviceLabel || '设备'} · ${row.id === data.currentSessionId ? '当前会话' : '有效会话'}${row.recentlyActive ? ' · 近期活动' : ''}`;
      if (row.id !== data.currentSessionId) { const button = document.createElement('button'); button.className = 'btn btn-secondary'; button.type = 'button'; button.textContent = '撤销此设备'; button.addEventListener('click', () => beginSecurityAction('session.revoke', row.id)); item.appendChild(button); }
      securitySessions.appendChild(item);
    }
    document.getElementById('security-factor-disable').disabled = accountUser?.role === 'admin' || accountUser?.login_policy === 'strict' || accountUser?.loginPolicy === 'strict';
  } catch (error) { if (epoch === accountEpoch && generation === securityGeneration && error.name !== 'AbortError') securityStatus.textContent = '设备读取失败'; }
}
async function beginSecurityAction(action, targetSessionId = null) {
  securityGeneration += 1; clearVerificationSecrets(); verificationField('security-send-code').disabled = false;
  securityCompleteState = null; securityFactorSecret.textContent = ''; document.getElementById('security-factor-qr').removeAttribute('src'); document.getElementById('security-factor-qr').classList.add('hidden'); securityNewCode.value = ''; securityEmailChallenge = null;
  securityGrant = null; securityGrantAction = action; securityTarget = targetSessionId;
  securityEdit?.classList.toggle('hidden', !['password.change', 'factor.replace'].includes(action));
  securityReauth?.classList.remove('hidden'); securityStatus.textContent = '请再次验证身份后继续';
  document.getElementById('security-code').value = ''; document.getElementById('security-code').required = verificationSettings?.method === 'totp';
  document.getElementById('security-send-code').classList.toggle('hidden', verificationSettings?.method !== 'email');
}
async function submitSecurityReauth() {
  const epoch = accountEpoch;
  const generation = securityGeneration;
  const currentPassword = securityPassword.value;
  const newPassword = securityNewPassword.value;
  const action = securityGrantAction;
  const targetId = securityTarget;
  try {
    const response = await authFetch('/api/auth/reauth', { method: 'POST', body: JSON.stringify({ action, targetSessionId: targetId, password: currentPassword, code: securityCode.value, emailChallenge: securityEmailChallenge }), headers: { 'Content-Type': 'application/json' } });
    const data = await response.json(); if (epoch !== accountEpoch || generation !== securityGeneration) return;
    if (!response.ok) throw new Error('验证失败');
    const grant = data.grant;
    securityGrant = grant; securityReauth.classList.add('hidden'); securityPassword.value = ''; securityCode.value = ''; securityNewPassword.value = '';
    if (action.startsWith('session.revoke')) {
      if (!window.confirm(`确认撤销：${data.target?.label || `${data.target?.count || 0} 个会话`}？`)) { securityGrant = null; return; }
      const endpoint = targetId ? `/api/auth/sessions/${encodeURIComponent(targetId)}/revoke` : action === 'session.revoke-others' ? '/api/auth/sessions/revoke-others' : '/api/auth/sessions/revoke-all';
      const result = await authFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Grant': grant }, body: '{}' });
      if (epoch !== accountEpoch || generation !== securityGeneration) return;
      if (!result.ok) throw new Error('撤销失败'); securityStatus.textContent = '设备撤销完成'; securityGrant = null; loadSecuritySessions(); return;
    }
    if (action === 'history.read-details') { await loadSecurityHistory(true); securityGrant = null; return; }
    if (action === 'password.change') {
      const result = await authFetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Grant': grant }, body: JSON.stringify({ currentPassword, newPassword }) });
      if (epoch !== accountEpoch || generation !== securityGeneration) return;
      if (!result.ok) throw new Error('密码修改失败'); securityGrant = null; await logout(false, false); return;
    }
    if (action === 'factor.disable') {
      if (!window.confirm('确认停用动态验证码并重新登录？')) { securityGrant = null; return; }
      const result = await authFetch('/api/auth/totp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Grant': grant }, body: '{}' });
      if (epoch !== accountEpoch || generation !== securityGeneration) return;
      if (!result.ok) throw new Error('停用失败'); securityGrant = null; await logout(false, false); return;
    }
    if (action === 'factor.replace') {
      const staged = await authFetch('/api/auth/totp/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operation-Grant': grant }, body: '{}' }); const details = await staged.json(); if (!staged.ok) throw new Error('动态验证码初始化失败'); if (epoch !== accountEpoch || generation !== securityGeneration) return; securityGrant = null; document.getElementById('security-factor-qr').src = details.qrCode; document.getElementById('security-factor-qr').classList.remove('hidden'); securityFactorSecret.textContent = `也可手动添加密钥：${details.secret}`; securityEdit.classList.remove('hidden'); securityStatus.textContent = '输入新认证器验证码后完成设置'; securityCompleteState = details.challenge;
    }
  } catch (error) { if (epoch === accountEpoch && generation === securityGeneration && error.name !== 'AbortError') securityStatus.textContent = error.message || '操作失败'; }
}
// ===== 账户与安全弹窗：左侧导航切换 =====
(function () {
  const navBtns = document.querySelectorAll('.security-nav-btn');
  const panes = document.querySelectorAll('.security-pane');
  function switchPane(panelId) {
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.panel === panelId));
    panes.forEach(p => p.classList.toggle('hidden', p.id !== 'security-pane-' + panelId));
    if (panelId === 'history' && securityHistory && !securityHistory.children.length) {
      loadSecurityHistory(false);
    }
  }
  navBtns.forEach(btn => btn.addEventListener('click', () => switchPane(btn.dataset.panel)));
  // 暴露给外部以便打开时重置到第一个面板
  window._securitySwitchPane = switchPane;
})();

securityOpen?.addEventListener('click', async () => {
  closeSettingsPopover();
  closeSecuritySettings(); securityModal.classList.remove('hidden'); securityStatus.textContent = '正在读取安全设置…';
  const epoch = accountEpoch; const generation = securityGeneration;
  try { await loadVerificationSettings(); if (epoch !== accountEpoch || generation !== securityGeneration) return; securityStatus.textContent = ''; loadSecuritySessions(); }
  catch (error) { if (epoch === accountEpoch && generation === securityGeneration) securityStatus.textContent = error.message; }
});
securityModal?.addEventListener('click', (e) => { if (e.target === securityModal) closeSecuritySettings(); });
function closeSecuritySettings(preserveSelfSecurityOp = false) {
  if (preserveSelfSecurityOp !== true) cancelSelfSecurityDelivery();
  securityGeneration += 1;
  clearVerificationSecrets(); verificationSettings = null; verificationField('verification-controls').classList.add('hidden'); verificationField('verification-summary').textContent = ''; verificationField('security-send-code').disabled = false;
  securityModal?.classList.add('hidden'); securityGrant = null; securityTarget = null; securityCompleteState = null; securityGrantAction = null;
  securityPassword.value = ''; securityCode.value = ''; securityNewPassword.value = ''; securityNewCode.value = ''; securityFactorSecret.textContent = ''; document.getElementById('security-factor-qr').removeAttribute('src'); document.getElementById('security-factor-qr').classList.add('hidden');
  securitySessions.textContent = ''; securityHistory.textContent = ''; securityStatus.textContent = ''; securityEdit.classList.add('hidden'); securityReauth.classList.add('hidden');
  if (window._securitySwitchPane) window._securitySwitchPane('sessions');
}
securityClose?.addEventListener('click', closeSecuritySettings);
securityReauthBtn?.addEventListener('click', submitSecurityReauth);
document.getElementById('security-complete')?.addEventListener('click', async () => {
  const epoch = accountEpoch; const generation = securityGeneration; const challenge = securityCompleteState; const code = securityNewCode.value;
  const selfOp = { epoch, generation, userId: accountUser?.id || null, revokedEpoch: null }; pendingSelfSecurityOp = selfOp;
  try {
    // Dedicated response channel: never exposes private data to normal UI consumers.
    // It survives only this operation's expected session-revoked cleanup.
    const response = await fetch('/api/auth/totp/confirm', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': accountCsrfToken || '' }, body: JSON.stringify({ challenge, code }) });
    if (!canDeliverSelfSecurity(selfOp)) return;
    const data = await response.json();
    if (!canDeliverSelfSecurity(selfOp)) return;
    if (!response.ok) { if (response.status === 401) await logout(false, false); throw new Error('动态验证码设置失败'); }
    if (selfOp.revokedEpoch == null) await logout(false, false, false, true);
    if (!canDeliverSelfSecurity(selfOp)) return;
    pendingSelfSecurityOp = null;
    if (Array.isArray(data.recoveryCodes) && !isAuthenticated) { const result = document.getElementById('account-recovery-result'); result.textContent = `请立即保存恢复码（仅显示一次）：${data.recoveryCodes.join(' / ')}`; result.classList.remove('hidden'); }
  } catch (error) { if (epoch === accountEpoch && generation === securityGeneration && error.name !== 'AbortError') securityStatus.textContent = error.message || '设置失败'; }
  finally { if (pendingSelfSecurityOp === selfOp) pendingSelfSecurityOp = null; }
});
document.getElementById('security-refresh')?.addEventListener('click', loadSecuritySessions);
async function loadSecurityHistory(details = false) {
  const epoch = accountEpoch;
  const historyGeneration = securityGeneration;
  try {
    const headers = details && securityGrant ? { 'X-Operation-Grant': securityGrant, 'X-CSRF-Token': accountCsrfToken || '' } : {};
    const response = await authFetch(details ? '/api/auth/history/details' : '/api/auth/history', { headers });
    if (epoch !== accountEpoch || historyGeneration !== securityGeneration) return;
    const data = await response.json(); if (epoch !== accountEpoch || historyGeneration !== securityGeneration) return; if (!response.ok) throw new Error('安全事件读取失败');
    securityHistory.textContent = '';
    for (const event of (Array.isArray(data) ? data : data.events || [])) { const item = document.createElement('div'); item.className = 'popover-meta-item'; item.textContent = `${event.action || '安全事件'} · ${event.at || event.createdAt || ''}`; securityHistory.appendChild(item); }
  } catch (error) { if (epoch === accountEpoch && historyGeneration === securityGeneration && error.name !== 'AbortError') securityStatus.textContent = error.message || '安全事件读取失败'; }
}
async function beginHistoryDetails() { await beginSecurityAction('history.read-details'); }
document.getElementById('security-password-btn')?.addEventListener('click', () => beginSecurityAction('password.change'));
document.getElementById('security-factor-btn')?.addEventListener('click', () => beginSecurityAction('factor.replace'));
document.getElementById('security-factor-disable')?.addEventListener('click', () => beginSecurityAction('factor.disable'));
document.getElementById('security-history-btn')?.addEventListener('click', () => loadSecurityHistory(false));
document.getElementById('security-history-details-btn')?.addEventListener('click', beginHistoryDetails);
document.getElementById('security-revoke-others')?.addEventListener('click', () => beginSecurityAction('session.revoke-others'));
document.getElementById('security-revoke-all')?.addEventListener('click', () => beginSecurityAction('session.revoke-all'));

document.getElementById('registration-code').addEventListener('keydown', event => {
  if (event.key === 'Enter' && registrationMode) { event.preventDefault(); registerAccount(); }
});
document.getElementById('registration-toggle').addEventListener('click', () => {
  const enabled = !registrationMode;
  resetAccountLogin();
  setRegistrationMode(enabled);
  passwordInput.autocomplete = enabled ? 'new-password' : 'current-password';
  passwordInput.placeholder = enabled ? '至少 8 位，含大小写、数字和特殊字符' : '输入密码';
});
for (const id of ['username-input', 'password-input']) {
  document.getElementById(id).addEventListener('input', () => {
    if (!registrationMode) return;
    registrationChallenge = null;
    setRegistrationMode(true);
  });
}
async function registerAccount() {
  const epoch = accountEpoch;
  if (authBtn.disabled) return;
  const email = document.getElementById('username-input');
  if (!registrationChallenge && (!email.value.trim() || !email.reportValidity())) return;
  const body = registrationChallenge
    ? { challenge: registrationChallenge, code: document.getElementById('registration-code').value.trim() }
    : { password: passwordInput.value, email: email.value.trim() };
  authBtn.disabled = true;
  const fields = ['password-input', 'username-input', 'registration-code'].map(id => document.getElementById(id));
  fields.forEach(field => { field.disabled = true; });
  try {
    const response = await sessionFetch(`/api/auth/register/${registrationChallenge ? 'confirm' : 'start'}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (epoch !== accountEpoch) return;
    if (!response.ok) {
      const errors = { PASSWORD_POLICY: '密码至少需要 8 位，并包含大写字母、小写字母、数字和 ASCII 标点，且不能包含邮箱前缀', INVALID_REGISTRATION: '注册信息无效，请检查邮箱和密码', INVALID_EMAIL: '请输入有效邮箱', MAIL_UNAVAILABLE: '邮件服务暂不可用，请稍后重试', REGISTRATION_RATE_LIMIT: '发送过于频繁，请至少一分钟后重试', AUTH_RATE_LIMIT: '请求过于频繁，请稍后重试', AUTH_BUSY: '服务繁忙，请稍后重试', AUTH_FAILED: '验证码无效或已过期，请返回登录后重新注册' };
      throw new Error(errors[data.code] || '注册未完成，请稍后重试');
    }
    if (!registrationChallenge) {
      registrationChallenge = data.challenge;
      passwordInput.value = '';
      setRegistrationMode(true);
      document.getElementById('registration-email-hint').textContent = `验证码已发送至 ${data.emailHint}，5 分钟内有效。`;
      document.getElementById('registration-code').focus();
      authError.classList.add('hidden');
    } else {
      resetAccountLogin();
      const result = document.getElementById('account-recovery-result');
      result.textContent = '邮箱验证完成。若账户信息可用，账户已创建，请使用邮箱和密码登录。';
      result.classList.remove('hidden');
    }
  } catch (error) {
    if (epoch === accountEpoch && error.name !== 'AbortError') { authError.textContent = error.message; authError.classList.remove('hidden'); }
  } finally {
    if (epoch === accountEpoch) {
      authBtn.disabled = false;
      fields.forEach(field => { field.disabled = false; });
      if (registrationChallenge) document.getElementById('registration-code').focus();
    }
  }
}
async function verifyAccount() {
  if (registrationMode) return registerAccount();
  if (authBtn.disabled) return;
  cancelSelfSecurityDelivery();
  const epoch = accountEpoch;
  const identifier = usernameInput?.value.trim();
  const password = passwordInput?.value || '';
  const code = document.getElementById('account-code')?.value.trim();

  // 邮箱验证码登录处理
  if (currentLoginMethod === 'email-code' && !accountChallenge) {
    if (!identifier || !usernameInput.reportValidity()) return;
    if (!identifier.includes('@')) {
      authError.textContent = '请输入有效的邮箱地址';
      authError.classList.remove('hidden');
      return;
    }

    authBtn.disabled = true;
    authError.classList.add('hidden');

    try {
      const response = await sessionFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: identifier,
          loginMethod: 'email-code',
          ephemeral: document.getElementById('login-duration-select')?.value === 'ephemeral',
          deviceLabel: 'Browser'
        })
      });

      const data = await response.json();

      if (response.ok && data.requiresSecondFactor) {
        emailCodeChallenge = data.challenge;
        emailCodeHint.textContent = `验证码已发送至 ${data.emailHint || identifier}`;
        emailCodeHint.style.color = 'var(--success)';
        emailLoginCode.focus();
      } else {
        authError.textContent = data.message || '发送验证码失败';
        authError.classList.remove('hidden');
      }
    } catch (error) {
      authError.textContent = error.message || '网络错误';
      authError.classList.remove('hidden');
    } finally {
      authBtn.disabled = false;
    }
    return;
  }

  // 邮箱验证码二次验证
  if (currentLoginMethod === 'email-code' && emailCodeChallenge) {
    const emailCode = emailLoginCode?.value.trim();
    if (!emailCode || emailCode.length !== 6) {
      authError.textContent = '请输入6位验证码';
      authError.classList.remove('hidden');
      return;
    }

    authBtn.disabled = true;
    authError.classList.add('hidden');

    try {
      const response = await sessionFetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ challenge: emailCodeChallenge, code: emailCode })
      });

      const data = await response.json();
      if (epoch !== accountEpoch) return;

      if (response.ok) {
        emailCodeChallenge = null;
        if (emailLoginCode) emailLoginCode.value = '';
        const me = await sessionFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json());
        if (epoch !== accountEpoch) return;
        accountUser = me.user;
        accountSessionId = me.sessionId || null;
        userId = me.user?.id || null;
        accountCsrfToken = me.csrfToken || null;
        enrollmentPending = Boolean(me.requiresFactorSetup);
        enrollmentOptional = Boolean(me.optionalFactorSetup);
        enterChatMode();
        return;
      } else {
        authError.textContent = data.error || data.message || '验证码错误';
        authError.classList.remove('hidden');
      }
    } catch (error) {
      if (epoch === accountEpoch && error.name !== 'AbortError') {
        authError.textContent = error.message || '验证失败';
        authError.classList.remove('hidden');
      }
    } finally {
      if (epoch === accountEpoch) authBtn.disabled = false;
    }
    return;
  }

  // 原有密码登录逻辑
  if (!accountChallenge && (!identifier || !usernameInput.reportValidity())) return;
  const body = accountChallenge ? { challenge: accountChallenge } : { ...accountIdentifierPayload(identifier), password };
  if (accountChallenge) { body.code = code; body.newPassword = document.getElementById('account-new-password')?.value || ''; }
  if (accountStage === 'setup' && !verificationField('account-new-password').classList.contains('hidden') && (body.newPassword.length < 8 || new TextEncoder().encode(body.newPassword).length > 1024)) {
    authError.textContent = '新密码至少需要 8 位，并包含大写字母、小写字母、数字和特殊字符'; authError.classList.remove('hidden'); return;
  }
  const route = accountChallenge ? (accountStage === 'mfa' ? '/api/auth/login/verify' : '/api/auth/setup/complete') : '/api/auth/login';
  const resultEl = document.getElementById('account-recovery-result'); if (resultEl) { resultEl.textContent = ''; resultEl.classList.add('hidden'); }
  authBtn.disabled = true;
  try {
    const response = await sessionFetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Origin: location.origin }, body: JSON.stringify(body), cache: 'no-store' });
    const data = await response.json();
    if (epoch !== accountEpoch) return;
    if (!response.ok) throw new Error(data.error || '登录失败');
    if (data.requiresSetup) {
      accountStage = 'setup'; accountChallenge = data.challenge;
      showAccountFactorStep({ requirePassword: Boolean(data.requirePassword), requireFactor: Boolean(data.requireFactor) });
      if (data.requireFactor) {
        const staged = await sessionFetch('/api/auth/setup/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: accountChallenge }), cache: 'no-store' });
        const details = await staged.json(); if (!staged.ok) { resetAccountLogin(); throw new Error(details.error || '初始化失败'); } if (epoch !== accountEpoch) return; accountChallenge = details.challenge;
        const secretEl = document.getElementById('account-setup-secret'); if (secretEl) secretEl.textContent = `请在认证器中手动添加密钥：${details.secret}`;
      }
      document.getElementById('account-factor-fields')?.classList.remove('hidden'); authError.textContent = data.requireFactor ? '请输入动态验证码完成初始化' : '请输入新密码完成初始化'; authError.classList.remove('hidden'); return;
    }
    if (data.requiresSecondFactor) { accountStage = 'mfa'; accountChallenge = data.challenge; const email = data.factorMethod === 'email'; showAccountFactorStep({ email, recovery: !email }); if (email) passwordInput.value = ''; authError.textContent = email ? `验证码已发送至 ${data.emailHint || '绑定邮箱'}` : '请输入动态验证码'; authError.classList.remove('hidden'); return; }
    accountStage = 'login'; accountChallenge = null; authError.classList.add('hidden');
    passwordInput.value = ''; document.getElementById('account-code').value = ''; document.getElementById('account-new-password').value = '';
    document.getElementById('account-setup-secret').textContent = '';
    if (data.requiresLogin) {
      resetAccountLogin();
      const result = document.getElementById('account-recovery-result');
      result.textContent = data.recoveryCodes ? `仅显示一次，请立即安全保存恢复码，然后重新登录：${data.recoveryCodes.join(' / ')}` : '设置完成，请重新登录';
      result.classList.remove('hidden'); document.getElementById('account-factor-fields').classList.add('hidden'); return;
    }
    const me = await sessionFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json());
    if (epoch !== accountEpoch) return;
    accountUser = me.user; accountSessionId = me.sessionId || null; userId = me.user?.id || null; accountCsrfToken = me.csrfToken || null; enrollmentPending = Boolean(me.requiresFactorSetup); enrollmentOptional = Boolean(me.optionalFactorSetup); enterChatMode();
    if (data.recoveryCodes) { const result = document.getElementById('account-recovery-result'); if (result) { result.textContent = `请立即保存恢复码：${data.recoveryCodes.join(', ')}`; result.classList.remove('hidden'); } }
  } catch (error) { if (epoch === accountEpoch && error.name !== 'AbortError') { authError.textContent = error.message || '验证失败'; authError.classList.remove('hidden'); } }
  finally { if (epoch === accountEpoch) authBtn.disabled = false; }
}

async function verifyPassword(password, cachedUserId = null) {
  if (!['single', 'multi'].includes(currentMode)) return;
  try {
    const response = await sessionFetch('/api/auth', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await response.json();

    if (data.success) {
      // 多用户模式：存储 userId
      if (data.mode === 'multi' && data.userId) {
        userId = data.userId;
        localStorage.setItem('web-clipboard-user-id', userId);
      }

      // 无密码模式不缓存密码
      if (!data.noPassword) {
        localStorage.setItem('web-clipboard-password', password);
        setProxyAuthCookie(password);

        // 处理登录有效时长
        if (limitDurationChk && limitDurationChk.checked) {
          const durationVal = loginDurationSelect.value;
          let durationMs = 0;
          if (durationVal === '10m') durationMs = 10 * 60 * 1000;
          else if (durationVal === '30m') durationMs = 30 * 60 * 1000;
          else if (durationVal === '1h') durationMs = 1 * 60 * 60 * 1000;
          else if (durationVal === '6h') durationMs = 6 * 60 * 60 * 1000;
          else if (durationVal === '12h') durationMs = 12 * 60 * 60 * 1000;
          else if (durationVal === '24h') durationMs = 24 * 60 * 60 * 1000;
          else if (durationVal === '3d') durationMs = 3 * 24 * 60 * 60 * 1000;
          else if (durationVal === '7d') durationMs = 7 * 24 * 60 * 60 * 1000;
          else if (durationVal === '30d') durationMs = 30 * 24 * 60 * 60 * 1000;

          if (durationMs > 0) {
            localStorage.setItem('web-clipboard-login-expires', (Date.now() + durationMs).toString());
          } else {
            localStorage.removeItem('web-clipboard-login-expires');
          }
        } else {
          localStorage.removeItem('web-clipboard-login-expires');
        }
      } else {
        localStorage.removeItem('web-clipboard-login-expires');
      }

      enterChatMode();
      return;
    }

    document.documentElement.classList.remove('preload-auth');
    authSection.classList.remove('hidden');
    chatSection.classList.add('hidden');
    authError.classList.remove('hidden');
    localStorage.removeItem('web-clipboard-password');
    localStorage.removeItem('web-clipboard-user-id');
  } catch (error) {
    document.documentElement.classList.remove('preload-auth');
    authSection.classList.remove('hidden');
    chatSection.classList.add('hidden');
    showToast('验证失败');
    console.error(error);
  }
}

function setUploadProgress(visible, percent = 0, text = '上传中...') {
  const container = document.getElementById('upload-progress-container');
  if (!container) return;
  const fill = document.getElementById('upload-progress-fill');
  const textEl = document.getElementById('upload-progress-text');
  const percentEl = document.getElementById('upload-progress-percent');
  if (visible) {
    container.classList.remove('hidden');
    if (fill) fill.style.width = `${percent}%`;
    if (textEl) textEl.textContent = text;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  } else {
    container.classList.add('hidden');
    if (fill) fill.style.width = '0%';
  }
}

function cancelUpload() {
  if (currentXhr) {
    currentXhr.abort();
    currentXhr = null;
  }
  uploadQueue = [];
  isUploading = false;
  setUploadProgress(false);
  showToast('上传已取消');
}

function sendMessageWithProgress(type, content) {
  return new Promise((resolve, reject) => {
    if (type === 'text' && (!content || !content.trim())) {
      showToast('内容不能为空');
      reject(new Error('内容不能为空'));
      return;
    }

    if (type === 'image' || type === 'file') {
      const isFileOrBlob = content instanceof File || content instanceof Blob;
      const isImagePayload = content && typeof content === 'object' && (content.file instanceof File || content.file instanceof Blob);
      if (!isFileOrBlob && !isImagePayload) {
        showToast('文件内容为空');
        reject(new Error('文件内容为空'));
        return;
      }
    }

    const requestEpoch = accountEpoch;
    const xhr = new XMLHttpRequest();
    currentXhr = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = (e.loaded / e.total) * 100;
        setUploadProgress(true, percent, `上传中... ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)}`);
      }
    });

    xhr.addEventListener('load', () => {
      if (requestEpoch !== accountEpoch) { reject(new DOMException('Stale session', 'AbortError')); return; }
      currentXhr = null;
      if (currentMode === 'accounts' && xhr.status === 401) logout(false, false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response);
        } catch (error) {
          reject(new Error('响应解析失败'));
        }
      } else {
        try {
          const response = JSON.parse(xhr.responseText);
          reject(new Error(response.error || '上传失败'));
        } catch (error) {
          reject(new Error('上传失败'));
        }
      }
    });

    xhr.addEventListener('error', () => {
      currentXhr = null;
      reject(new Error('网络错误'));
    });

    xhr.addEventListener('abort', () => {
      currentXhr = null;
      reject(new Error('上传已取消'));
    });

    const setXhrHeaders = (x) => {
      if (currentMode === 'accounts') { if (accountCsrfToken) x.setRequestHeader('X-CSRF-Token', accountCsrfToken); return; }
      const savedPassword = localStorage.getItem('web-clipboard-password');
      const savedUserId = localStorage.getItem('web-clipboard-user-id');
      if (savedPassword) {
        x.setRequestHeader('x-access-password', savedPassword);
      }
      if (savedUserId) {
        x.setRequestHeader('x-user-id', savedUserId);
      }
    };

    // 文本消息使用原有 JSON API
    if (type === 'text') {
      xhr.open('POST', '/api/messages');
      xhr.setRequestHeader('Content-Type', 'application/json');
      setXhrHeaders(xhr);
      const payload = { type, content, ...(currentMode === 'accounts' && sensitiveTextInput?.checked ? { sensitive: true } : {}) };
      // 多用户模式下添加 userId
      if (currentMode === 'multi' && userId) {
        payload.userId = userId;
      }
      xhr.send(JSON.stringify(payload));
    } else {
      // 图片和文件使用 FormData
      const formData = new FormData();
      formData.append('type', type);

      if (content && typeof content === 'object' && ('file' in content || 'thumbnail' in content)) {
        if (content.file) {
          formData.append('file', content.file);
        }
        if (content.thumbnail) {
          formData.append('thumbnail', content.thumbnail);
        }
      } else {
        formData.append('file', content);
      }

      // 多用户模式下添加 userId
      if (currentMode === 'multi' && userId) {
        formData.append('userId', userId);
      }
      xhr.open('POST', '/api/messages/upload');
      setXhrHeaders(xhr);
      xhr.send(formData);
    }
  });
}

async function processUploadQueue() {
  const requestEpoch = accountEpoch;
  if (isUploading || uploadQueue.length === 0) return;

  isUploading = true;
  const { type, content } = uploadQueue[0];

  try {
    setUploadProgress(true, 0, '准备上传...');
    const response = await sendMessageWithProgress(type, content);

    // 直接将返回的消息添加到本地列表，不依赖 WebSocket
    if (requestEpoch !== accountEpoch) return;
    if (response && response.message) {
      // 检查消息是否已存在（避免 WebSocket 重复添加）
      const exists = messages.some((m) => m.id === response.message.id);
      if (!exists) {
        messages.push(response.message);
        appendSingleMessage(response.message);
        showToast('发送成功');
      }
    }
  } catch (error) {
    if (error.message !== '上传已取消') {
      showToast(error.message || '上传失败');
      console.error(error);
    }
  } finally {
    if (requestEpoch !== accountEpoch) return;
    uploadQueue.shift();
    isUploading = false;
    setUploadProgress(false);

    if (uploadQueue.length > 0) {
      processUploadQueue();
    }
  }
}

function queueUpload(type, content) {
  uploadQueue.push({ type, content });
  processUploadQueue();
}

async function sendMessage(type, content) {
  queueUpload(type, content);
}

async function deleteMessage(id) {
  try {
    if (currentViewerTextMsg?.id === id) clearSensitiveViewerState();
    removeSingleMessage(id);
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }
    await authFetch(`/api/messages/${id}?${params.toString()}`, {
      method: 'DELETE'
    });
  } catch (error) {
    showToast('删除失败');
    console.error(error);
  }
}

async function clearAllMessages() {
  closeSettingsPopover();
  showConfirmModal('确定要清空所有消息吗？', async () => {
    try {
      const params = new URLSearchParams();
      if (currentMode === 'multi' && userId) {
        params.set('userId', userId);
      }
      await authFetch(`/api/messages/clear?${params.toString()}`, {
        method: 'POST'
      });
      clearSensitiveViewerState();
      showToast('已清空');
    } catch (error) {
      showToast('清空失败');
      console.error(error);
    }
  });
}

function showConfirmModal(message, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  const modalMessage = document.getElementById('modal-message');
  const cancelBtn = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('modal-confirm');

  modalMessage.textContent = message;
  modal.classList.remove('hidden');

  const closeModal = () => {
    modal.classList.add('hidden');
    cancelBtn.removeEventListener('click', closeModal);
    confirmBtn.removeEventListener('click', handleConfirm);
  };

  const handleConfirm = () => {
    closeModal();
    onConfirm();
  };

  cancelBtn.addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', handleConfirm);

  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };
}

async function pasteText() {
  try {
    const text = await navigator.clipboard.readText();
    textInput.value = text;
    textInput.focus();
    autoResizeTextarea();
    showToast('已粘贴');
  } catch (error) {
    showToast('无法读取剪贴板');
    console.error(error);
  }
}

async function pasteAndSendText() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      showToast('剪贴板无文本内容');
      return;
    }
    sendMessage('text', text);
    showToast('已一键粘贴并发送');
  } catch (error) {
    showToast('无法读取剪贴板');
    console.error(error);
  }
}

// 兜底复制：navigator.clipboard 需要安全上下文，自签证书环境下可能被拒绝
function legacyCopyText(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function copyTextToClipboard(text) {
  const value = String(text == null ? '' : text);
  if (!value) {
    showToast('没有可复制的内容');
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      showToast('已复制到剪贴板');
      return;
    } catch (error) {
      console.warn('navigator.clipboard 不可用，尝试降级方案', error);
    }
  }

  if (legacyCopyText(value)) {
    showToast('已复制到剪贴板');
  } else {
    showToast('复制失败，请手动选择文本');
  }
}

function dataURLtoBlobSync(dataUrl) {
  try {
    const parts = dataUrl.split(',');
    if (parts.length !== 2) return null;
    const match = parts[0].match(/:(.*?);/);
    const mime = match ? match[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    console.error('dataURLtoBlobSync 失败:', e);
    return null;
  }
}

function convertImageSourceToPngBlob(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context not available'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Canvas toBlob failed'));
          }
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

async function writePngToClipboard(blobOrPromise) {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
    throw new Error('浏览器不支持剪贴板图片写入');
  }

  try {
    const item = new ClipboardItem({ 'image/png': blobOrPromise });
    await navigator.clipboard.write([item]);
    return true;
  } catch (firstErr) {
    if (blobOrPromise instanceof Promise) {
      const resolvedBlob = await blobOrPromise;
      const item = new ClipboardItem({ 'image/png': resolvedBlob });
      await navigator.clipboard.write([item]);
      return true;
    }
    throw firstErr;
  }
}

async function copyImageToClipboard(dataUrl, options = {}) {
  const {
    successToast = '图片已复制到剪贴板',
    failureToast = '复制图片失败，请尝试右键另存',
    silentFailure = false
  } = options;

  if (!dataUrl) {
    if (!silentFailure) showToast(failureToast);
    return false;
  }

  try {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
      const syncBlob = dataURLtoBlobSync(dataUrl);
      if (syncBlob) {
        await writePngToClipboard(syncBlob);
        if (successToast) showToast(successToast);
        return true;
      }
    }

    const blobPromise = (async () => {
      return await convertImageSourceToPngBlob(dataUrl);
    })();

    await writePngToClipboard(blobPromise);
    if (successToast) showToast(successToast);
    return true;
  } catch (error) {
    console.error('复制图片失败:', error);
    if (!silentFailure) {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
        showToast('浏览器不支持复制图片，请右键另存');
      } else {
        showToast(failureToast);
      }
    }
    return false;
  }
}

async function fetchOriginalImageWithTimeout(id, timeoutMs = ORIGINAL_FETCH_TIMEOUT) {
  const params = new URLSearchParams();
  if (currentMode === 'multi' && userId) {
    params.set('userId', userId);
  }
  params.set('original', '1');
  // 走带 Cookie 认证的流式接口，避免超大 base64 JSON
  const response = await authFetch(`/api/messages/${id}/image-file?${params.toString()}`, {
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob || !blob.type || !blob.type.startsWith('image/')) {
    throw new Error('invalid original data');
  }
  return await blobToDataURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

async function copyOriginalImageWithFallback(msg) {
  const imageData = getImageContent(msg.content);
  const thumbnail = imageData.thumbnail;
  if (!thumbnail) {
    showToast('当前消息缺少可复制的缩略图');
    return;
  }

  let usedFallback = false;
  let fallbackReason = '';

  const originalBlobPromise = (async () => {
    try {
      const original = await fetchOriginalImageWithTimeout(msg.id, ORIGINAL_FETCH_TIMEOUT);
      if (typeof original === 'string' && original.startsWith('data:image/png;base64,')) {
        const syncBlob = dataURLtoBlobSync(original);
        if (syncBlob) return syncBlob;
      }
      return await convertImageSourceToPngBlob(original);
    } catch (err) {
      console.warn('获取原图失败，回退复制缩略图:', err);
      usedFallback = true;
      fallbackReason = err && err.name === 'AbortError' ? '超时' : '失败';
      if (typeof thumbnail === 'string' && thumbnail.startsWith('data:image/png;base64,')) {
        const syncBlob = dataURLtoBlobSync(thumbnail);
        if (syncBlob) return syncBlob;
      }
      return await convertImageSourceToPngBlob(thumbnail);
    }
  })();

  try {
    await writePngToClipboard(originalBlobPromise);
    if (usedFallback) {
      showToast(fallbackReason === '超时' ? '复制原图超时，已回退复制缩略图' : '获取原图失败，已回退复制缩略图');
    } else {
      showToast('原图已复制到剪贴板');
    }
  } catch (error) {
    console.error('复制原图失败:', error);
    showToast('复制原图失败，请尝试右键另存');
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read blob failed'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElementFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('load image failed'));
    };
    img.src = url;
  });
}

async function compressImageToBlob(fileOrBlob, maxEdge = 3840, quality = 0.95) {
  try {
    const img = await loadImageElementFromBlob(fileOrBlob);
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;

    // 若原图尺寸在限制内，保持 100% 点对点原始尺寸不缩放
    const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    return await new Promise((resolve) => {
      // 优先输出高质量 webp，不支持时降级为 jpeg
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          canvas.toBlob((fallbackBlob) => {
            resolve(fallbackBlob || fileOrBlob);
          }, 'image/jpeg', quality);
        }
      }, 'image/webp', quality);
    });
  } catch (err) {
    console.error('压缩图片失败，回退使用原始文件:', err);
    return fileOrBlob;
  }
}

async function createThumbnailBlob(fileOrBlob) {
  return compressImageToBlob(fileOrBlob, 1920, 0.92);
}

// 判定是否为 HEIC/HEIF 格式
function isHeicFile(file) {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/heic' || mime === 'image/heif') return true;
  const name = file.name || '';
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

// 动态载入本地 heic2any 库
let heic2anyLoadingPromise = null;
function ensureHeic2AnyLoaded() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (heic2anyLoadingPromise) return heic2anyLoadingPromise;

  heic2anyLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/heic2any.min.js';
    script.onload = () => {
      resolve(window.heic2any);
    };
    script.onerror = (err) => {
      heic2anyLoadingPromise = null;
      reject(new Error('加载 HEIC 转换器失败'));
    };
    document.head.appendChild(script);
  });

  return heic2anyLoadingPromise;
}

// 若为 HEIC 格式则在前端自动转换为高质量 JPEG File
async function convertHeicToJpegIfNeeded(file) {
  if (!isHeicFile(file)) return file;

  try {
    showToast('检测到 HEIC 图片，正在转换格式...');
    await ensureHeic2AnyLoaded();
    const result = await window.heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.92
    });

    const jpegBlob = Array.isArray(result) ? result[0] : result;
    const origName = file.name || `image-${Date.now()}.heic`;
    const newName = origName.replace(/\.(heic|heif)$/i, '.jpg');

    return new File([jpegBlob], newName, {
      type: 'image/jpeg',
      lastModified: file.lastModified || Date.now()
    });
  } catch (err) {
    console.error('HEIC 转换失败:', err);
    showToast('HEIC 图片转换失败，尝试原样上传');
    return file;
  }
}

function confirmLargeImageUpload(fileOrCount, totalSizeMB = null) {
  return new Promise((resolve) => {
    if (!imageCompressModal || !imageCompressMsg || !imageCompressBtn || !imageOriginalBtn || !imageCancelBtn) {
      resolve('compress');
      return;
    }

    if (typeof fileOrCount === 'number') {
      imageCompressMsg.textContent = `检测到本次有 ${fileOrCount} 张图片较大（总计 ${totalSizeMB} MB），建议压缩后上传以大幅提升传输速度并节省带宽。`;
    } else {
      const sizeMB = (fileOrCount.size / (1024 * 1024)).toFixed(1);
      imageCompressMsg.textContent = `检测到当前图片较大（${sizeMB} MB），建议压缩后上传以大幅提升传输速度并节省带宽。`;
    }
    imageCompressModal.classList.remove('hidden');

    const cleanup = () => {
      imageCompressModal.classList.add('hidden');
      imageCompressBtn.removeEventListener('click', onCompress);
      imageOriginalBtn.removeEventListener('click', onOriginal);
      imageCancelBtn.removeEventListener('click', onCancel);
      imageCompressModal.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeyDown);
    };

    const onCompress = () => {
      cleanup();
      resolve('compress');
    };

    const onOriginal = () => {
      cleanup();
      resolve('original');
    };

    const onCancel = () => {
      cleanup();
      resolve('cancel');
    };

    const onBackdropClick = (e) => {
      if (e.target === imageCompressModal) {
        onCancel();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    imageCompressBtn.addEventListener('click', onCompress);
    imageOriginalBtn.addEventListener('click', onOriginal);
    imageCancelBtn.addEventListener('click', onCancel);
    imageCompressModal.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeyDown);
  });
}

async function handleSingleImageFile(file, preChoice = null) {
  const epoch = accountEpoch;
  if (!file || !isImageFile(file)) return;

  // 1. 如果图片 <= 3MB：100% 原始无损直传，完全不进行有损转码，确保极致清晰度
  if (file.size <= LARGE_IMAGE_THRESHOLD_BYTES) {
    queueUpload('image', {
      file: file,
      thumbnail: null
    });
    return;
  }

  // 2. 如果图片 > 3MB：
  // 若传入了预先确认的选择（preChoice），直接使用；否则单独询问
  const choice = preChoice || await confirmLargeImageUpload(file);
  if (choice === 'cancel') {
    return;
  }

  let mainBlob = file;
  if (choice === 'compress') {
    showToast('正在高清压缩图片...');
    // 保持高分辨率（最高 4K），画质 0.95 高清压缩至 3MB 以内
    mainBlob = await compressImageToBlob(file, HD_COMPRESS_MAX_EDGE, 0.95);
  }

  // 3. 为大图生成超清 1920px 缩略图（质量 0.92）
  const thumbnailBlob = await createThumbnailBlob(mainBlob);
  if (epoch !== accountEpoch || !isAuthenticated) return;

  // 4. 构造上传文件对象
  const origName = file.name || `image-${Date.now()}.png`;
  const ext = mainBlob.type === 'image/webp' ? '.webp' : (mainBlob.type === 'image/jpeg' ? '.jpg' : '.png');
  const mainFile = new File([mainBlob], origName.replace(/\.[^.]+$/, ext), {
    type: mainBlob.type || 'image/png'
  });
  const thumbFile = new File([thumbnailBlob], `thumb-${Date.now()}.webp`, {
    type: thumbnailBlob.type || 'image/webp'
  });

  queueUpload('image', {
    file: mainFile,
    thumbnail: thumbFile
  });
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  const name = file.name || '';
  const ext = name.split('.').pop().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif', 'svg', 'avif'].includes(ext);
}

async function handleImageFiles(files) {
  const epoch = accountEpoch;
  const fileArray = Array.from(files || []).filter((f) => isImageFile(f));
  if (fileArray.length === 0) return;

  // 第一步：若存在 HEIC 格式图片，执行无感转码
  const processedFiles = [];
  for (const file of fileArray) {
    const converted = await convertHeicToJpegIfNeeded(file);
    if (epoch !== accountEpoch || !isAuthenticated) return;
    processedFiles.push(converted);
  }

  // 第二步：统计超过 3MB 的大图
  const largeFiles = processedFiles.filter((f) => f.size > LARGE_IMAGE_THRESHOLD_BYTES);
  let batchChoice = null;

  if (largeFiles.length > 1) {
    const totalBytes = largeFiles.reduce((sum, f) => sum + f.size, 0);
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
    batchChoice = await confirmLargeImageUpload(largeFiles.length, totalMB);
    if (batchChoice === 'cancel') {
      return;
    }
  }

  // 第三步：逐个处理并加入上传队列
  for (const file of processedFiles) {
    if (epoch !== accountEpoch || !isAuthenticated) return;
    await handleSingleImageFile(file, batchChoice);
  }
}

async function handleFileUpload(files) {
  const epoch = accountEpoch;
  const fileArray = Array.from(files || []).filter(Boolean);
  const imageFiles = [];
  const normalFiles = [];

  for (const file of fileArray) {
    if (isImageFile(file)) {
      imageFiles.push(file);
    } else {
      normalFiles.push(file);
    }
  }

  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles);
  }

  for (const file of normalFiles) {
    if (epoch !== accountEpoch || !isAuthenticated) return;
    queueUpload('file', file);
  }
}

async function pasteImage() {
  try {
    const items = await navigator.clipboard.read();

    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) continue;

        const blob = await item.getType(type);
        // 将 Blob 转为 File 对象，添加默认文件名
        const file = new File([blob], `clipboard-${Date.now()}.png`, { type: blob.type || 'image/png' });
        await handleSingleImageFile(file);
        return;
      }
    }

    showToast('剪贴板中没有图片');
  } catch (error) {
    showToast('无法读取剪贴板图片');
    console.error(error);
  }
}

function autoResizeTextarea() {
  textInput.style.height = 'auto';
  textInput.style.height = `${Math.min(textInput.scrollHeight, 100)}px`;
}

authBtn.addEventListener('click', () => currentMode === 'accounts' ? verifyAccount() : verifyPassword(passwordInput.value));
passwordInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') currentMode === 'accounts' ? verifyAccount() : verifyPassword(passwordInput.value);
});
passwordInput.addEventListener('input', () => {
  authError.classList.add('hidden');
});

// 登录方式切换
if (passwordTab && emailCodeTab) {
  passwordTab.addEventListener('click', () => {
    if (currentLoginMethod === 'password') return;
    currentLoginMethod = 'password';
    passwordTab.classList.add('active');
    emailCodeTab.classList.remove('active');
    passwordLoginArea.classList.remove('hidden');
    emailCodeLoginArea.classList.add('hidden');
    authError.classList.add('hidden');
    emailCodeChallenge = null;
    authBtn.textContent = '登录';
  });

  emailCodeTab.addEventListener('click', () => {
    if (currentLoginMethod === 'email-code') return;
    currentLoginMethod = 'email-code';
    emailCodeTab.classList.add('active');
    passwordTab.classList.remove('active');
    emailCodeLoginArea.classList.remove('hidden');
    passwordLoginArea.classList.add('hidden');
    authError.classList.add('hidden');
    emailCodeChallenge = null;
    authBtn.textContent = '发送验证码';
  });
}

// 发送邮箱验证码
if (sendEmailCodeBtn) {
  sendEmailCodeBtn.addEventListener('click', async () => {
    const email = usernameInput?.value.trim();
    if (!email || !email.includes('@')) {
      emailCodeHint.textContent = '请输入有效的邮箱地址';
      emailCodeHint.style.color = 'var(--danger)';
      return;
    }

    sendEmailCodeBtn.disabled = true;
    emailCodeHint.textContent = '正在发送验证码...';
    emailCodeHint.style.color = 'var(--text-muted)';

    try {
      const response = await sessionFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email,
          loginMethod: 'email-code',
          ephemeral: document.getElementById('login-duration-select')?.value === 'ephemeral',
          deviceLabel: 'Browser'
        })
      });

      const data = await response.json();

      if (response.ok && data.requiresSecondFactor) {
        emailCodeChallenge = data.challenge;
        emailCodeHint.textContent = `验证码已发送至 ${data.emailHint || email}`;
        emailCodeHint.style.color = 'var(--success)';
        emailLoginCode.focus();
        emailCodeCountdown = 60;
        updateEmailCodeCountdown();
      } else {
        emailCodeHint.textContent = data.message || '发送失败，请稍后重试';
        emailCodeHint.style.color = 'var(--danger)';
        sendEmailCodeBtn.disabled = false;
      }
    } catch (error) {
      emailCodeHint.textContent = '网络错误，请检查连接';
      emailCodeHint.style.color = 'var(--danger)';
      sendEmailCodeBtn.disabled = false;
    }
  });
}

function updateEmailCodeCountdown() {
  if (emailCodeCountdown > 0) {
    sendEmailCodeBtn.textContent = `${emailCodeCountdown}s 后重发`;
    emailCodeCountdown--;
    emailCodeTimer = setTimeout(updateEmailCodeCountdown, 1000);
  } else {
    sendEmailCodeBtn.textContent = '发送验证码';
    sendEmailCodeBtn.disabled = false;
    if (emailCodeTimer) clearTimeout(emailCodeTimer);
  }
}

if (usernameInput) {
  usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && currentMode === 'accounts') {
      e.preventDefault();
      verifyAccount();
    }
  });
}

if (emailLoginCode) {
  emailLoginCode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && currentMode === 'accounts' && emailCodeChallenge) {
      e.preventDefault();
      verifyAccount();
    }
  });

  emailLoginCode.addEventListener('input', () => {
    authError.classList.add('hidden');
  });
}


if (limitDurationChk) {
  limitDurationChk.addEventListener('change', () => {
    loginDurationSelect.disabled = !limitDurationChk.checked;
  });
}

function setComposerDrawerOpen(open) {
  if (!composerArea) return;
  composerArea.classList.toggle('hidden', !open);
  if (toggleComposerBtn) {
    toggleComposerBtn.classList.toggle('active', open);
    toggleComposerBtn.setAttribute('aria-expanded', String(open));
  }
  if (open && textInput) {
    setTimeout(() => textInput.focus(), 20);
  }
}

if (toggleComposerBtn) {
  toggleComposerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = composerArea ? composerArea.classList.contains('hidden') : true;
    setComposerDrawerOpen(isHidden);
  });
}

if (closeComposerBtn) {
  closeComposerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setComposerDrawerOpen(false);
  });
}

sendTextBtn.addEventListener('click', () => {
  const value = textInput.value;
  if (!value || !value.trim()) return;
  sendMessage('text', value);
  if (sensitiveTextInput) sensitiveTextInput.checked = false;
  textInput.value = '';
  autoResizeTextarea();
  setComposerDrawerOpen(false);
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setComposerDrawerOpen(false);
  }
});

textInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextBtn.click();
  }
});

textInput.addEventListener('input', autoResizeTextarea);

// 全局粘贴监听器，实现免聚焦一键粘贴剪贴板内容（支持文本与截图直发，无需展开输入框）
document.addEventListener('paste', (e) => {
  if (!isAuthenticated) return;
  const activeEl = document.activeElement;
  const isInputActive = activeEl && (
    activeEl.tagName === 'INPUT' || 
    activeEl.tagName === 'TEXTAREA' || 
    activeEl.contentEditable === 'true'
  );

  const items = (e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData))?.items || [];
  
  // 无论是输入框内还是输入框外，只要粘贴的是图片/截图，优先转存上传
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        handleImageFiles([file]);
        return;
      }
    }
  }

  // 若焦点不在输入框内，按 Ctrl+V / Cmd+V 粘贴文本时直接静默保存为新卡片！
  if (!isInputActive) {
    for (const item of items) {
      if (item.type === 'text/plain') {
        item.getAsString((text) => {
          if (text && text.trim()) {
            sendMessage('text', text);
            showToast('已直接粘贴保存');
          }
        });
        e.preventDefault();
        break;
      }
    }
  }
});

if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllMessages);
if (logoutBtn) logoutBtn.addEventListener('click', () => logout(true));

tabs.forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function updateScrollBottomState() {
  const scrollTarget = workspaceScrollEl || messagesList;
  if (!scrollBottomBtn || !scrollTarget) return;
  const threshold = 180;
  const isNearTop = scrollTarget.scrollTop < threshold;
  if (isNearTop) {
    shouldStickToBottom = true;
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBtn.classList.remove('has-new');
    if (scrollBottomText) scrollBottomText.textContent = '回到最新';
  } else {
    shouldStickToBottom = false;
    scrollBottomBtn.classList.remove('hidden');
  }
}

if (workspaceScrollEl) {
  workspaceScrollEl.addEventListener('scroll', updateScrollBottomState);
} else if (messagesList) {
  messagesList.addEventListener('scroll', updateScrollBottomState);
}

if (scrollBottomBtn) {
  scrollBottomBtn.addEventListener('click', () => {
    const scrollTarget = workspaceScrollEl || messagesList;
    if (scrollTarget) {
      scrollTarget.scrollTo({ top: 0, behavior: 'smooth' });
    }
    scrollBottomBtn.classList.remove('has-new');
    if (scrollBottomText) scrollBottomText.textContent = '回到最新';
  });
}

socket.on('connect', () => {
  connectionStatus.textContent = '已连接';
  connectionStatus.className = 'status connected';
  if (!isAuthenticated) return;

  // 多用户模式下重连需要重新加入房间
  if (currentMode === 'multi' && userId) {
    socket.emit('join', userId);
  }

  refreshMessagesAfterReconnect();
});

socket.on('session-revoked', () => {
  if (currentMode !== 'accounts') return;
  const op = pendingSelfSecurityOp;
  const expected = op && op.revokedEpoch == null && op.epoch === accountEpoch && op.userId === accountUser?.id && op.generation === securityGeneration;
  logout(false, false, false, Boolean(expected));
});
socket.on('disconnect', () => {
  connectionStatus.textContent = '已断开';
  connectionStatus.className = 'status disconnected';
});

socket.on('sync', (data) => {
  if (!isAuthenticated) return;
  if (initialLoaded) return;
  if (!Array.isArray(data.messages)) return;

  messages = data.messages;
  hasMoreMessages = Boolean(data.hasMore);
  renderMessages({ scrollBottom: true });
});

socket.on('message-new', (msg) => {
  if (!isAuthenticated) return;

  // 检查消息是否已存在（避免重复添加自己发送的消息）
  const exists = messages.some((m) => m.id === msg.id);
  if (exists) return;

  messages.push(msg);
  appendSingleMessage(msg);
  showToast('收到新消息');

  if (!shouldStickToBottom && scrollBottomBtn) {
    scrollBottomBtn.classList.remove('hidden');
    scrollBottomBtn.classList.add('has-new');
    if (scrollBottomText) scrollBottomText.textContent = '有新记录 ↑';
  }
});

socket.on('message-delete', (id) => {
  if (!isAuthenticated) return;
  if (currentViewerTextMsg?.id === id) clearSensitiveViewerState();
  removeSingleMessage(id);
});
socket.on('message-sensitive', (msg) => {
  if (!isAuthenticated || !msg?.id) return;
  sensitiveViewerState.delete(msg.id);
  if (currentViewerTextMsg?.id === msg.id) closeTextViewer();
  const update = item => item.id === msg.id ? { ...item, ...msg, content: null, remark: '' } : item;
  messages = messages.map(update); favorites = favorites.map(update);
  renderMessages(); if (currentTab === 'favorites') renderFavorites();
});


socket.on('message-private', (msg) => {
  if (!isAuthenticated || !msg?.id || typeof msg.private !== 'boolean') return;
  if (!msg.private) privateCardUnlockExpiresAt.delete(msg.id);
  const update = item => item.id === msg.id ? { ...item, ...msg, private: msg.private } : item;
  messages = messages.map(update); favorites = favorites.map(update);
  if (Array.isArray(searchState.results)) searchState.results = searchState.results.map(update);
  renderMessages(); if (currentTab === 'favorites') renderFavorites();
  if (searchState.active) renderSearchResults();
});

socket.on('messages-clear', (data) => {
  if (!isAuthenticated) return;
  // 只清空非收藏消息，保留收藏消息
  messages = messages.filter((m) => m.favorite);
  hasMoreMessages = false;
  renderMessages();
  if (currentTab === 'favorites') {
    renderFavorites();
  }
  // 搜索态下同步失效缓存并重跑当前搜索，避免展示已被清空的记录
  if (searchState.active && searchInput && searchInput.value.trim()) {
    searchState.cache.clear();
    performSearch({ force: true });
  }
  if (data && data.favoriteCount > 0) {
    showToast(`已清空，保留 ${data.favoriteCount} 条收藏`);
  }
});

socket.on('message-favorite', (data) => {
  if (!isAuthenticated) return;
  const { id, favorite, message } = data;

  // 更新 messages 中的消息
  const msgIndex = messages.findIndex((m) => m.id === id);
  if (msgIndex !== -1) {
    messages[msgIndex].favorite = favorite;
  }

  // 更新 favorites 列表
  if (favorite) {
    const favMsg = message || messages.find((m) => m.id === id);
    if (favMsg && !favorites.find((f) => f.id === id)) {
      favorites.push(favMsg);
    }
  } else {
    favorites = favorites.filter((f) => f.id !== id);
  }

  updateSingleMessageFavorite(id, favorite);
  updateFavoritesBadge();
});

socket.on('message-remark', (data) => {
  if (!isAuthenticated || !data) return;
  const { id, remark } = data;
  updateSingleMessageRemark(id, remark);
  renderCategoryChips();
});

socket.on('message-title', (data) => {
  if (!isAuthenticated || !data) return;
  const { id, title } = data;
  updateSingleMessageTitle(id, title);
  renderCategoryChips();
});

// ========== 分类标题编辑弹窗 ==========
const titleModal = document.getElementById('title-modal');
const titleCancelBtn = document.getElementById('title-cancel-btn');
const titleClearBtn = document.getElementById('title-clear-btn');
const groupPickerList = document.getElementById('group-picker-list');
const groupPickerNewInput = document.getElementById('group-picker-new-input');
const groupPickerAddBtn = document.getElementById('group-picker-add-btn');
const groupsManagerModal = document.getElementById('groups-manager-modal');
const groupsManagerClose = document.getElementById('groups-manager-close');
const groupsManagerList = document.getElementById('groups-manager-list');
const groupsManagerNewInput = document.getElementById('groups-manager-new-input');
const groupsManagerAddBtn = document.getElementById('groups-manager-add-btn');
const titleModalManageBtn = document.getElementById('title-modal-manage-btn');
const titleModalCloseBtn = document.getElementById('title-modal-close');

let currentTitleMessage = null;
let previousTitleMessageForManager = null;
let userGroups = []; // 从服务端加载的分组列表

async function loadGroups() {
  try {
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) params.set('userId', userId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const r = await authFetch(`/api/messages/groups${qs}`);
    if (r.ok) { const d = await r.json(); userGroups = d.groups || []; renderCategoryChips(); }
  } catch {}
}

function openTitleModal(msg) {
  currentTitleMessage = msg;
  if (!titleModal) return;
  if (titleClearBtn) titleClearBtn.classList.toggle('hidden', !msg.title);
  if (groupPickerNewInput) groupPickerNewInput.value = '';
  renderGroupPickerList(msg.title || '');
  titleModal.classList.remove('hidden');
  setTimeout(() => { groupPickerNewInput?.focus(); }, 50);
}

function renderGroupPickerList(selectedTitle) {
  if (!groupPickerList) return;
  groupPickerList.innerHTML = '';
  const allGroupNames = [...new Set([
    ...userGroups,
    ...[...messages, ...favorites].map(m => (typeof m?.title === 'string' ? m.title.trim() : '')).filter(Boolean)
  ])];
  if (allGroupNames.length === 0) {
    groupPickerList.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;padding:8px 0;margin:0">暂无分组，在下方新建一个</p>';
    return;
  }
  allGroupNames.forEach(name => {
    const { dot } = remarkToColor(name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-picker-item' + (name === selectedTitle ? ' active' : '');
    btn.innerHTML = `<span class="group-picker-dot" style="background:${dot}"></span><span class="group-picker-name">${escapeHTML(name)}</span>`;
    btn.addEventListener('click', async () => {
      if (!currentTitleMessage) return;
      const newTitle = name === currentTitleMessage.title ? '' : name;
      await applyTitle(currentTitleMessage.id, newTitle);
    });
    groupPickerList.appendChild(btn);
  });
}

async function applyTitle(msgId, title) {
  try {
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) params.set('userId', userId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const r = await authFetch(`/api/messages/${encodeURIComponent(msgId)}/title${qs}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
    });
    if (!r.ok) { showToast('设置失败'); return; }
    const d = await r.json().catch(() => ({}));
    if (Array.isArray(d.groups)) userGroups = d.groups;
    else if (title && !userGroups.includes(title)) userGroups.push(title);
    updateSingleMessageTitle(msgId, title);
    closeTitleModal();
    showToast(title ? `已归入 ${title}` : '已移出分组');
  } catch { showToast('操作失败，请重试'); }
}

function closeTitleModal() {
  titleModal?.classList.add('hidden');
  currentTitleMessage = null;
}

groupPickerAddBtn?.addEventListener('click', async () => {
  const name = groupPickerNewInput?.value.trim();
  if (!name) {
    showToast('请输入分组名称');
    groupPickerNewInput?.focus();
    return;
  }
  const ok = await addGroup(name);
  if (!ok) return;
  if (groupPickerNewInput) groupPickerNewInput.value = '';
  if (currentTitleMessage) {
    await applyTitle(currentTitleMessage.id, name);
  } else {
    renderGroupPickerList('');
  }
});

groupPickerNewInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); groupPickerAddBtn?.click(); }
});

titleClearBtn?.addEventListener('click', async () => {
  if (!currentTitleMessage) return;
  await applyTitle(currentTitleMessage.id, '');
});
titleCancelBtn?.addEventListener('click', closeTitleModal);
titleModalCloseBtn?.addEventListener('click', closeTitleModal);
titleModal?.addEventListener('click', (e) => { if (e.target === titleModal) closeTitleModal(); });
titleModalManageBtn?.addEventListener('click', () => {
  previousTitleMessageForManager = currentTitleMessage;
  closeTitleModal();
  openGroupsManager();
});

// ========== 分组管理面板 ==========
function openGroupsManager() {
  if (!groupsManagerModal) return;
  renderGroupsManagerList();
  if (groupsManagerNewInput) groupsManagerNewInput.value = '';
  groupsManagerModal.classList.remove('hidden');
  setTimeout(() => { groupsManagerNewInput?.focus(); }, 50);
}

function closeGroupsManager() {
  groupsManagerModal?.classList.add('hidden');
  if (previousTitleMessageForManager) {
    const msg = messages.find(m => m.id === previousTitleMessageForManager.id) || previousTitleMessageForManager;
    previousTitleMessageForManager = null;
    openTitleModal(msg);
  }
}

function renderGroupsManagerList() {
  if (!groupsManagerList) return;
  groupsManagerList.innerHTML = '';
  const allGroupNames = [...new Set([
    ...userGroups,
    ...[...messages, ...favorites].map(m => (typeof m?.title === 'string' ? m.title.trim() : '')).filter(Boolean)
  ])];
  if (allGroupNames.length === 0) {
    groupsManagerList.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;padding:8px 0;margin:0">暂无分组</p>';
    return;
  }
  allGroupNames.forEach(name => {
    const { dot } = remarkToColor(name);
    const row = document.createElement('div');
    row.className = 'groups-manager-row';
    row.innerHTML = `
      <span class="group-picker-dot" style="background:${dot}"></span>
      <span class="groups-manager-name">${escapeHTML(name)}</span>
      <button type="button" class="btn groups-manager-delete-btn" title="删除分组" aria-label="删除 ${escapeHTML(name)}">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v6"></path><path d="M14 11v6"></path>
          <path d="M9 6V4h6v2"></path>
        </svg>
      </button>
    `;
    row.querySelector('.groups-manager-delete-btn').addEventListener('click', async () => {
      await deleteGroup(name);
      renderGroupsManagerList();
    });
    groupsManagerList.appendChild(row);
  });
}

async function addGroup(name) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 30) : '';
  if (!cleanName) {
    showToast('分组名不能为空');
    return false;
  }
  try {
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) params.set('userId', userId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const r = await authFetch(`/api/messages/groups${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName })
    });
    if (r.ok) {
      const d = await r.json();
      userGroups = Array.isArray(d.groups) ? d.groups : [...new Set([...userGroups, cleanName])];
      renderCategoryChips();
      return true;
    }
    const d = await r.json().catch(() => ({}));
    showToast(d.code === 'INVALID_NAME' ? '分组名不能为空' : '新建失败');
    return false;
  } catch {
    showToast('操作失败，请重试');
    return false;
  }
}

async function deleteGroup(name) {
  try {
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) params.set('userId', userId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const r = await authFetch(`/api/messages/groups/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
    if (r.ok) {
      const d = await r.json();
      userGroups = d.groups || [];
      messages.forEach(m => { if (m.title === name) delete m.title; });
      favorites.forEach(f => { if (f.title === name) delete f.title; });
      if (currentCategoryFilter === name) { currentCategoryFilter = null; }
      renderMessages();
      renderCategoryChips();
    }
    else showToast('删除失败');
  } catch { showToast('操作失败，请重试'); }
}

groupsManagerAddBtn?.addEventListener('click', async () => {
  const name = groupsManagerNewInput?.value.trim();
  if (!name) {
    showToast('请输入分组名称');
    groupsManagerNewInput?.focus();
    return;
  }
  const ok = await addGroup(name);
  if (!ok) return;
  if (groupsManagerNewInput) groupsManagerNewInput.value = '';
  renderGroupsManagerList();
  showToast(`已新建分组 ${name}`);
});
groupsManagerNewInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); groupsManagerAddBtn?.click(); } });
groupsManagerClose?.addEventListener('click', closeGroupsManager);
groupsManagerModal?.addEventListener('click', (e) => { if (e.target === groupsManagerModal) closeGroupsManager(); });

socket.on('groups-update', (data) => {
  if (!isAuthenticated || !data?.groups) return;
  userGroups = data.groups;
  renderCategoryChips();
});

// ========== 隐私卡片解锁弹窗 ==========
const privateUnlockModal = document.getElementById('private-unlock-modal');
const privateUnlockClose = document.getElementById('private-unlock-close');
const privateUnlockCancel = document.getElementById('private-unlock-cancel');
const privateUnlockConfirm = document.getElementById('private-unlock-confirm');
const privateUnlockSendBtn = document.getElementById('private-unlock-send-btn');
const privateUnlockCodeInput = document.getElementById('private-unlock-code-input');
const privateUnlockDesc = document.getElementById('private-unlock-desc');
const privateUnlockHint = document.getElementById('private-unlock-hint');
const privateUnlockScopeRow = document.getElementById('private-unlock-scope-row');
const privateUnlockDurationRow = document.getElementById('private-unlock-duration-row');
const privateCustomDuration = document.getElementById('private-custom-duration');
const privateCustomPresets = document.getElementById('private-custom-presets');
const privateCustomHours = document.getElementById('private-custom-hours');
const privateCustomStepDown = document.getElementById('private-custom-step-down');
const privateCustomStepUp = document.getElementById('private-custom-step-up');
const privateUnlockModeBanner = document.getElementById('private-unlock-mode-banner');
const privateUnlockModeNote = document.getElementById('private-unlock-mode-note');

let privateUnlockMessageId = null;
let privateUnlockChallenge = null;
let privateUnlockSelection = null;
let privateUnlockCountdownTimer = null;

function normalizeCustomHoursText(rawValue) {
  let value = String(rawValue ?? '').replace(/[^0-9.]/g, '');
  const dot = value.indexOf('.');
  if (dot >= 0) value = `${value.slice(0, dot + 1)}${value.slice(dot + 1).replace(/\./g, '').slice(0, 1)}`;
  const parts = value.split('.');
  value = parts[0].slice(0, 3) + (parts.length > 1 ? `.${parts[1]}` : '');
  return value;
}

function syncCustomPresetActive(hoursStr) {
  const num = Number(hoursStr);
  privateCustomPresets?.querySelectorAll('.private-custom-preset-chip').forEach(chip => {
    chip.classList.toggle('active', Number.isFinite(num) && num > 0 && Number(chip.dataset.hours) === num);
  });
}

function setCustomHoursValue(hoursVal) {
  if (!privateCustomHours) return;
  const num = Math.min(168, Math.max(0.5, Math.round(Number(hoursVal) * 2) / 2));
  const formatted = Number.isInteger(num) ? String(num) : num.toFixed(1);
  privateCustomHours.value = formatted;
  syncCustomPresetActive(formatted);
  updatePrivateUnlockModeNote();
}

function readPrivateUnlockSelection() {
  const scope = privateUnlockScopeRow?.querySelector('input[name="private-unlock-scope"]:checked')?.value;
  const duration = privateUnlockDurationRow?.querySelector('.private-duration-btn.active')?.dataset.duration;
  if (!['current', 'all'].includes(scope) || !['600', '1800', 'custom', 'permanent'].includes(duration)) return null;
  if (scope === 'current' && !privateUnlockMessageId) return null;
  const selection = { scope, ...(scope === 'current' ? { messageId: privateUnlockMessageId } : {}), duration };
  if (duration === 'custom') {
    const hours = privateCustomHours?.value.trim() || '';
    if (!/^\d{1,3}(?:\.\d)?$/.test(hours) || Number(hours) <= 0 || Number(hours) > 168) return null;
    selection.hours = hours;
  }
  return selection;
}
function updatePrivateUnlockModeNote() {
  const selection = readPrivateUnlockSelection();
  const duration = privateUnlockDurationRow?.querySelector('.private-duration-btn.active')?.dataset.duration;
  privateCustomDuration?.classList.toggle('hidden', duration !== 'custom');
  const isPermanent = duration === 'permanent';
  privateUnlockModeBanner?.classList.toggle('hidden', !isPermanent);
  if (!privateUnlockModeNote) return;
  if (isPermanent) {
    privateUnlockModeNote.textContent = selection?.scope === 'current'
      ? '验证并确认后，将永久移除当前卡片的隐私锁定标记。'
      : '验证并确认后，将永久移除当前用户全部现有隐私卡片的锁定标记。';
  } else {
    privateUnlockModeNote.textContent = '';
  }
}
function setPrivateUnlockOptionsDisabled(disabled) {
  privateUnlockScopeRow?.querySelectorAll('input').forEach(input => { input.disabled = disabled || (input.value === 'current' && !privateUnlockMessageId); });
  privateUnlockDurationRow?.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
  privateCustomPresets?.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
  if (privateCustomHours) privateCustomHours.disabled = disabled;
  if (privateCustomStepDown) privateCustomStepDown.disabled = disabled;
  if (privateCustomStepUp) privateCustomStepUp.disabled = disabled;
}
function openPrivateUnlockModal(messageId = null) {
  privateUnlockMessageId = typeof messageId === 'string' && messageId ? messageId : null;
  privateUnlockChallenge = null;
  privateUnlockSelection = null;
  privateUnlockScopeRow?.querySelectorAll('input[name="private-unlock-scope"]').forEach(input => { input.checked = input.value === (privateUnlockMessageId ? 'current' : 'all'); });
  privateUnlockDurationRow?.querySelectorAll('.private-duration-btn').forEach(button => { button.classList.toggle('active', button.dataset.duration === '600'); });
  if (privateCustomHours) { privateCustomHours.value = '1'; privateCustomHours.disabled = false; }
  syncCustomPresetActive('1');
  if (privateUnlockCodeInput) privateUnlockCodeInput.value = '';
  if (privateUnlockConfirm) { privateUnlockConfirm.disabled = true; privateUnlockConfirm.classList.add('hidden'); }
  if (privateUnlockHint) { privateUnlockHint.textContent = ''; privateUnlockHint.classList.add('hidden'); privateUnlockHint.classList.remove('is-error'); }
  if (privateUnlockSendBtn) { privateUnlockSendBtn.disabled = false; privateUnlockSendBtn.textContent = '发送验证码'; }
  if (privateUnlockDesc) privateUnlockDesc.textContent = '发送验证码到绑定邮箱，验证后按所选范围与时长解锁。';
  setPrivateUnlockOptionsDisabled(false);
  updatePrivateUnlockModeNote();
  clearInterval(privateUnlockCountdownTimer);
  privateUnlockModal?.classList.remove('hidden');
  setTimeout(() => privateUnlockSendBtn?.focus(), 50);
}
function closePrivateUnlockModal() {
  privateUnlockModal?.classList.add('hidden');
  privateUnlockMessageId = null;
  privateUnlockChallenge = null;
  privateUnlockSelection = null;
  setPrivateUnlockOptionsDisabled(false);
  clearInterval(privateUnlockCountdownTimer);
}
function startPrivateUnlockCountdown() {
  let remaining = 60;
  if (privateUnlockSendBtn) { privateUnlockSendBtn.disabled = true; privateUnlockSendBtn.textContent = `${remaining}s`; }
  clearInterval(privateUnlockCountdownTimer);
  privateUnlockCountdownTimer = setInterval(() => {
    remaining--;
    if (privateUnlockSendBtn) privateUnlockSendBtn.textContent = `${remaining}s`;
    if (remaining <= 0) { clearInterval(privateUnlockCountdownTimer); if (privateUnlockSendBtn) { privateUnlockSendBtn.disabled = false; privateUnlockSendBtn.textContent = '重新发送'; } }
  }, 1000);
}
privateUnlockScopeRow?.addEventListener('change', updatePrivateUnlockModeNote);
privateUnlockDurationRow?.addEventListener('click', event => {
  const button = event.target.closest('.private-duration-btn');
  if (!button || button.disabled) return;
  privateUnlockDurationRow.querySelectorAll('.private-duration-btn').forEach(item => item.classList.toggle('active', item === button));
  if (button.dataset.duration === 'custom' && privateCustomHours && !privateCustomHours.value.trim()) {
    privateCustomHours.value = '1';
    syncCustomPresetActive('1');
  }
  updatePrivateUnlockModeNote();
});
privateCustomPresets?.addEventListener('click', event => {
  const chip = event.target.closest('.private-custom-preset-chip');
  if (!chip || chip.disabled) return;
  const hours = chip.dataset.hours;
  if (privateCustomHours && hours) {
    privateCustomHours.value = hours;
    syncCustomPresetActive(hours);
    updatePrivateUnlockModeNote();
  }
});
privateCustomStepDown?.addEventListener('click', () => {
  if (privateCustomStepDown.disabled) return;
  const current = Number(privateCustomHours?.value) || 1;
  const step = current <= 2 ? 0.5 : (current <= 24 ? 1 : 6);
  setCustomHoursValue(Math.max(0.5, current - step));
});
privateCustomStepUp?.addEventListener('click', () => {
  if (privateCustomStepUp.disabled) return;
  const current = Number(privateCustomHours?.value) || 1;
  const step = current < 2 ? 0.5 : (current < 24 ? 1 : 6);
  setCustomHoursValue(Math.min(168, current + step));
});
privateCustomHours?.addEventListener('input', () => {
  const value = normalizeCustomHoursText(privateCustomHours.value);
  if (privateCustomHours.value !== value) privateCustomHours.value = value;
  syncCustomPresetActive(value);
  updatePrivateUnlockModeNote();
});
privateCustomHours?.addEventListener('blur', () => {
  const raw = privateCustomHours.value.trim();
  const num = Number(raw);
  if (!raw || !Number.isFinite(num) || num <= 0) {
    privateCustomHours.value = '1';
  } else if (num > 168) {
    privateCustomHours.value = '168';
  } else {
    const rounded = Math.round(num * 10) / 10;
    privateCustomHours.value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }
  syncCustomPresetActive(privateCustomHours.value);
  updatePrivateUnlockModeNote();
});

privateUnlockSendBtn?.addEventListener('click', async () => {
  const selection = readPrivateUnlockSelection();
  if (!selection) {
    if (privateUnlockHint) { privateUnlockHint.textContent = '请选择有效范围和时长（自定义时长为 0.1 至 168 小时，最多一位小数）'; privateUnlockHint.classList.remove('hidden'); privateUnlockHint.classList.add('is-error'); }
    return;
  }
  try {
    privateUnlockSendBtn.disabled = true;
    if (privateUnlockHint) { privateUnlockHint.classList.add('hidden'); privateUnlockHint.classList.remove('is-error'); }
    const response = await authFetch('/api/auth/email/private-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'private', ...selection }) });
    const data = await response.json();
    if (!response.ok) {
      if (privateUnlockHint) { privateUnlockHint.textContent = data.code === 'MAIL_UNAVAILABLE' ? '邮件服务暂不可用' : data.code === 'AUTH_RATE_LIMIT' ? '发送过于频繁，请稍后再试' : data.code === 'INVALID_PRIVATE_UNLOCK' ? '范围或时长无效' : '发送失败，请重试'; privateUnlockHint.classList.remove('hidden'); privateUnlockHint.classList.add('is-error'); }
      privateUnlockSendBtn.disabled = false;
      return;
    }
    privateUnlockChallenge = data.challenge;
    privateUnlockSelection = selection;
    setPrivateUnlockOptionsDisabled(true);
    if (privateUnlockDesc) privateUnlockDesc.textContent = `验证码已发送至 ${data.emailHint || '绑定邮箱'}，5 分钟内有效`;
    startPrivateUnlockCountdown();
    privateUnlockCodeInput?.focus();
  } catch {
    if (privateUnlockHint) { privateUnlockHint.textContent = '发送失败，请重试'; privateUnlockHint.classList.remove('hidden'); privateUnlockHint.classList.add('is-error'); }
    if (privateUnlockSendBtn) privateUnlockSendBtn.disabled = false;
  }
});

privateUnlockCodeInput?.addEventListener('input', () => {
  const value = privateUnlockCodeInput.value.replace(/\D/g, '').slice(0, 6);
  if (privateUnlockCodeInput.value !== value) privateUnlockCodeInput.value = value;
  if (privateUnlockConfirm) {
    privateUnlockConfirm.disabled = !(privateUnlockChallenge && value.length === 6);
    privateUnlockConfirm.classList.toggle('hidden', value.length < 6);
  }
  if (privateUnlockChallenge && value.length === 6) setTimeout(() => privateUnlockConfirm?.click(), 80);
});

privateUnlockConfirm?.addEventListener('click', async () => {
  if (!privateUnlockChallenge || !privateUnlockSelection) return;
  const code = privateUnlockCodeInput?.value.trim();
  if (!code || code.length !== 6) return;
  const selection = privateUnlockSelection;
  if (selection.duration === 'permanent') {
    const scopeLabel = selection.scope === 'current' ? '当前卡片' : '当前用户全部现有 private 卡片';
    if (!window.confirm(`永久解锁将移除${scopeLabel}的 private 标记，刷新后也不会重新加锁。继续吗？`)) { privateUnlockConfirm.disabled = false; return; }
  }
  try {
    privateUnlockConfirm.disabled = true;
    const response = await authFetch('/api/messages/private/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: privateUnlockChallenge, code, ...selection }) });
    const data = await response.json();
    if (!response.ok) {
      if (privateUnlockHint) { privateUnlockHint.textContent = data.code === 'AUTH_FAILED' ? '验证码错误或已过期' : data.code === 'CODE_REQUIRED' ? '请先发送验证码' : data.code === 'INVALID_PRIVATE_UNLOCK' ? '范围或时长无效' : '验证失败，请重试'; privateUnlockHint.classList.remove('hidden'); privateUnlockHint.classList.add('is-error'); }
      privateUnlockConfirm.disabled = false;
      privateUnlockConfirm.classList.remove('hidden');
      return;
    }
    if (data.permanent) {
      const updated = new Set(data.updatedIds || []);
      const unmark = message => updated.has(message.id) ? { ...message, private: false } : message;
      messages = messages.map(unmark); favorites = favorites.map(unmark);
      if (Array.isArray(searchState.results)) searchState.results = searchState.results.map(unmark);
      for (const id of updated) privateCardUnlockExpiresAt.delete(id);
      showToast(`已永久解除 ${updated.size} 张卡片的 private 标记`);
    } else {
      if (!applyPrivateUnlock(data.scope, data.messageId, data.expiresAt)) { showToast('解锁授权已过期，请重试'); return; }
      const durationLabel = selection.duration === '600' ? '10 分钟' : selection.duration === '1800' ? '30 分钟' : `${selection.hours} 小时`;
      showToast(`${selection.scope === 'current' ? '当前卡片' : '全部 private 卡片'}已解锁 ${durationLabel}`);
    }
    closePrivateUnlockModal();
    renderMessages();
    if (currentTab === 'favorites') renderFavorites();
    if (searchState.active) renderSearchResults();
  } catch {
    if (privateUnlockHint) { privateUnlockHint.textContent = '操作失败，请重试'; privateUnlockHint.classList.remove('hidden'); privateUnlockHint.classList.add('is-error'); }
    if (privateUnlockConfirm) privateUnlockConfirm.disabled = false;
  }
});

privateUnlockClose?.addEventListener('click', closePrivateUnlockModal);
privateUnlockCancel?.addEventListener('click', closePrivateUnlockModal);
privateUnlockModal?.addEventListener('click', (e) => {
  if (e.target === privateUnlockModal || e.target.classList.contains('private-unlock-backdrop')) {
    closePrivateUnlockModal();
  }
});

// 全窗口拖拽上传支持
let dragCounter = 0;

function handleDragEnter(e) {
  if (!isAuthenticated) return;
  if (e.dataTransfer && e.dataTransfer.types && !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  if (dropOverlay) dropOverlay.classList.remove('hidden');
  if (dropZone) dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
  if (!isAuthenticated) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    if (dropOverlay) dropOverlay.classList.add('hidden');
    if (dropZone) dropZone.classList.remove('drag-over');
  }
}

function handleDragOver(e) {
  if (!isAuthenticated) return;
  if (e.dataTransfer && e.dataTransfer.types && !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
}

async function handleDrop(e) {
  if (!isAuthenticated) return;
  e.preventDefault();
  dragCounter = 0;
  if (dropOverlay) dropOverlay.classList.add('hidden');
  if (dropZone) dropZone.classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files || []);
  if (files.length === 0) return;

  // 分离图片和普通文件
  const imageFiles = [];
  const otherFiles = [];

  for (const file of files) {
    if (isImageFile(file)) {
      imageFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  }

  // 处理图片
  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles);
  }

  // 非图片文件提示不支持附件
  if (otherFiles.length > 0) {
    showToast('本项目为纯剪贴板，仅支持文字与图片截图同步，不支持普通文件附件');
  }
}

window.addEventListener('dragenter', handleDragEnter);
window.addEventListener('dragleave', handleDragLeave);
window.addEventListener('dragover', handleDragOver);
window.addEventListener('drop', handleDrop);

// 版本号在进入聊天界面（登录成功后）由 enterChatMode() 触发加载
checkAuth();

// ========== 图片查看器（支持滚轮自由缩放 + 拖拽平移 + 极简顶栏复制） ==========
const imageViewer = document.getElementById('image-viewer');
const imageViewerImg = document.getElementById('image-viewer-img');
const imageViewerTitle = document.getElementById('image-viewer-title');
const imageViewerZoomBadge = document.getElementById('image-viewer-zoom-badge');
const imageViewerStage = document.getElementById('image-viewer-stage');
const imageViewerOriginalBtn = document.getElementById('image-viewer-original');
const imageViewerCopyBtn = document.getElementById('image-viewer-copy');
const imageViewerBackdrop = imageViewer ? imageViewer.querySelector('.image-viewer-backdrop') : null;
const imageViewerCloseBtn = imageViewer ? imageViewer.querySelector('.image-viewer-close') : null;

let currentViewerMessage = null;
let isViewingOriginal = false;
let imgZoomScale = 1;
let imgPanX = 0;
let imgPanY = 0;
let isDraggingImg = false;
let dragStartX = 0;
let dragStartY = 0;

function updateImageZoomTransform() {
  if (!imageViewerImg) return;
  imageViewerImg.style.transform = `translate3d(${imgPanX}px, ${imgPanY}px, 0) scale(${imgZoomScale})`;
  if (imageViewerZoomBadge) {
    imageViewerZoomBadge.textContent = `${Math.round(imgZoomScale * 100)}%`;
  }
}

function resetImageZoom() {
  imgZoomScale = 1;
  imgPanX = 0;
  imgPanY = 0;
  updateImageZoomTransform();
}

function exitViewerRemarkEdit(prefix) {
  const barEl = document.getElementById(`${prefix}-remark-bar`);
  const textEl = document.getElementById(`${prefix}-remark-text`);
  const btnEl = document.getElementById(`${prefix}-remark-btn`);
  const editorEl = document.getElementById(`${prefix}-remark-editor`);
  barEl?.classList.remove('is-editing');
  textEl?.classList.remove('hidden');
  btnEl?.classList.remove('hidden');
  editorEl?.classList.add('hidden');
}

function enterViewerRemarkEdit(prefix, msg) {
  if (!msg) return;
  const barEl = document.getElementById(`${prefix}-remark-bar`);
  const textEl = document.getElementById(`${prefix}-remark-text`);
  const btnEl = document.getElementById(`${prefix}-remark-btn`);
  const editorEl = document.getElementById(`${prefix}-remark-editor`);
  const inputEl = document.getElementById(`${prefix}-remark-input`);
  if (!editorEl || !inputEl) return;

  barEl?.classList.add('is-editing');
  textEl?.classList.add('hidden');
  btnEl?.classList.add('hidden');
  editorEl.classList.remove('hidden');
  inputEl.value = typeof msg.remark === 'string' ? msg.remark : '';
  setTimeout(() => {
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }, 20);
}

async function saveViewerInlineRemark(prefix, msg) {
  if (!msg) return;
  const inputEl = document.getElementById(`${prefix}-remark-input`);
  const saveBtnEl = document.getElementById(`${prefix}-remark-save`);
  if (!inputEl) return;

  const remarkToSave = inputEl.value.trim();
  try {
    if (saveBtnEl) {
      saveBtnEl.disabled = true;
      saveBtnEl.textContent = '保存中...';
    }
    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const headers = { 'Content-Type': 'application/json' };
    if (msg.sensitive) {
      const credentials = await sensitiveCredentials('请输入密码以修改敏感文本备注');
      if (!credentials) return;
      const reauth = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/sensitive/reauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remark', ...credentials })
      });
      if (!reauth.ok) throw new Error('敏感文本验证失败');
      const grant = await reauth.json();
      headers['X-Sensitive-Grant'] = grant.token;
    }

    const res = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/remark${qs}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ remark: remarkToSave })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '保存备注失败');
    }

    msg.remark = remarkToSave;
    exitViewerRemarkEdit(prefix);
    updateSingleMessageRemark(msg.id, remarkToSave);
    renderCategoryChips();
    showToast(remarkToSave ? '备注已保存' : '备注已清除');
  } catch (error) {
    console.error('保存备注错误:', error);
    showToast(error.message || '保存备注失败');
  } finally {
    if (saveBtnEl) {
      saveBtnEl.disabled = false;
      saveBtnEl.textContent = '保存';
    }
  }
}

function renderViewerRemarkBar(prefix, msg) {
  const textEl = document.getElementById(`${prefix}-remark-text`);
  const btnEl = document.getElementById(`${prefix}-remark-btn`);
  const inputEl = document.getElementById(`${prefix}-remark-input`);
  const saveBtnEl = document.getElementById(`${prefix}-remark-save`);
  const cancelBtnEl = document.getElementById(`${prefix}-remark-cancel`);
  const remark = typeof msg?.remark === 'string' ? msg.remark.trim() : '';

  exitViewerRemarkEdit(prefix);

  if (textEl) {
    textEl.textContent = remark || '暂无备注说明';
    textEl.classList.toggle('is-empty', !remark);
    textEl.title = '点击直接编辑备注';
    textEl.onclick = () => { if (msg) enterViewerRemarkEdit(prefix, msg); };
  }
  if (btnEl) {
    btnEl.textContent = remark ? '编辑备注' : '+ 添加备注';
    btnEl.onclick = () => { if (msg) enterViewerRemarkEdit(prefix, msg); };
  }
  if (saveBtnEl) {
    saveBtnEl.onclick = () => { if (msg) saveViewerInlineRemark(prefix, msg); };
  }
  if (cancelBtnEl) {
    cancelBtnEl.onclick = () => { exitViewerRemarkEdit(prefix); };
  }
  if (inputEl) {
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        if (msg) saveViewerInlineRemark(prefix, msg);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitViewerRemarkEdit(prefix);
      }
    };
  }
}

function syncActiveViewerRemark(id, remark) {
  if (currentViewerMessage && currentViewerMessage.id === id) {
    currentViewerMessage.remark = remark;
    renderViewerRemarkBar('image-viewer', currentViewerMessage);
  }
  if (currentViewerTextMsg && currentViewerTextMsg.id === id) {
    currentViewerTextMsg.remark = remark;
    renderViewerRemarkBar('text-viewer', currentViewerTextMsg);
  }
  if (currentViewerFileMsg && currentViewerFileMsg.id === id) {
    currentViewerFileMsg.remark = remark;
    renderViewerRemarkBar('file-viewer', currentViewerFileMsg);
  }
}

function openImageViewer(msg) {
  currentViewerMessage = msg;
  isViewingOriginal = false;
  resetImageZoom();

  const imageData = getImageContent(msg.content);
  if (imageViewerTitle) {
    imageViewerTitle.textContent = msg.title ? `图片 · ${msg.title}` : '图片';
  }
  renderViewerRemarkBar('image-viewer', msg);

  // 显示缩略图
  imageViewerImg.src = imageData.thumbnail;

  // 如果有原图，显示原图按钮（需用户手动点击后加载）
  if (imageData.hasOriginal) {
    imageViewerOriginalBtn.classList.remove('hidden');
    imageViewerOriginalBtn.textContent = '原图';
    imageViewerOriginalBtn.disabled = false;
  } else {
    imageViewerOriginalBtn.classList.add('hidden');
  }

  imageViewer.classList.remove('hidden');
}

function closeImageViewer() {
  imageViewer.classList.add('hidden');
  if (imageViewerImg.src.startsWith('blob:')) URL.revokeObjectURL(imageViewerImg.src);
  imageViewerImg.removeAttribute('src');
  if (imageViewerTitle) imageViewerTitle.textContent = '';
  imageViewerOriginalBtn.disabled = false;
  resetImageZoom();
  currentViewerMessage = null;
  isViewingOriginal = false;
}

if (imageViewerStage) {
  imageViewerStage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.14 : 0.88;
    const nextScale = Math.min(8, Math.max(0.25, imgZoomScale * factor));
    if (nextScale <= 1.02 && nextScale >= 0.98) {
      imgZoomScale = 1;
      imgPanX = 0;
      imgPanY = 0;
    } else {
      imgZoomScale = nextScale;
    }
    updateImageZoomTransform();
  }, { passive: false });

  imageViewerStage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (Math.abs(imgZoomScale - 1) > 0.05) {
      resetImageZoom();
    } else {
      imgZoomScale = 2;
      updateImageZoomTransform();
    }
  });

  imageViewerStage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDraggingImg = true;
    dragStartX = e.clientX - imgPanX;
    dragStartY = e.clientY - imgPanY;
    imageViewerStage.classList.add('is-grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingImg) return;
    imgPanX = e.clientX - dragStartX;
    imgPanY = e.clientY - dragStartY;
    updateImageZoomTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!isDraggingImg) return;
    isDraggingImg = false;
    if (imageViewerStage) imageViewerStage.classList.remove('is-grabbing');
  });
}

if (imageViewerZoomBadge) {
  imageViewerZoomBadge.style.cursor = 'pointer';
  imageViewerZoomBadge.addEventListener('click', resetImageZoom);
}

async function viewOriginalImage() {
  const requestEpoch = accountEpoch;
  const viewerMessage = currentViewerMessage;
  if (!viewerMessage) return;

  const imageData = getImageContent(currentViewerMessage.content);
  if (!imageData.hasOriginal) return;

  imageViewerOriginalBtn.disabled = true;
  imageViewerOriginalBtn.textContent = '加载中...';

  try {
    const original = await fetchOriginalImageWithTimeout(viewerMessage.id, ORIGINAL_FETCH_TIMEOUT);
    if (requestEpoch !== accountEpoch || currentViewerMessage !== viewerMessage) return;
    imageViewerImg.src = original;
    isViewingOriginal = true;
    imageViewerOriginalBtn.textContent = '当前原图';
  } catch (error) {
    if (requestEpoch !== accountEpoch || currentViewerMessage !== viewerMessage) return;
    console.error('加载原图失败:', error);
    showToast('加载原图失败');
    imageViewerOriginalBtn.textContent = '查看原图';
  } finally {
    if (requestEpoch === accountEpoch && currentViewerMessage === viewerMessage) imageViewerOriginalBtn.disabled = false;
  }
}

async function copyViewerImage() {
  const src = imageViewerImg.src;
  if (!src) {
    showToast('没有可复制的图片');
    return;
  }

  const successToast = isViewingOriginal ? '原图已复制到剪贴板' : '图片已复制到剪贴板';
  const ok = await copyImageToClipboard(src, {
    successToast,
    failureToast: '复制图片失败'
  });
  if (ok && imageViewerCopyBtn) {
    flashButtonCopied(imageViewerCopyBtn);
  }
}

if (imageViewerBackdrop) imageViewerBackdrop.addEventListener('click', closeImageViewer);
if (imageViewerCloseBtn) imageViewerCloseBtn.addEventListener('click', closeImageViewer);
if (imageViewerOriginalBtn) imageViewerOriginalBtn.addEventListener('click', viewOriginalImage);
if (imageViewerCopyBtn) imageViewerCopyBtn.addEventListener('click', copyViewerImage);

document.addEventListener('keydown', (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isInput = activeTag === 'input' || activeTag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);

  if (e.key === 'Escape') {
    if (displaySettingsPopover && !displaySettingsPopover.classList.contains('hidden')) {
      closeSettingsPopover();
      return;
    }
    if (imageViewer && !imageViewer.classList.contains('hidden')) {
      closeImageViewer();
      return;
    }
    if (textViewer && !textViewer.classList.contains('hidden')) {
      closeTextViewer();
      return;
    }
    if (fileViewer && !fileViewer.classList.contains('hidden')) {
      closeFileViewer();
      return;
    }
    if (remarkModal && !remarkModal.classList.contains('hidden')) {
      closeRemarkModal();
      return;
    }
    if (groupsManagerModal && !groupsManagerModal.classList.contains('hidden')) {
      closeGroupsManager();
      return;
    }
    if (titleModal && !titleModal.classList.contains('hidden')) {
      closeTitleModal();
      return;
    }
    if (privateUnlockModal && !privateUnlockModal.classList.contains('hidden')) {
      closePrivateUnlockModal();
      return;
    }
    if (avatarEditorModal && !avatarEditorModal.classList.contains('hidden')) {
      avatarEditorModal.classList.add('hidden');
      return;
    }
    if (aboutModal && !aboutModal.classList.contains('hidden')) {
      aboutModal.classList.add('hidden');
      return;
    }
    if (adminModal && !adminModal.classList.contains('hidden')) {
      closeAdminSettings();
      return;
    }
    if (securityModal && !securityModal.classList.contains('hidden')) {
      closeSecuritySettings();
      return;
    }
    const confirmModalEl = document.getElementById('confirm-modal');
    if (confirmModalEl && !confirmModalEl.classList.contains('hidden')) {
      document.getElementById('modal-cancel')?.click();
      return;
    }
    if (searchInput && document.activeElement === searchInput) {
      searchInput.blur();
      return;
    }
  }

  // / 键或 Ctrl/Cmd + K 快速聚焦搜索栏
  if ((e.key === '/' && !isInput) || ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'))) {
    if (isAuthenticated && searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }
});

// ========== 文本 / 代码 / 链接 Quick Look 主题查看器 ==========
const textViewer = document.getElementById('text-viewer');
const textViewerContainer = document.getElementById('text-viewer-container');
const textViewerTitle = document.getElementById('text-viewer-title');
const textViewerTypeIcon = document.getElementById('text-viewer-type-icon');
const textViewerContent = document.getElementById('text-viewer-content');
const textViewerMeta = document.getElementById('text-viewer-meta');
const textViewerOpenLink = document.getElementById('text-viewer-open-link');
const textViewerClose = document.getElementById('text-viewer-close');
const textViewerCloseBtn = document.getElementById('text-viewer-close-btn');
const textViewerCopyBtn = document.getElementById('text-viewer-copy-btn');
const textViewerBackdrop = textViewer ? textViewer.querySelector('.text-viewer-backdrop') : null;

let currentViewerTextMsg = null;
// Sensitive plaintext is kept only in this short-lived map and the active viewer.
const sensitiveViewerState = new Map();
const SENSITIVE_VIEW_MS = 120000;
let sensitiveViewerGeneration = 0;
function clearSensitiveViewerState() {
  sensitiveViewerGeneration += 1;
  for (const entry of sensitiveViewerState.values()) { if (entry.timer) clearTimeout(entry.timer); entry.content = ''; entry.remark = ''; }
  sensitiveViewerState.clear();
  if (currentViewerTextMsg?.sensitive) closeTextViewer();
}
function isSensitiveLocked(msg) { return msg?.sensitive === true && msg?.content == null; }
async function sensitiveCredentials(message) {
  const epoch = accountEpoch; const generation = sensitiveViewerGeneration;
  const isCurrent = () => epoch === accountEpoch && generation === sensitiveViewerGeneration && document.visibilityState !== 'hidden';
  if (currentMode !== 'accounts') { const password = window.prompt(message); if (!password || !isCurrent()) return null; const code = window.prompt('请输入动态验证码'); return code ? { password, code } : null; }
  const response = await authFetch('/api/auth/verification'); const settings = await response.json();
  if (!isCurrent()) return null; if (!response.ok) throw new Error('无法读取验证方式');
  const password = window.prompt(message); if (!password || !isCurrent()) return null;
  let code = ''; let emailChallenge;
  if (settings.method === 'email') {
    const data = await requestEmailCode('sensitive'); if (!isCurrent()) return null;
    emailChallenge = data.challenge; code = window.prompt(`请输入发送到 ${data.emailHint || '当前邮箱'} 的验证码`);
    if (!code || !isCurrent()) return null;
  } else if (settings.method === 'totp') { code = window.prompt('请输入动态验证码'); if (!code || !isCurrent()) return null; }
  return { password, code, emailChallenge };
}
async function revealSensitiveMessage(msg) {
  const generation = sensitiveViewerGeneration; const epoch = accountEpoch; const session = accountSessionId; const user = accountUser?.id;
  const isCurrent = () => generation === sensitiveViewerGeneration && epoch === accountEpoch && document.visibilityState !== 'hidden' && (currentMode !== 'accounts' || (isAuthenticated && session === accountSessionId && user === accountUser?.id));
  const credentials = await sensitiveCredentials('请输入密码以显示敏感文本');
  if (!credentials || !isCurrent()) return null;
  const response = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/sensitive/reauth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reveal', ...credentials }) });
  if (!response.ok) throw new Error('敏感文本验证失败');
  const grant = await response.json();
  if (!isCurrent()) return null;
  const revealed = await authFetch(`/api/messages/${encodeURIComponent(msg.id)}/sensitive/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sensitive-Grant': grant.token }, body: '{}' });
  if (!revealed.ok) throw new Error('敏感文本解锁失败');
  const plain = await revealed.json();
  if (!isCurrent()) return null;
  const entry = { content: plain.content, remark: plain.remark || '', expiresAt: plain.expiresAt, generation };
  entry.timer = setTimeout(() => { if (sensitiveViewerState.get(msg.id) === entry) { sensitiveViewerState.delete(msg.id); entry.content = ''; entry.remark = ''; } if (currentViewerTextMsg?.id === msg.id) closeTextViewer(); }, Math.max(0, entry.expiresAt - Date.now()));
  if (!isCurrent()) { entry.content = ''; entry.remark = ''; return null; }
  sensitiveViewerState.set(msg.id, entry);
  return { ...msg, content: entry.content, remark: entry.remark, sensitive: true };
}

async function openTextViewer(msg) {
  if (!textViewer || !textViewerContent) return;
  if (isSensitiveLocked(msg)) {
    try { msg = sensitiveViewerState.get(msg.id) ? { ...msg, ...sensitiveViewerState.get(msg.id) } : await revealSensitiveMessage(msg); }
    catch (error) { showToast(error.message || '敏感文本验证失败'); return; }
    if (!msg) return;
  }
  currentViewerTextMsg = msg;

  const spec = detectPasteCardSpec(msg);
  if (textViewer) {
    textViewer.className = `text-viewer modal variant-${spec.variant}`;
  }
  if (textViewerContainer) {
    textViewerContainer.className = `text-viewer-container paste-modal-card variant-${spec.variant}`;
  }
  if (textViewerTypeIcon) {
    textViewerTypeIcon.innerHTML = spec.iconSvg;
  }
  if (textViewerTitle) {
    textViewerTitle.textContent = msg.title ? `${spec.defaultTitle} · ${msg.title}` : spec.defaultTitle;
  }
  renderViewerRemarkBar('text-viewer', msg);

  const content = String(msg.content || '');
  const lines = content.split('\n').length;
  const chars = content.length;

  if (textViewerMeta) {
    textViewerMeta.textContent = `${spec.metaText} · ${formatTime(msg.timestamp)}`;
  }

  if (textViewerOpenLink) {
    if (spec.variant === 'link') {
      textViewerOpenLink.href = content.trim();
      textViewerOpenLink.classList.remove('hidden');
    } else {
      textViewerOpenLink.classList.add('hidden');
    }
  }

  if (spec.variant === 'code') {
    const cleanCode = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    const HL = window.WBHighlight;
    textViewerContent.className = 'text-viewer-content is-code-view';
    textViewerContent.innerHTML = HL
      ? `<pre class="viewer-code-pre"><code>${HL.highlight(cleanCode, 'js')}</code></pre>`
      : `<pre class="viewer-code-pre"><code>${escapeHTML(cleanCode)}</code></pre>`;
  } else if (spec.variant === 'link') {
    const rawUrl = content.trim();
    textViewerContent.className = 'text-viewer-content is-link-view';
    textViewerContent.innerHTML = `
      <div class="viewer-link-card">
        <div class="viewer-link-host">${escapeHTML(spec.metaText)}</div>
        <a href="${escapeHTML(rawUrl)}" target="_blank" rel="noopener" class="viewer-link-url">${escapeHTML(rawUrl)}</a>
      </div>
    `;
  } else {
    textViewerContent.className = 'text-viewer-content';
    textViewerContent.innerHTML = renderSmartText(content);
  }

  textViewer.classList.remove('hidden');
}

function closeTextViewer() {
  if (!textViewer) return;
  if (currentViewerTextMsg?.sensitive) {
    sensitiveViewerGeneration += 1;
    const entry = sensitiveViewerState.get(currentViewerTextMsg.id);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) { entry.content = ''; entry.remark = ''; }
    sensitiveViewerState.delete(currentViewerTextMsg.id);
  }
  textViewer.classList.add('hidden');
  if (textViewerContent) { textViewerContent.innerHTML = ''; textViewerContent.textContent = ''; }
  if (textViewerTitle) textViewerTitle.textContent = '';
  if (textViewerMeta) textViewerMeta.textContent = '';
  if (textViewerTypeIcon) textViewerTypeIcon.innerHTML = '';
  if (textViewerOpenLink) { textViewerOpenLink.removeAttribute('href'); textViewerOpenLink.classList.add('hidden'); }
  currentViewerTextMsg = null;
}

async function copyViewerText() {
  if (!currentViewerTextMsg) { showToast('没有可复制的内容'); return; }
  if (currentViewerTextMsg.sensitive) {
    const generation = sensitiveViewerGeneration; const epoch = accountEpoch;
    const credentials = await sensitiveCredentials('请输入密码以复制敏感文本'); if (!credentials) return;
    const reauth = await authFetch(`/api/messages/${encodeURIComponent(currentViewerTextMsg.id)}/sensitive/reauth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'copy', ...credentials }) });
    if (!reauth.ok || generation !== sensitiveViewerGeneration || epoch !== accountEpoch) { showToast('敏感文本验证失败'); return; }
    const grant = await reauth.json();
    const response = await authFetch(`/api/messages/${encodeURIComponent(currentViewerTextMsg.id)}/sensitive/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sensitive-Grant': grant.token }, body: '{}' });
    if (!response.ok || generation !== sensitiveViewerGeneration || epoch !== accountEpoch) { showToast('敏感文本复制失败'); return; }
    const plain = await response.json();
    if (generation !== sensitiveViewerGeneration || epoch !== accountEpoch || document.visibilityState === 'hidden') return;
    await copyTextToClipboard(plain.content);
  } else {
    if (!currentViewerTextMsg.content) { showToast('没有可复制的内容'); return; }
    await copyTextToClipboard(currentViewerTextMsg.content);
  }
  if (textViewerCopyBtn) flashButtonCopied(textViewerCopyBtn);
}

if (textViewerBackdrop) textViewerBackdrop.addEventListener('click', closeTextViewer);
if (textViewerClose) textViewerClose.addEventListener('click', closeTextViewer);
if (textViewerCloseBtn) textViewerCloseBtn.addEventListener('click', closeTextViewer);
if (textViewerCopyBtn) textViewerCopyBtn.addEventListener('click', copyViewerText);

// ========== 开发者文件查看器（JSON / 代码 / Markdown） ==========
const fileViewer = document.getElementById('file-viewer');
const fileViewerTitle = document.getElementById('file-viewer-title');
const fileViewerMeta = document.getElementById('file-viewer-meta');
const fileViewerLang = document.getElementById('file-viewer-lang');
const fileViewerContent = document.getElementById('file-viewer-content');
const fileViewerNotice = document.getElementById('file-viewer-notice');
const fileViewerCardSummary = document.getElementById('file-viewer-card-summary');
const fileViewerClose = document.getElementById('file-viewer-close');
const fileViewerCloseBtn = document.getElementById('file-viewer-close-btn');
const fileViewerCopyBtn = document.getElementById('file-viewer-copy-btn');
const fileViewerDownloadBtn = document.getElementById('file-viewer-download-btn');
const fileViewerBackdrop = fileViewer ? fileViewer.querySelector('.file-viewer-backdrop') : null;

let currentViewerFileMsg = null;
let currentViewerFileText = '';

// 与后端 utils.isPreviewableText 同规则的前端镜像（仅用于决定按钮是否出现）
const PREVIEWABLE_EXT_RE = /\.(json|jsonl|ndjson|txt|md|markdown|csv|tsv|log|ya?ml|ini|conf|properties|env|toml|editorconfig|gitignore)$/i;
const PREVIEWABLE_MIME_SET = new Set([
  'application/json', 'application/x-ndjson', 'application/yaml',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/yaml'
]);
const ACTIVE_EXT_RE = /\.(html?|xhtml|svgz?|xml|js|mjs|mht|mhtml|swf|hta|vbs|wsf|shtml|php[0-9]?)$/i;
const ACTIVE_MIME_SET = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
  'application/javascript', 'text/javascript', 'application/x-javascript',
  'application/x-shockwave-flash', 'text/x-component', 'application/x-httpd-php'
]);

function isActiveContentFile(name, mime) {
  const lowerMime = String(mime || '').toLowerCase().split(';')[0].trim();
  if (ACTIVE_MIME_SET.has(lowerMime)) return true;
  return ACTIVE_EXT_RE.test(String(name || ''));
}

function isPreviewableFile(name, mime) {
  if (isActiveContentFile(name, mime)) return false;
  const lowerMime = String(mime || '').toLowerCase().split(';')[0].trim();
  if (PREVIEWABLE_MIME_SET.has(lowerMime)) return true;
  return PREVIEWABLE_EXT_RE.test(String(name || ''));
}

function setFileViewerNotice(text) {
  if (!fileViewerNotice) return;
  if (text) {
    fileViewerNotice.textContent = text;
    fileViewerNotice.classList.remove('hidden');
  } else {
    fileViewerNotice.textContent = '';
    fileViewerNotice.classList.add('hidden');
  }
}

function renderViewerText(text, lang) {
  const HL = window.WBHighlight;

  // 每次渲染前重置正文类名，避免上一次的 Markdown 模式残留
  if (fileViewerContent) fileViewerContent.classList.remove('md-body');

  if (!HL) {
    fileViewerContent.textContent = text;
    return;
  }

  if (lang === 'markdown') {
    fileViewerContent.classList.add('md-body');
    fileViewerContent.innerHTML = HL.renderMarkdown(text);
    return;
  }

  if (lang === 'json') {
    const pretty = HL.prettyJSON(text);
    if (!pretty.ok) {
      showToast('JSON 解析失败，按纯文本显示');
      fileViewerContent.innerHTML = HL.highlight(text, 'plain');
      return;
    }
    fileViewerContent.innerHTML = HL.highlight(pretty.text, 'json');
    return;
  }

  fileViewerContent.innerHTML = HL.highlight(text, lang);
}

async function openFileViewer(msg) {
  if (!fileViewer || !fileViewerContent) return;

  const fileData = getFileContent(msg.content);
  const spec = detectPasteCardSpec(msg);
  const canPreviewText = isPreviewableFile(fileData.name, fileData.mimeType) && fileData.size <= MAX_PREVIEW_BYTES;

  currentViewerFileMsg = msg;
  currentViewerFileText = fileData.name || '';

  if (fileViewerTitle) fileViewerTitle.textContent = fileData.name || '文件预览';
  if (fileViewerMeta) {
    fileViewerMeta.textContent = `${ msg.title ? `${msg.title} · ` : '' }${spec.metaText} · ${formatTime(msg.timestamp)}`;
  }
  renderViewerRemarkBar('file-viewer', msg);

  // 如果是非文本类二进制文件（如压缩包、PDF、安装包、大文件等），展示精致的文件详情卡片弹窗
  const fileCopySpan = fileViewerCopyBtn ? fileViewerCopyBtn.querySelector('span') : null;
  if (!canPreviewText) {
    if (fileViewerLang) fileViewerLang.textContent = spec.metaText.split('·').pop().trim();
    setFileViewerNotice('');
    fileViewerContent.classList.add('hidden');
    if (fileCopySpan) fileCopySpan.textContent = '复制文件名';
    if (fileViewerCardSummary) {
      fileViewerCardSummary.classList.remove('hidden');
      fileViewerCardSummary.innerHTML = `
        <div class="file-summary-icon">${spec.iconSvg}</div>
        <div class="file-summary-name">${escapeHTML(fileData.name || '未命名文件')}</div>
        <div class="file-summary-meta">${escapeHTML(spec.metaText)} · 上传于 ${formatTime(msg.timestamp)}</div>
      `;
    }
    fileViewer.classList.remove('hidden');
    return;
  }

  fileViewerContent.classList.remove('hidden');
  if (fileViewerCardSummary) {
    fileViewerCardSummary.classList.add('hidden');
    fileViewerCardSummary.innerHTML = '';
  }
  if (fileCopySpan) fileCopySpan.textContent = '复制';

  const lang = (window.WBHighlight && window.WBHighlight.detectLang(fileData.name, fileData.mimeType)) || 'plain';
  if (fileViewerLang) {
    fileViewerLang.textContent = window.WBHighlight ? window.WBHighlight.langLabel(lang) : '';
  }

  setFileViewerNotice('');
  fileViewerContent.textContent = '加载中…';
  fileViewer.classList.remove('hidden');

  const params = new URLSearchParams();
  if (currentMode === 'multi' && userId) {
    params.set('userId', userId);
  }
  params.set('inline', '1');

  try {
    const response = await authFetch(`/api/messages/${msg.id}/file-stream?${params.toString()}`);

    if (response.status === 413) {
      closeFileViewer();
      showToast('文件过大，请下载后查看');
      return;
    }
    if (!response.ok) {
      closeFileViewer();
      showToast('打开失败，请改用下载');
      return;
    }

    let text = await response.text();
    const totalChars = text.length;

    if (totalChars > MAX_PREVIEW_CHARS) {
      text = text.slice(0, MAX_PREVIEW_CHARS);
      setFileViewerNotice(`内容过长，已截断：仅显示前 ${MAX_PREVIEW_CHARS} 个字符（共 ${totalChars} 个），完整内容请下载后查看。`);
    }

    currentViewerFileText = text;

    const lines = text.split('\n').length;
    if (fileViewerMeta) {
      fileViewerMeta.textContent = `${formatFileSize(fileData.size)} · ${lines} 行 · ${formatTime(msg.timestamp)}`;
    }

    renderViewerText(text, lang);
  } catch (error) {
    closeFileViewer();
    showToast('打开失败，请改用下载');
    console.error(error);
  }
}

function closeFileViewer() {
  if (!fileViewer) return;
  fileViewer.classList.add('hidden');
  if (fileViewerContent) {
    fileViewerContent.innerHTML = '';
  }
  setFileViewerNotice('');
  currentViewerFileMsg = null;
  currentViewerFileText = '';
}

async function copyViewerFile() {
  if (!currentViewerFileText) {
    showToast('没有可复制的内容');
    return;
  }
  await copyTextToClipboard(currentViewerFileText);
  if (fileViewerCopyBtn) {
    flashButtonCopied(fileViewerCopyBtn);
  }
}

function downloadViewerFile() {
  if (!currentViewerFileMsg) return;
  const params = new URLSearchParams();
  if (currentMode === 'multi' && userId) {
    params.set('userId', userId);
  }
  window.open(`/api/messages/${currentViewerFileMsg.id}/file-stream?${params.toString()}`, '_blank', 'noopener');
}

if (fileViewerBackdrop) fileViewerBackdrop.addEventListener('click', closeFileViewer);
if (fileViewerClose) fileViewerClose.addEventListener('click', closeFileViewer);
if (fileViewerCloseBtn) fileViewerCloseBtn.addEventListener('click', closeFileViewer);
if (fileViewerCopyBtn) fileViewerCopyBtn.addEventListener('click', copyViewerFile);
if (fileViewerDownloadBtn) fileViewerDownloadBtn.addEventListener('click', downloadViewerFile);

// 处理 Socket.IO 连接认证失败
socket.on('connect_error', (err) => {
  console.error('Socket 连接失败:', err.message);
  if (err && err.message && err.message.includes('Authentication error')) {
    showToast('身份验证失效，请重新登录');
    requirePassword = true;
    logout(false);
  }
});

// 注册 PWA Service Worker 离线缓存服务
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((reg) => {
        console.log('ServiceWorker 注册成功，作用域为:', reg.scope);
        // 主动检测更新
        reg.update().catch(() => {});
      })
      .catch((err) => console.error('ServiceWorker 注册失败:', err));
  });
}

// ========== 备注功能 ==========
const remarkModal = document.getElementById('remark-modal');
const remarkModalPreview = document.getElementById('remark-modal-preview');
const remarkInput = document.getElementById('remark-input');
const remarkCharCount = document.getElementById('remark-char-count');
const remarkCancelBtn = document.getElementById('remark-cancel-btn');
const remarkModalCloseBtn = document.getElementById('remark-modal-close');
const remarkClearBtn = document.getElementById('remark-clear-btn');
const remarkSaveBtn = document.getElementById('remark-save-btn');

let currentRemarkMessage = null;

function updateRemarkCharCount() {
  if (!remarkCharCount || !remarkInput) return;
  const count = remarkInput.value.length;
  remarkCharCount.textContent = `${count} / 500`;
  if (count >= 500) {
    remarkCharCount.style.color = 'var(--danger)';
  } else {
    remarkCharCount.style.color = 'var(--text-muted)';
  }
}

function openRemarkModal(msg) {
  currentRemarkMessage = msg;
  if (!remarkModal || !remarkInput) return;

  // 渲染消息摘要预览
  if (remarkModalPreview) {
    let previewText = '';
    if (msg.sensitive) {
      previewText = '敏感文本（需验证后编辑）';
    } else if (msg.type === 'text') {
      const plainText = (msg.content || '').replace(/\s+/g, ' ').trim();
      previewText = `文本: ${plainText.slice(0, 50)}${plainText.length > 50 ? '...' : ''}`;
    } else if (msg.type === 'image') {
      previewText = `图片: [${formatTime(msg.timestamp)}]`;
    } else if (msg.type === 'file') {
      const fileData = getFileContent(msg.content);
      previewText = `文件: ${fileData.name || '附件'}`;
    }
    remarkModalPreview.textContent = previewText || '消息';
  }

  remarkInput.value = msg.sensitive ? '' : (msg.remark || '');
  updateRemarkCharCount();

  if (remarkClearBtn) {
    if (msg.remark) {
      remarkClearBtn.classList.remove('hidden');
    } else {
      remarkClearBtn.classList.add('hidden');
    }
  }

  remarkModal.classList.remove('hidden');
  setTimeout(() => {
    remarkInput.focus();
    remarkInput.setSelectionRange(remarkInput.value.length, remarkInput.value.length);
  }, 50);
}

function closeRemarkModal() {
  if (remarkModal) {
    remarkModal.classList.add('hidden');
  }
  currentRemarkMessage = null;
}

async function saveRemark(newRemark = null) {
  if (!currentRemarkMessage) return;

  const targetId = currentRemarkMessage.id;
  const remarkToSave = typeof newRemark === 'string' ? newRemark : remarkInput.value.trim();

  try {
    if (remarkSaveBtn) {
      remarkSaveBtn.disabled = true;
      remarkSaveBtn.textContent = '保存中...';
    }

    const params = new URLSearchParams();
    if (currentMode === 'multi' && userId) {
      params.set('userId', userId);
    }

    const res = await authFetch(`/api/messages/${encodeURIComponent(targetId)}/remark?${params.toString()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remark: remarkToSave })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '保存备注失败');
    }

    updateSingleMessageRemark(targetId, remarkToSave);
    closeRemarkModal();
    showToast(remarkToSave ? '备注已保存' : '备注已清除');
  } catch (error) {
    console.error('保存备注错误:', error);
    showToast(error.message || '保存备注失败');
  } finally {
    if (remarkSaveBtn) {
      remarkSaveBtn.disabled = false;
      remarkSaveBtn.textContent = '保存';
    }
  }
}

if (remarkCancelBtn) {
  remarkCancelBtn.addEventListener('click', closeRemarkModal);
}
if (remarkModalCloseBtn) {
  remarkModalCloseBtn.addEventListener('click', closeRemarkModal);
}

if (remarkClearBtn) {
  remarkClearBtn.addEventListener('click', () => {
    saveRemark('');
  });
}

if (remarkSaveBtn) {
  remarkSaveBtn.addEventListener('click', () => {
    saveRemark();
  });
}

if (remarkInput) {
  remarkInput.addEventListener('input', () => {
    updateRemarkCharCount();
    updateRemarkAutocomplete();
  });
  remarkInput.addEventListener('focus', updateRemarkAutocomplete);
  remarkInput.addEventListener('keydown', (e) => {
    if (remarkAutocompleteActive()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateRemarkAutocomplete(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateRemarkAutocomplete(-1); return; }
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && remarkAutocompleteIndex >= 0) {
        e.preventDefault();
        confirmRemarkAutocomplete();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideRemarkAutocomplete(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveRemark();
    }
  });
  remarkInput.addEventListener('blur', () => {
    setTimeout(hideRemarkAutocomplete, 150);
  });
}

// ========== 备注自动补全 ==========
const remarkAutocompleteEl = document.getElementById('remark-autocomplete');
let remarkAutocompleteIndex = -1;

function getRemarkSuggestions(q) {
  const allMsgs = [...messages, ...favorites];
  const remarks = aggregateRemarks(allMsgs);
  if (!q) return remarks.slice(0, 8);
  const lower = q.toLowerCase();
  return remarks.filter(c => c.remark.toLowerCase().includes(lower)).slice(0, 8);
}

function remarkAutocompleteActive() {
  return remarkAutocompleteEl && !remarkAutocompleteEl.classList.contains('hidden');
}

function hideRemarkAutocomplete() {
  remarkAutocompleteEl?.classList.add('hidden');
  remarkAutocompleteIndex = -1;
}

function updateRemarkAutocomplete() {
  if (!remarkAutocompleteEl || !remarkInput) return;
  const q = remarkInput.value.trim();
  const suggestions = getRemarkSuggestions(q);
  if (suggestions.length === 0) { hideRemarkAutocomplete(); return; }

  remarkAutocompleteIndex = -1;
  remarkAutocompleteEl.innerHTML = '';
  suggestions.forEach(({ remark, count }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remark-autocomplete-item';
    btn.setAttribute('role', 'option');
    btn.innerHTML = `
      <span class="remark-autocomplete-item-text">${escapeHTML(remark)}</span>
      <span class="remark-autocomplete-item-count">${count} 条</span>
    `;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      remarkInput.value = remark;
      updateRemarkCharCount();
      hideRemarkAutocomplete();
      if (remarkClearBtn) remarkClearBtn.classList.remove('hidden');
    });
    remarkAutocompleteEl.appendChild(btn);
  });
  remarkAutocompleteEl.classList.remove('hidden');
}

function navigateRemarkAutocomplete(dir) {
  if (!remarkAutocompleteActive()) return;
  const items = remarkAutocompleteEl.querySelectorAll('.remark-autocomplete-item');
  if (!items.length) return;
  remarkAutocompleteIndex = Math.max(-1, Math.min(items.length - 1, remarkAutocompleteIndex + dir));
  items.forEach((item, i) => item.classList.toggle('is-active', i === remarkAutocompleteIndex));
  if (remarkAutocompleteIndex >= 0) {
    remarkInput.value = items[remarkAutocompleteIndex].querySelector('.remark-autocomplete-item-text').textContent;
    updateRemarkCharCount();
  }
}

function confirmRemarkAutocomplete() {
  if (!remarkAutocompleteActive()) return;
  const active = remarkAutocompleteEl.querySelector('.remark-autocomplete-item.is-active');
  if (active) {
    remarkInput.value = active.querySelector('.remark-autocomplete-item-text').textContent;
    updateRemarkCharCount();
    if (remarkClearBtn) remarkClearBtn.classList.remove('hidden');
  }
  hideRemarkAutocomplete();
}

if (remarkModal) {
  remarkModal.addEventListener('click', (e) => {
    if (e.target === remarkModal) {
      closeRemarkModal();
    }
  });
}


// ── 移动端 FAB：一键保存剪切板 ──────────────────────────────────────────────
const mobileFab = document.getElementById('mobile-fab');

async function fabSaveClipboard() {
  if (!mobileFab) return;

  // 防重入
  if (mobileFab.dataset.busy === '1') return;
  mobileFab.dataset.busy = '1';
  mobileFab.classList.add('fab-loading');

  try {
    // 优先 navigator.clipboard.read()（支持图片/文本）
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // 图片优先
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], `clipboard.${imageType.split('/')[1] || 'png'}`, { type: imageType });
          await sendMessageWithProgress('image', file);
          showToast('✓ 图片已保存');
          return;
        }
        // 文本/链接
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          if (text.trim()) {
            await sendMessageWithProgress('text', text.trim());
            showToast('✓ 已保存');
            return;
          }
        }
      }
      showToast('剪切板为空');
      return;
    }

    // 降级：readText() 仅文本
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        await sendMessageWithProgress('text', text.trim());
        showToast('✓ 已保存');
        return;
      }
      showToast('剪切板为空');
      return;
    }

    // 再降级：execCommand paste（仅限极老浏览器，基本不走）
    showToast('当前浏览器不支持读取剪切板');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      showToast('需要授权剪切板权限');
    } else {
      showToast(err?.message || '保存失败');
    }
  } finally {
    mobileFab.dataset.busy = '0';
    mobileFab.classList.remove('fab-loading');
  }
}

if (mobileFab) {
  mobileFab.addEventListener('click', (e) => {
    e.stopPropagation();
    fabSaveClipboard();
  });
}
