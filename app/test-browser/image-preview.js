// 需要 Playwright 和 Chromium；独立于 Node 接口测试执行。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-preview-'));
  process.env.STORAGE_ROOT = storageRoot;
  process.env.ACCESS_PASSWORD = 'browser-test-only';
  process.env.ACCESS_PASSWORDS = '';
  const { createApp } = require('../src/app');
  const { getUserState } = require('../src/storage');
  const { server, io } = createApp();
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('web-clipboard-password', 'browser-test-only'));
    await context.addCookies([{ name: 'wc_auth', value: Buffer.from(process.env.ACCESS_PASSWORD).toString('base64'), url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#667eea';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await fs.mkdir(path.join(storageRoot, 'uploads'), { recursive: true });
    await fs.writeFile(path.join(storageRoot, 'uploads', 'preview.png'), Buffer.from(png, 'base64'));
    getUserState(null).messages.push({
      id: 'preview-test', type: 'image', timestamp: Date.now(), favorite: true,
      content: { thumbnailPath: 'preview.png', originalPath: 'preview.png', hasOriginal: true, thumbnailMimeType: 'image/png', originalMimeType: 'image/png' }
    });
    await page.goto(base);
    const card = page.locator('#messages-list .message-content.image');
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#messages-list .message-image')?.naturalWidth > 0);
    await card.locator('img').click();
    const viewer = page.locator('#image-viewer');
    await viewer.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('image-viewer-img').naturalWidth === 640);
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '预览图片', exact: true }).last().click();
    await viewer.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '查看原图', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('image-viewer-original').textContent === '当前原图');
    assert.ok(await page.locator('#image-viewer-img').evaluate((img) => img.src.startsWith('data:image/png;')));
    await page.locator('.image-viewer-close').click();
    await viewer.waitFor({ state: 'hidden' });
    await card.focus();
    await page.keyboard.press('Enter');
    await viewer.waitFor({ state: 'visible' });
    await page.locator('.image-viewer-backdrop').click({ position: { x: 5, y: 5 } });
    await viewer.waitFor({ state: 'hidden' });
    await page.locator('.tab[data-tab="favorites"]').click();
    await page.locator('#favorites-list .message-image').click();
    await viewer.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, [], '整页初始化与点击预览不能产生 JavaScript 异常');
    await page.reload();
    await card.waitFor({ state: 'visible' });
    await card.click();
    await viewer.waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    console.log('浏览器验证通过：图片点击、预览按钮、原图、键盘、关闭、收藏和刷新后预览');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => io.close(resolve));
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
