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
