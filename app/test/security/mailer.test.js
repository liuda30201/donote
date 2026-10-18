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
  assert.match(f.messages[0].text, /email-change/);
  assert.equal(f.messages[0].html, undefined);
  assert.equal(f.messages[0].subject.includes(message.code), false);
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
