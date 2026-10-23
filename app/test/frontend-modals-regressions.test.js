'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appHtmlPath = path.join(__dirname, '..', 'public', 'app.html');
const appJsPath = path.join(__dirname, '..', 'public', 'app.js');

const appHtml = fs.readFileSync(appHtmlPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

test('app.html 包含工作台全量弹窗关闭控件与备注自动补全容器', () => {
  const requiredIds = [
    'title-modal-close',
    'remark-modal-close',
    'remark-autocomplete',
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
  assert.match(appJs, /<span class="category-chip-dot"[^>]*><\/span>\$\{escapeHTML\(name\)\}/);
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

