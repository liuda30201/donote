'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const appHtml = fs.readFileSync(path.join(root, 'app/public/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/public/app.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'app/public/service-worker.js'), 'utf8');
const nginxConfig = fs.readFileSync(path.join(root, 'nginx/conf.d/20-clipboard.conf'), 'utf8');
const sharedHeaders = fs.readFileSync(path.join(root, 'nginx/security-headers.inc'), 'utf8');

test('生产工作台不依赖外部脚本或 Twemoji 图片', () => {
  assert.match(appHtml, /<script\s+src="\/theme-init\.js\?v=[^"]+"><\/script>/);
  assert.doesNotMatch(appHtml, /<script\s+src="https?:\/\//i);
  assert.doesNotMatch(appJs, /\btwemoji\b/i);
  assert.match(serviceWorker, /\/theme-init\.js\?v=[^'\"]+/);
});

test('生产 CSP 只允许安全 WebSocket 连接', () => {
  for (const headers of [nginxConfig, sharedHeaders]) {
    assert.match(headers, /connect-src 'self' wss:/);
    assert.doesNotMatch(headers, /connect-src[^\n]*\bws:/);
  }
});
