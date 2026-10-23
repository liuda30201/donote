'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMailer } = require('../src/security/mailer');

const envPath = path.resolve(__dirname, '../../.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let v = t.slice(i + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i)] = v;
}

const to = process.argv[2] || 'kudeer@qq.com';
const mailer = createMailer(env);
if (!mailer.available) {
  console.error('MAIL_UNAVAILABLE: SMTP config was rejected');
  process.exit(1);
}

const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
mailer.sendCode({ to, code, purpose: 'account registration' })
  .then(() => {
    console.log('SENT');
    console.log('TO=' + to);
    console.log('PURPOSE=account registration');
    console.log('CODE=' + code);
    console.log('HOST=' + env.SMTP_HOST);
    console.log('PORT=' + env.SMTP_PORT);
    console.log('SECURE=' + env.SMTP_SECURE);
    mailer.close();
  })
  .catch((err) => {
    console.error('FAILED');
    console.error('code=' + err.code);
    console.error('message=' + err.message);
    mailer.close();
    process.exit(1);
  });
