'use strict';

const net = require('node:net');

const CONFIG_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
const CONTROL = /[\x00-\x1f\x7f]/;

function unavailableError() {
  return Object.assign(new Error('MAIL_UNAVAILABLE'), { code: 'MAIL_UNAVAILABLE' });
}

function unavailableMailer() {
  return { available: false, async sendCode() { throw unavailableError(); }, close() {} };
}

function hostname(value) {
  return typeof value === 'string' && value.length <= 253 &&
    (net.isIP(value) !== 0 || value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
}

function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || CONTROL.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length <= 64 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(parts[0]) &&
    net.isIP(parts[1]) === 0 && hostname(parts[1]);
}

function sender(value) {
  if (mailbox(value)) return true;
  if (typeof value !== 'string' || value.length > 320 || CONTROL.test(value)) return false;
  // A single unquoted display name and mailbox; reject lists and header syntax.
  const match = /^([^<>@,;:"\\]+) <([^<>]+)>$/.exec(value);
  return Boolean(match && match[1].trim() && mailbox(match[2]));
}

function configuration(env) {
  if (!env || typeof env !== 'object' || !CONFIG_KEYS.some(key => env[key] !== undefined && env[key] !== '')) return null;
  const host = env.SMTP_HOST;
  const from = env.SMTP_FROM;
  if (!hostname(host) || !sender(from)) return null;
  if (env.SMTP_SECURE !== undefined && env.SMTP_SECURE !== '' && !['true', 'false'].includes(env.SMTP_SECURE)) return null;
  const rawPort = env.SMTP_PORT;
  if (rawPort !== undefined && rawPort !== '' && (typeof rawPort !== 'string' || !/^[0-9]{1,5}$/.test(rawPort))) return null;
  const secure = env.SMTP_SECURE === 'true' || ((!env.SMTP_SECURE) && rawPort === '465');
  const port = rawPort ? Number(rawPort) : secure ? 465 : 587;
  if (port < 1 || port > 65535) return null;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASSWORD;
  const hasUser = user !== undefined && user !== '';
  const hasPass = pass !== undefined && pass !== '';
  if (hasUser !== hasPass || (hasUser && (typeof user !== 'string' || user.length > 1024 || CONTROL.test(user) ||
    typeof pass !== 'string' || pass.length > 4096 || CONTROL.test(pass)))) return null;
  return {
    from,
    options: {
      host, port, secure,
      requireTLS: true,
      ignoreTLS: false,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      dnsTimeout: 10000,
      pool: false,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...(hasUser ? { auth: { user, pass } } : {})
    }
  };
}

/** Create an SMTP sender. Tests may supply { transport } or { createTransport(options) }. */
function createMailer(env = process.env, dependencies = {}) {
  const config = configuration(env);
  if (!config) return unavailableMailer();
  let transport;
  try {
    const createTransport = dependencies.createTransport || (options => require('nodemailer').createTransport(options));
    transport = dependencies.transport || createTransport(config.options);
    if (!transport || typeof transport.sendMail !== 'function') return unavailableMailer();
  } catch {
    return unavailableMailer();
  }
  let closed = false;
  return {
    get available() { return !closed; },
    async sendCode({ to, code, purpose } = {}) {
      if (closed) throw unavailableError();
      if (!mailbox(to) || typeof code !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(code) ||
        typeof purpose !== 'string' || !/^[a-z0-9][a-z0-9 _-]{0,79}$/i.test(purpose)) {
        throw Object.assign(new Error('MAIL_INVALID_MESSAGE'), { code: 'MAIL_INVALID_MESSAGE' });
      }
      try {
        const result = await transport.sendMail({
          from: config.from,
          to,
          subject: 'DoNote verification code',
          text: `Your DoNote verification code is: ${code}\n\nPurpose: ${purpose}\n\nIf you did not request this code, you can ignore this email.`,
          disableFileAccess: true,
          disableUrlAccess: true
        });
        if (result && Array.isArray(result.rejected) && result.rejected.length) throw unavailableError();
      } catch {
        // SMTP errors can contain credentials, recipient addresses or message content.
        throw unavailableError();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { if (typeof transport.close === 'function') transport.close(); } catch { /* No SMTP diagnostics escape. */ }
    }
  };
}

module.exports = { createMailer };
