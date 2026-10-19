'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('../../src/security/mailer');

const configured = {
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USER: 'smtp-user', SMTP_PASSWORD: 'smtp-secret', SMTP_FROM: 'DoNote <codes@example.test>'
};
const message = { to: 'reader@example.test', code: '012345', purpose: 'email-change' };

function fixture(env = configured) {
  const options = [];
  const messages = [];
  let closes = 0;
  const transport = {
    async sendMail(mail) { messages.push(mail); return { accepted: [mail.to], rejected: [] }; },
    close() { closes += 1; }
  };
  const mailer = createMailer(env, { createTransport(value) { options.push(value); return transport; } });
  return { mailer, transport, options, messages, closes: () => closes };
}

async function isUnavailable(mailer) {
  assert.equal(mailer.available, false);
  await assert.rejects(mailer.sendCode(message), { message: 'MAIL_UNAVAILABLE', code: 'MAIL_UNAVAILABLE' });
  assert.doesNotThrow(() => { mailer.close(); mailer.close(); });
}

test('unconfigured SMTP is unavailable and never constructs a transport', async () => {
  for (const env of [{}, { SMTP_HOST: '', SMTP_FROM: '' }, null]) {
    const mailer = createMailer(env, { createTransport() { assert.fail('unexpected transport creation'); } });
    await isUnavailable(mailer);
  }
});

test('configured SMTP requires verified STARTTLS and bounded network timeouts', async () => {
  const f = fixture();
  assert.equal(f.mailer.available, true);
  assert.equal(f.options.length, 1);
  const options = f.options[0];
  assert.equal(options.host, configured.SMTP_HOST);
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.ignoreTLS, false);
  assert.deepEqual(options.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true });
  assert.deepEqual(options.auth, { user: configured.SMTP_USER, pass: configured.SMTP_PASSWORD });
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) {
    assert.ok(options[key] > 0 && options[key] <= 15000, key);
  }
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.pool, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  await f.mailer.sendCode(message);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].from, configured.SMTP_FROM);
  assert.equal(f.messages[0].to, message.to);
  assert.match(f.messages[0].text, /012345/);
  assert.match(f.messages[0].text, /绑定或更换/);
  assert.match(f.messages[0].html, /012345/);
  assert.match(f.messages[0].html, /lang="zh-CN"/);
  assert.equal(f.messages[0].subject.includes(message.code), false);
});

test('Chinese templates provide matching HTML and text without external resources or code in subject', async () => {
  const f = fixture();
  for (const [purpose, title] of [
    ['account registration', '欢迎使用 DoNote'], ['login', '确认是你本人登录'],
    ['bind', '验证你的邮箱'], ['reauth', '确认本次安全操作'],
    ['unknown-purpose', '验证你的身份'], ['constructor', '验证你的身份']
  ]) {
    await f.mailer.sendCode({ ...message, purpose });
    const mail = f.messages.at(-1);
    for (const body of [mail.text, mail.html]) {
      assert.ok(body.includes(title));
      assert.ok(body.includes('012345'));
      assert.match(body, /5 分钟/);
      assert.match(body, /仅可使用一次/);
      assert.match(body, /请勿向任何人透露/);
      assert.match(body, /如果这不是你本人的操作/);
    }
    assert.doesNotMatch(mail.html, /<script|<img|<form|https?:\/\//i);
    assert.doesNotMatch(mail.subject, /012345/);
    assert.equal(mail.disableFileAccess, true);
    assert.equal(mail.disableUrlAccess, true);
    assert.equal(mail.html.includes('unknown-purpose'), false);
  }
});

test('login and reauthentication explain non-owner risks without reusing registration advice', async () => {
  const f = fixture();
  for (const purpose of ['login', 'reauth', 'account registration']) {
    await f.mailer.sendCode({ ...message, purpose });
    for (const body of [f.messages.at(-1).text, f.messages.at(-1).html]) {
      if (purpose === 'login') assert.match(body, /可能有人已获取你的账户密码/);
      if (purpose === 'reauth') assert.match(body, /撤销陌生会话/);
      if (purpose === 'account registration') assert.doesNotMatch(body, /已获取你的账户密码/);
    }
  }
});

test('login notices contain escaped event details, no code, and explicit location limitations', async () => {
  const f = fixture();
  for (const kind of ['new-device', 'unusual-location']) {
    await f.mailer.sendLoginNotice({ to: message.to, kind, occurredAt: Date.UTC(2026, 9, 19, 3), device: '<script>alert(1)</script>', ip: '203.0.113.1', location: '中国 & 上海' });
    const mail = f.messages.at(-1);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.doesNotMatch(mail.html, /<script>/);
    assert.match(mail.html, /中国 &amp; 上海/);
    for (const body of [mail.text, mail.html]) {
      assert.match(body, /2026-10-19 03:00:00 UTC/);
      assert.match(body, /203\.0\.113\.1/);
      assert.match(body, /撤销陌生设备会话/);
      assert.match(body, /无需输入验证码/);
      assert.match(body, /VPN、代理或移动网络/);
      assert.doesNotMatch(body, /5 分钟|012345/);
    }
    assert.match(mail.subject, kind === 'new-device' ? /新设备/ : /疑似异地/);
  }
});

test('notice validation fails closed and shares delivery error and lifecycle behavior', async () => {
  const f = fixture();
  const notice = { to: message.to, kind: 'new-device', occurredAt: Date.now() };
  for (const values of [{ kind: 'unknown' }, { to: 'bad' }, { occurredAt: NaN }, { occurredAt: 1e16 }, { device: 'bad\nvalue' }, { ip: 'spoofed' }, { location: 'x'.repeat(201) }, { kind: 'unusual-location' }]) {
    await assert.rejects(f.mailer.sendLoginNotice({ ...notice, ...values }), { code: 'MAIL_INVALID_MESSAGE' });
  }
  assert.equal(f.messages.length, 0);
  f.transport.sendMail = async () => { throw new Error('secret'); };
  await assert.rejects(f.mailer.sendLoginNotice(notice), { code: 'MAIL_UNAVAILABLE' });
  f.mailer.close();
  await assert.rejects(f.mailer.sendLoginNotice(notice), { code: 'MAIL_UNAVAILABLE' });
  await assert.rejects(createMailer({}).sendLoginNotice(notice), { code: 'MAIL_UNAVAILABLE' });
});

test('implicit TLS and safe default ports work with optional relay authentication', () => {
  for (const [overrides, port, secure] of [
    [{ SMTP_SECURE: 'true', SMTP_PORT: undefined }, 465, true],
    [{ SMTP_SECURE: undefined, SMTP_PORT: '465' }, 465, true],
    [{ SMTP_SECURE: undefined, SMTP_PORT: undefined }, 587, false],
    [{ SMTP_SECURE: 'true', SMTP_PORT: '2465' }, 2465, true]
  ]) {
    const f = fixture({ ...configured, ...overrides, SMTP_USER: undefined, SMTP_PASSWORD: undefined });
    assert.equal(f.mailer.available, true);
    assert.equal(f.options[0].port, port);
    assert.equal(f.options[0].secure, secure);
    assert.equal(f.options[0].requireTLS, true);
    assert.equal(f.options[0].auth, undefined);
    f.mailer.close();
  }
});

test('invalid and incomplete configuration fails closed without leaking values', async () => {
  const invalid = [
    { SMTP_HOST: undefined }, { SMTP_FROM: undefined },
    { SMTP_HOST: 'smtp://example.test' }, { SMTP_HOST: 'smtp.example.test\r\nsecret' },
    { SMTP_HOST: '-bad.example.test' }, { SMTP_HOST: 'a..test' },
    { SMTP_PORT: '0' }, { SMTP_PORT: '65536' }, { SMTP_PORT: '587x' },
    { SMTP_PORT: '-1' }, { SMTP_PORT: '1.5' }, { SMTP_PORT: 587 },
    { SMTP_SECURE: 'yes' }, { SMTP_SECURE: true },
    { SMTP_USER: '' }, { SMTP_PASSWORD: '' }, { SMTP_PASSWORD: 123 },
    { SMTP_USER: 'user\r\nsecret' }, { SMTP_PASSWORD: 'secret\nvalue' },
    { SMTP_FROM: 'not-an-address' }, { SMTP_FROM: 'a@example.test,b@example.test' },
    { SMTP_FROM: 'a@example.test\r\nBcc: thief@example.test' },
    { SMTP_FROM: 'DoNote <a@example.test> <b@example.test>' },
    { SMTP_FROM: '.bad@example.test' }, { SMTP_FROM: 'bad..dots@example.test' }
  ];
  for (const values of invalid) {
    const mailer = createMailer({ ...configured, ...values }, {
      createTransport() { assert.fail('invalid configuration must not construct transport'); }
    });
    await isUnavailable(mailer);
  }
});

test('message validation prevents address lists, header injection and invalid codes', async () => {
  const f = fixture();
  for (const values of [
    { to: 'reader@example.test,other@example.test' }, { to: 'a@example.test\r\nBcc: b@example.test' },
    { to: 'Display <reader@example.test>' }, { to: '' }, { code: '' }, { code: 123456 },
    { code: '123456\nInjected' }, { code: 'x'.repeat(129) },
    { code: '12345' }, { code: '1234567' }, { code: 'abcdef' }, { code: '<img/>' },
    { purpose: 'email\r\nInjected' }, { purpose: '' }, { purpose: 'x'.repeat(81) }
  ]) {
    await assert.rejects(f.mailer.sendCode({ ...message, ...values }), { code: 'MAIL_INVALID_MESSAGE' });
  }
  await assert.rejects(f.mailer.sendCode(), { code: 'MAIL_INVALID_MESSAGE' });
  assert.equal(f.messages.length, 0);
});

test('injected transport works and delivery failures expose only generic errors', async () => {
  const secret = 'smtp-secret reader@example.test 012345';
  for (const sendMail of [
    async () => { throw new Error(secret); },
    () => { throw new Error(secret); },
    async () => ({ rejected: [message.to] })
  ]) {
    const mailer = createMailer(configured, { transport: { sendMail } });
    await assert.rejects(mailer.sendCode(message), error => {
      assert.equal(error.message, 'MAIL_UNAVAILABLE');
      assert.equal(error.code, 'MAIL_UNAVAILABLE');
      assert.equal(error.cause, undefined);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});

test('transport initialization failure is unavailable and close is safe and idempotent', async () => {
  await isUnavailable(createMailer(configured, { createTransport() { throw new Error('smtp-secret'); } }));
  await isUnavailable(createMailer(configured, { transport: {} }));
  const f = fixture();
  f.mailer.close();
  f.mailer.close();
  assert.equal(f.closes(), 1);
  await isUnavailable(f.mailer);
  assert.equal(f.messages.length, 0);
  const throwing = createMailer(configured, { transport: { async sendMail() {}, close() { throw new Error('smtp-secret'); } } });
  assert.doesNotThrow(() => throwing.close());
  assert.equal(throwing.available, false);
});
