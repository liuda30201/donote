'use strict';

const net = require('node:net');

const CONFIG_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
const CONTROL = /[\x00-\x1f\x7f]/;

function unavailableError() {
  return Object.assign(new Error('MAIL_UNAVAILABLE'), { code: 'MAIL_UNAVAILABLE' });
}

function unavailableMailer() {
  return { available: false, async sendCode() { throw unavailableError(); }, async sendLoginNotice() { throw unavailableError(); }, close() {} };
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

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Subjects and instructions are static; notice metadata is validated and HTML-escaped.
function renderMessage(code, purpose, notice = null) {
  const copy = {
    'account registration': ['注册验证码', '欢迎使用 DoNote', '你正在创建 DoNote 账户，请在注册页面输入下方验证码，完成邮箱验证。'],
    login: ['登录验证码', '确认是你本人登录', '你正在登录 DoNote，请在登录页面输入下方验证码。'],
    bind: ['邮箱绑定验证码', '验证你的邮箱', '你正在绑定或更换 DoNote 账户邮箱，请在安全设置页面输入下方验证码。'],
    'email-change': ['邮箱绑定验证码', '验证你的邮箱', '你正在绑定或更换 DoNote 账户邮箱，请在安全设置页面输入下方验证码。'],
    reauth: ['安全验证验证码', '确认本次安全操作', '你正在进行 DoNote 账户安全操作，请在发起操作的页面输入下方验证码。']
  };
  const [subject, title, description] = notice
    ? (notice.kind === 'unusual-location'
      ? ['疑似异地登录提醒', '请确认这次登录', '你的 DoNote 账户已完成一次登录，来源地区与近期常用地区不同，请核对以下信息。']
      : ['新设备登录提醒', '你的账户在新设备上登录', '你的 DoNote 账户已在未识别为常用设备的环境中完成登录，请核对以下信息。'])
    : Object.hasOwn(copy, purpose) ? copy[purpose] : ['邮箱验证码', '验证你的身份', '请在 DoNote 中发起验证的页面输入下方验证码。'];
  const warning = notice
    ? '如果这不是你本人的操作，请通过你平时使用的 DoNote 地址进入“账户与设备安全”，撤销陌生设备会话并尽快修改密码。'
    : purpose === 'login'
      ? '如果这不是你本人的操作，可能有人已获取你的账户密码。请勿提供验证码，并通过你平时使用的 DoNote 地址登录，尽快修改密码。'
      : purpose === 'reauth'
        ? '如果这不是你本人的操作，请勿提供验证码。请通过你平时使用的 DoNote 地址检查设备会话，撤销陌生会话并修改密码。'
        : '如果这不是你本人的操作，请忽略此邮件，也不要将验证码提供给他人。';
  const rows = notice ? [
    ['登录时间', new Date(notice.occurredAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')],
    ['设备 / 浏览器', notice.device || '未知设备'], ['来源 IP', notice.ip || '未知'],
    ['大致地区', notice.location || '未知（未获取定位）']
  ] : [];
  const note = notice ? '本邮件为登录通知，无需输入验证码。如果是你本人的操作，无需处理。IP 定位仅供参考，VPN、代理或移动网络可能导致地区偏差。' : '验证码自申请起 5 分钟内有效，仅可使用一次。请勿向任何人透露。';
  return {
    subject: `DoNote · ${subject}`,
    text: `${title}\n\n${description}\n\n${notice ? rows.map(([label, value]) => `${label}：${value}`).join('\n') : `验证码：${code}`}\n\n${note}\n\n${warning}\n此邮件由系统自动发送，请勿直接回复。\n\nDoNote · 安静、私有的跨设备剪贴工作台`,
    html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f7;color:#1d1d1f;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${subject}。${notice ? '请核对本次登录信息。' : '自申请起 5 分钟内有效。请勿向任何人透露。'}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="padding:0 8px 20px;font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#1d1d1f;">DoNote<span style="font-size:12px;font-weight:400;letter-spacing:0;color:#6e6e73;"> &nbsp; / &nbsp; 账户安全</span></td></tr>
<tr><td style="padding:32px 24px;background-color:#ffffff;border:1px solid #e5e5ea;border-radius:16px;">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.4;font-weight:600;color:#1d1d1f;">${title}</h1>
<p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#515154;">${description}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;background-color:#f5f5f7;border:1px solid #e5e5ea;border-radius:12px;">
${notice ? rows.map(([label, value]) => `<p style="margin:8px 0;text-align:left;font-size:13px;line-height:1.8;overflow-wrap:anywhere;color:#515154;"><strong>${label}</strong><br>${escapeHtml(value)}</p>`).join('') : `<p style="margin:0 0 10px;font-size:12px;color:#6e6e73;">${subject}</p>
<div dir="ltr" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:34px;font-weight:700;letter-spacing:6px;line-height:1.4;color:#1d1d1f;white-space:nowrap;">${code}</div>`}
</td></tr></table>
<p style="margin:20px 0 0;font-size:13px;line-height:1.8;color:#515154;">${note}</p>
<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e5ea;font-size:12px;line-height:1.8;color:#6e6e73;">${warning}</p>
</td></tr>
<tr><td align="center" style="padding:24px 8px;font-size:12px;line-height:1.8;color:#6e6e73;">DoNote · 安静、私有的跨设备剪贴工作台<br>此邮件由系统自动发送，请勿直接回复。</td></tr>
</table></td></tr></table>
</body></html>`
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
  async function deliver(to, content) {
    try {
      const result = await transport.sendMail({ from: config.from, to, ...content, disableFileAccess: true, disableUrlAccess: true });
      if (result && Array.isArray(result.rejected) && result.rejected.length) throw unavailableError();
    } catch {
      // SMTP diagnostics may contain credentials and message content.
      throw unavailableError();
    }
  }
  return {
    get available() { return !closed; },
    async sendCode({ to, code, purpose } = {}) {
      if (closed) throw unavailableError();
      if (!mailbox(to) || typeof code !== 'string' || !/^\d{6}$/.test(code) ||
        typeof purpose !== 'string' || !/^[a-z0-9][a-z0-9 _-]{0,79}$/i.test(purpose)) {
        throw Object.assign(new Error('MAIL_INVALID_MESSAGE'), { code: 'MAIL_INVALID_MESSAGE' });
      }
      await deliver(to, renderMessage(code, purpose));
    },
    // Server-only integration point. No automatic detection or public sending route.
    async sendLoginNotice({ to, kind, occurredAt, device, ip, location } = {}) {
      if (closed) throw unavailableError();
      const safeText = value => value === undefined || (typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value));
      if (!mailbox(to) || !['new-device', 'unusual-location'].includes(kind) ||
          !Number.isSafeInteger(occurredAt) || occurredAt < 0 || !Number.isFinite(new Date(occurredAt).getTime()) ||
          !safeText(device) || !safeText(location) || (ip !== undefined && (typeof ip !== 'string' || !net.isIP(ip))) ||
          (kind === 'unusual-location' && !location?.trim())) {
        throw Object.assign(new Error('MAIL_INVALID_MESSAGE'), { code: 'MAIL_INVALID_MESSAGE' });
      }
      await deliver(to, renderMessage(null, null, { kind, occurredAt, device, ip, location }));
    },
    close() {
      if (closed) return;
      closed = true;
      try { if (typeof transport.close === 'function') transport.close(); } catch { /* No SMTP diagnostics escape. */ }
    }
  };
}

module.exports = { createMailer };
