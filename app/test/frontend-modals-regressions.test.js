'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appHtmlPath = path.join(__dirname, '..', 'public', 'app.html');
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
const styleCssPath = path.join(__dirname, '..', 'public', 'style.css');

const appHtml = fs.readFileSync(appHtmlPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const styleCss = fs.readFileSync(styleCssPath, 'utf8');

test('app.html 包含工作台全量弹窗关闭控件与备注自动补全容器', () => {
  const requiredIds = [
    'title-modal-close',
    'remark-modal-close',
    'remark-autocomplete',
    'group-quick-picker',
    'group-toggle-button',
    'group-quick-picker-close',
    'image-viewer-close',
    'text-viewer-close',
    'file-viewer-close'
  ];

  for (const id of requiredIds) {
    assert.match(
      appHtml,
      new RegExp(`id="${id}"`),
      `app.html 应包含 #${id} 节点`
    );
  }
});

test('app.js 不再残留未定义的 closeSettingsPopover 或 handleSuccessfulLogin 引用', () => {
  assert.match(
    appJs,
    /function closeSettingsPopover\(\)/,
    'app.js 应在顶层定义 closeSettingsPopover 函数'
  );
  assert.doesNotMatch(
    appJs,
    /handleSuccessfulLogin/,
    'app.js 不应调用未定义的 handleSuccessfulLogin'
  );
  assert.doesNotMatch(
    appJs,
    /selectedUnlockDuration/,
    'app.js 不应引用未定义的 selectedUnlockDuration'
  );
});

test('分组筛选入口仅在存在分组时显示，快速选择仅列出已有分组', () => {
  assert.match(appHtml, /class="filter-chip group-toggle-chip hidden" id="group-toggle-button"/);
  assert.match(appJs, /groupToggleButton\?\.classList\.toggle\('hidden', !hasGroups\)/);
  assert.doesNotMatch(appHtml, /选择一个分组筛选内容|全部分组/);
  assert.doesNotMatch(appJs, /textContent\s*=\s*'全部分组'/);
});

test('app.js 动态分类/备注/分组渲染对特殊字符执行 HTML 转义（防 DOM XSS）', () => {
  // 提取 escapeHTML 与 remarkToColor 函数在沙箱中验证
  const escapeStart = appJs.indexOf('function escapeHTML(str)');
  const escapeEnd = appJs.indexOf('function renderSmartText(text)');
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, '应找到 escapeHTML 定义');

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(appJs.slice(escapeStart, escapeEnd), sandbox);

  const malicious = '<img src=x onerror="alert(1)">';
  const escaped = sandbox.escapeHTML(malicious);
  assert.equal(escaped, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');

  // 验证关键 innerHTML 模板均已使用 escapeHTML 包裹
  assert.match(appJs, /<span class="category-chip-dot"[^>]*><\/span><span class="category-chip-label">\$\{escapeHTML\(name\)\}<\/span><span class="category-chip-count">/);
  assert.match(appJs, /<span class="group-picker-name">\$\{escapeHTML\(name\)\}<\/span>/);
  assert.match(appJs, /<span class="groups-manager-name">\$\{escapeHTML\(name\)\}<\/span>/);
  assert.match(appJs, /<span class="remark-autocomplete-item-text">\$\{escapeHTML\(remark\)\}<\/span>/);
});

test('卡片顶栏已移除铅笔备注编辑按钮与顶部分组标签，分组只保留在卡片底部中间', () => {
  assert.doesNotMatch(
    appJs,
    /message-remark-action/,
    'app.js 不应再渲染卡片顶部铅笔备注编辑按钮 .message-remark-action'
  );
  assert.doesNotMatch(
    appJs,
    /paste-card-category-tag/,
    'app.js 不应再在卡片顶部渲染分组标签 .paste-card-category-tag'
  );
  assert.match(
    appJs,
    /card-title-entry/,
    'app.js 应在卡片底部渲染分组入口 .card-title-entry'
  );
});

test('卡片右下角备注最多显示 10 个字符（超出截断），且预览弹窗底部支持直接内联编辑备注', () => {
  const fnStart = appJs.indexOf('function formatCardRemarkPreview(remark)');
  const fnEnd = appJs.indexOf('function updateSingleMessageRemark(id, remark)');
  assert.ok(fnStart >= 0 && fnEnd > fnStart, '应定义 formatCardRemarkPreview 函数');

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(appJs.slice(fnStart, fnEnd), sandbox);

  assert.equal(sandbox.formatCardRemarkPreview('短备注'), '短备注');
  assert.equal(sandbox.formatCardRemarkPreview('一二三四五六七八九十'), '一二三四五六七八九十');
  assert.equal(sandbox.formatCardRemarkPreview('一二三四五六七八九十甲乙丙'), '一二三四五六七八九十...');
  assert.equal(sandbox.formatCardRemarkPreview('123456789012345'), '1234567890...');

  // 验证三个预览弹窗均包含内联编辑控件，且 renderViewerRemarkBar 使用 enterViewerRemarkEdit 而非弹出 openRemarkModal
  for (const prefix of ['image-viewer', 'text-viewer', 'file-viewer']) {
    assert.match(appHtml, new RegExp(`id="${prefix}-remark-editor"`), `app.html 应包含 #${prefix}-remark-editor`);
    assert.match(appHtml, new RegExp(`id="${prefix}-remark-input"`), `app.html 应包含 #${prefix}-remark-input`);
    assert.match(appHtml, new RegExp(`id="${prefix}-remark-save"`), `app.html 应包含 #${prefix}-remark-save`);
    assert.match(appHtml, new RegExp(`id="${prefix}-remark-cancel"`), `app.html 应包含 #${prefix}-remark-cancel`);
  }

  const viewerFnStart = appJs.indexOf('function renderViewerRemarkBar(prefix, msg)');
  const viewerFnEnd = appJs.indexOf('function syncActiveViewerRemark(id, remark)');
  assert.ok(viewerFnStart >= 0 && viewerFnEnd > viewerFnStart, '应找到 renderViewerRemarkBar');
  const viewerFnCode = appJs.slice(viewerFnStart, viewerFnEnd);
  assert.match(viewerFnCode, /enterViewerRemarkEdit\(prefix,\s*msg\)/, '预览弹窗备注栏应触发内联编辑');
  assert.doesNotMatch(viewerFnCode, /openRemarkModal/, '预览弹窗备注栏不应再弹出独立的 #remark-modal');
});

test('顶部搜索框已合并为统一全局搜索（移除全部/备注切换），隐私解锁弹窗移除到期重新加锁冗余提示并升级自定义时长组件', () => {
  // 1. 顶部搜索框移除 .search-scope-tabs
  assert.doesNotMatch(appHtml, /search-scope-tabs/, 'app.html 不应再包含搜索范围切换 .search-scope-tabs');
  assert.doesNotMatch(appJs, /searchScope/, 'app.js 不应再保留 searchScope 状态切换');

  // 2. 隐私解锁弹窗移除“到期后重新加锁”冗余文案
  assert.doesNotMatch(appHtml, /到期后重新加锁/, 'app.html 不应包含“到期后重新加锁”提示文案');
  assert.doesNotMatch(appJs, /到期后重新加锁/, 'app.js 不应生成“到期后重新加锁”提示文案');

  // 3. 隐私解锁自定义时长具备快捷预设档位与步进器控件
  assert.match(appHtml, /id="private-custom-presets"/, 'app.html 应包含常用自定义时长快捷预设栏 #private-custom-presets');
  assert.match(appHtml, /id="private-custom-step-down"/, 'app.html 应包含减少时长步进按钮 #private-custom-step-down');
  assert.match(appHtml, /id="private-custom-step-up"/, 'app.html 应包含增加时长步进按钮 #private-custom-step-up');
  assert.match(appJs, /function setCustomHoursValue\(/, 'app.js 应包含自定义时长步进与预设同步函数 setCustomHoursValue');

  // 4. 搜索框隐藏浏览器原生 ::-webkit-search-cancel-button，避免与 #toolbar-clear 叠加出现 2 个关闭按钮
  assert.match(
    styleCss,
    /\.topbar-search::-webkit-search-cancel-button[\s\S]*?display:\s*none/,
    'style.css 应隐藏 .topbar-search 的原生 ::-webkit-search-cancel-button 清除按钮'
  );

  // 5. 搜索框有内容或处于搜索态（即使失焦/鼠标移开）时隐藏快捷键提示 #search-shortcut-kbd (⌘K / /)
  assert.match(
    styleCss,
    /\.topbar-search:not\(:placeholder-shown\)\s*~\s*\.search-kbd/,
    'style.css 应在输入框非空 (:not(:placeholder-shown)) 时隐藏 .search-kbd'
  );
  assert.match(
    appJs,
    /function syncSearchAdornments\(\)/,
    'app.js 应通过 syncSearchAdornments 同步控制清除按钮与快捷键徽章显隐'
  );

  // 6. 右上角连接状态移除常驻中文字符，改为绿色动态呼吸图标 / 断电插头图标，鼠标悬停显示状态文字
  assert.match(
    appHtml,
    /id="connection-unplug-icon"/,
    'app.html 应包含断电插头 SVG 图标 #connection-unplug-icon'
  );
  assert.match(
    appHtml,
    /id="connection-status"\s+class="status sr-only connected"/,
    'app.html 中 #connection-status 应设为 sr-only 不直接显示常驻中文字符'
  );
  assert.match(
    styleCss,
    /@keyframes connectionPulseRing/,
    'style.css 应包含连接状态绿色动态呼吸动画 @keyframes connectionPulseRing'
  );
  assert.match(
    styleCss,
    /\.connection-pill::after[\s\S]*?content:\s*attr\(data-tooltip\)/,
    'style.css 应支持鼠标悬停显示 data-tooltip 状态文字气泡'
  );
  assert.match(
    appJs,
    /function updateConnectionIndicator\(isConnected\)/,
    'app.js 应包含连接状态图标与悬浮提示同步函数 updateConnectionIndicator'
  );

  // 7. 顶栏缩放控制器已移除多余的加减号按钮 (#card-zoom-out / #card-zoom-in)，只保留滑块与百分比重置徽章
  assert.doesNotMatch(appHtml, /id="card-zoom-out"/, 'app.html 不应包含顶部缩放减号按钮 #card-zoom-out');
  assert.doesNotMatch(appHtml, /id="card-zoom-in"/, 'app.html 不应包含顶部缩放加号按钮 #card-zoom-in');
  assert.doesNotMatch(appJs, /cardZoomOutBtn|cardZoomInBtn/, 'app.js 不应残留顶部缩放加减号按钮引用');
});


