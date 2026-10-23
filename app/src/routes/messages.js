const express = require('express');
const { EXPIRE_HOURS, ACCOUNTS_MODE } = require('../config');
const { requireAuth, resolveCredential } = require('../middleware/auth');
const { getUserState, getMessagesPage, searchMessages, schedulePersist, commitUserMutation, withUserMutation } = require('../storage');
const { deleteMessageFiles, withUploadOperation, commitUploadMutation } = require('../upload');
const { toPublicMessage, persistImageContent, persistFileContent } = require('../message');
const { createMessageId, MAX_SEARCH_QUERY_LEN, readCookie } = require('../utils');
const { deleteSharesByMessageId } = require('../share');

const { trackRouter } = require('../lifecycle');
const router = trackRouter(express.Router());
function sensitive(req) { return req.app.get('sensitiveService'); }
function grant(req, action, messageId) { const token = req.headers['x-sensitive-grant']; if (!token) { const error = new Error('grant required'); error.status = 401; error.code = 'SENSITIVE_GRANT_REQUIRED'; throw error; } return sensitive(req).consume(req, { token, action, messageId }, current => current); }

// ---------------------------------------------------------------------------
// nginx auth_request 内部校验端点：仅接受来自本机/容器网络的请求
router.get('/auth-verify', (req, res) => {
  const service = req.app.get('authService');
  if (service) return requireAuth(req, res, () => res.status(200).end());
  if (ACCOUNTS_MODE) return res.status(503).end();
  const remote = String(req.socket.remoteAddress || '').toLowerCase();
  // 仅 127.0.0.1 / ::1 / RFC1918 私网段（10/8、172.16/12、192.168/16）。
  // 注意：不要用 '172.2' 这类前缀 —— 它会把 172.20.0.0/16 一起放行。
  const isPrivateV4 = (addr) => {
    if (addr.startsWith('10.')) return true;
    if (addr.startsWith('192.168.')) return true;
    if (!addr.startsWith('172.')) return false;
    const second = Number(addr.split('.')[1]);
    return Number.isInteger(second) && second >= 16 && second <= 31;
  };
  const isInternal = remote === '127.0.0.1' || remote === '::1' ||
    remote.startsWith('::ffff:127.') ||
    (remote.startsWith('::ffff:') ? isPrivateV4(remote.slice(7)) : isPrivateV4(remote));
  if (!isInternal) {
    console.warn(`auth-verify 拒绝非容器网络来源: ${remote}`);
    return res.status(403).end();
  }
  // 反向代理下发的 Cookie / 内部头部值为 base64(访问密码)（避免特殊字符破坏 Cookie 语法）；
  // 直连调用时也可能传明文密码。两种形式都接受。
  const raw = req.headers['x-access-password'] || readCookie(req.headers.cookie || '', 'wc_auth') || '';
  const resolved = resolveCredential(raw);
  if (!resolved) return res.status(401).end();
  return res.status(200).end();
});

// 获取消息列表
router.get('/', requireAuth, (req, res) => {
  const userId = req.userId;
  const before = Number(req.query.before);
  const limit = Number(req.query.limit);
  const page = getMessagesPage({ before, limit, userId });

  res.json({
    ...page,
    messages: page.messages.map((msg) => toPublicMessage(msg, userId)),
    expireHours: EXPIRE_HOURS
  });
});

// 全量搜索（服务端）。必须放在 /:id/... 之前，避免路径歧义
router.get('/search', requireAuth, (req, res) => {
  const userId = req.userId;
  const q = String(req.query.q || '').trim().slice(0, MAX_SEARCH_QUERY_LEN);

  // 非法值一律忽略（不报错），避免前端传参异常导致整个搜索不可用
  const num = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const type = typeof req.query.type === 'string' && ['text', 'image', 'file'].includes(req.query.type)
    ? req.query.type
    : undefined;
  const from = num(req.query.from);
  const to = num(req.query.to);

  if (!q && !type && from === undefined && to === undefined) {
    return res.status(400).json({ error: '缺少搜索关键词' });
  }

  const result = searchMessages({
    q,
    type,
    from,
    to,
    before: num(req.query.before),
    limit: num(req.query.limit) || 50,
    userId,
    scope: typeof req.query.scope === 'string' && req.query.scope === 'note' ? 'note' : 'all'
  });

  res.json({
    ...result,
    messages: result.messages.map((msg) => toPublicMessage(msg, userId)),
    expireHours: EXPIRE_HOURS
  });
});

// 创建消息（文本）
router.post('/', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { type, content } = req.body;

  if (!type || !content) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const remark = typeof req.body.remark === 'string' ? req.body.remark.trim().slice(0, 500) : '';

  const message = {
    id: createMessageId(),
    type,
    content,
    remark,
    timestamp: Date.now()
  };

  if (type === 'image' || type === 'file') {
    if (req.body.sensitive === true) return res.status(400).json({ code: 'SENSITIVE_UNAVAILABLE' });
    await withUploadOperation(async () => {
      await commitUploadMutation(userId, async candidate => {
        if (type === 'image') await persistImageContent(message, content, userId);
        else await persistFileContent(message, content, userId);
        candidate.messages.push(message);
      });
    }, { req });
    const publicMessage = toPublicMessage(message, userId);
    req.app.get('io').broadcastMessage(userId, publicMessage);
    return res.json({ success: true, message: publicMessage });
  }
  try {
    if (type === 'text') {
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: '文本内容不能为空' });
      }
      message.content = content;
    } else {
      return res.status(400).json({ error: '不支持的消息类型' });
    }
  } catch (error) {
    console.error('处理消息失败:', error);
    return res.status(400).json({ error: error.message || '消息内容格式错误' });
  }

  if (req.body.sensitive === true) {
    const service = sensitive(req);
    if (!service || type !== 'text') return res.status(400).json({ code: 'SENSITIVE_UNAVAILABLE' });
    service.requireKeyring();
    message.encryptedPayload = service.keyring.encrypt({ content: message.content, remark: message.remark }, { userId, messageId: message.id });
    message.content = null; message.remark = ''; message.sensitive = true;
  }
  await commitUserMutation(userId, candidate => { candidate.messages.push(message); });

  const publicMessage = toPublicMessage(message, userId);

  // 广播消息（需要通过 app.js 传入 io）
  req.app.get('io').broadcastMessage(userId, publicMessage);

  return res.json({ success: true, message: publicMessage });
});

// Sensitive action grants are action- and message-bound and always no-store.
router.post('/:id/sensitive/reauth', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { const service = sensitive(req); if (!service) throw Object.assign(new Error('unavailable'), { status: 503 }); req.body = { ...(req.body || {}), messageId: req.params.id }; const current = service.assertCurrent(req, {}); const record = getUserState(current.user.id).messages.find(item => item.id === req.params.id); if (!record || record.sensitive !== true) return res.status(404).json({ code: 'MESSAGE_NOT_FOUND' }); const result = await service.reauth(req); return res.json(result); }
  catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});
router.post('/:id/sensitive/copy', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const userId = req.userId; const id = req.params.id; const record = getUserState(userId).messages.find(item => item.id === id);
    if (!record || record.sensitive !== true) return res.status(404).json({ code: 'MESSAGE_NOT_FOUND' });
    const plain = sensitive(req).consume(req, { token: req.headers['x-sensitive-grant'], messageId: id, action: 'copy' }, () => sensitive(req).decrypt(record, userId));
    return res.json({ content: plain.content });
  } catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});
router.post('/:id/sensitive/reveal', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const userId = req.userId || sensitive(req).assertCurrent(req, {}).user.id;
    const id = req.params.id;
    const state = getUserState(userId); const record = state.messages.find(item => item.id === id);
    if (!record || record.sensitive !== true) return res.status(404).json({ code: 'MESSAGE_NOT_FOUND' });
    const current = grant(req, 'reveal', id); const plain = sensitive(req).decrypt(record, userId);
    return res.json({ content: plain.content, remark: plain.remark, expiresAt: Date.now() + 120000, context: { userId: current.user.id, sessionId: current.session.id, securityVersion: current.user.security_version } });
  } catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});
router.post('/:id/sensitive/state', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const userId = req.userId || sensitive(req).assertCurrent(req, {}).user.id; const id = req.params.id; const targetSensitive = req.body?.sensitive === true;
    const service = sensitive(req);
    if (!service || typeof req.body?.sensitive !== 'boolean') return res.status(400).json({ code: 'SENSITIVE_UNAVAILABLE' });
    service.requireKeyring();
    const authenticated = service.current(req);
    const identity = { userId, sessionId: authenticated.session.id, securityVersion: authenticated.user.security_version };
    const state = getUserState(userId); const existing = state.messages.find(item => item.id === id);
    if (!existing || existing.type !== 'text') return res.status(404).json({ code: 'MESSAGE_NOT_FOUND' });
    if (Boolean(existing.sensitive) === targetSensitive) return res.json({ success: true, message: toPublicMessage(existing, userId) });
    let plain;
    if (existing.sensitive) { grant(req, targetSensitive ? 'reveal' : 'unmark', id); plain = sensitive(req).decrypt(existing, userId); }
    else { if (targetSensitive) sensitive(req).assertCurrent(req, { userId }); plain = { content: existing.content, remark: existing.remark || '' }; }
    let updated;
    await commitUserMutation(userId, candidate => {
      const index = candidate.messages.findIndex(item => item.id === id); const current = candidate.messages[index];
      if (!current || JSON.stringify(current) !== JSON.stringify(existing)) throw Object.assign(new Error('changed'), { status: 409, code: 'MESSAGE_CHANGED' });
      if (targetSensitive) updated = { ...current, sensitive: true, content: null, remark: '', encryptedPayload: sensitive(req).keyring.encrypt(plain, { userId, messageId: id }) };
      else { const { sensitive: _sensitive, encryptedPayload: _payload, ...normal } = current; updated = { ...normal, sensitive: false, content: plain.content, remark: plain.remark }; }
      candidate.messages[index] = updated;
    });
    sensitive(req).revokeMessage(userId, id);
    const publicMessage = toPublicMessage(updated, userId); req.app.get('io').broadcastSensitive(userId, publicMessage);
    return res.json({ success: true, message: publicMessage });
  } catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});

// 文件上传、预览与下载，共用 /api/messages 前缀。
router.use(require('./files'));

// 删除消息
router.delete('/:id', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { id } = req.params;

  const index = state.messages.findIndex((item) => item.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '消息不存在' });
  }

  const removed = await commitUserMutation(userId, candidate => {
    const position = candidate.messages.findIndex(item => item.id === id);
    if (position < 0) throw Object.assign(new Error('not found'), { status: 404 });
    return candidate.messages.splice(position, 1)[0];
  }, { afterCommit: async ({ result }) => {
    sensitive(req)?.revokeMessage(userId, id);
    await deleteMessageFiles(result, userId);
  } });

  // 删除该消息相关的所有分享
  await deleteSharesByMessageId(id, userId);

  req.app.get('io').broadcastDelete(userId, id);

  return res.json({ success: true });
});

// 清空消息
router.post('/clear', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);

  let favoriteMessages; let removedMessages;
  await commitUserMutation(userId, candidate => {
    favoriteMessages = candidate.messages.filter(msg => msg.favorite);
    removedMessages = candidate.messages.filter(msg => !msg.favorite);
    candidate.messages = favoriteMessages;
  }, { afterCommit: async () => {
    for (const message of removedMessages) sensitive(req)?.revokeMessage(userId, message.id);
    await Promise.allSettled(removedMessages.map(msg => deleteMessageFiles(msg, userId)));
  } });

  // 删除被清空消息的所有相关分享
  await Promise.allSettled(removedMessages.map((msg) => deleteSharesByMessageId(msg.id, userId)));

  req.app.get('io').broadcastClear(userId, { favoriteCount: favoriteMessages.length });

  return res.json({ success: true, favoriteCount: favoriteMessages.length });
});

// 修改消息备注
const handleUpdateRemark = async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { id } = req.params;
  const message = state.messages.find((item) => item.id === id);
  if (!message) {
    return res.status(404).json({ error: '消息不存在' });
  }

  const remark = typeof req.body.remark === 'string' ? req.body.remark.trim().slice(0, 500) : '';
  const service = sensitive(req);
  await commitUserMutation(userId, candidate => {
    const current = candidate.messages.find(item => item.id === id);
    if (!current) throw Object.assign(new Error('not found'), { status: 404 });
    if (current.sensitive === true) {
      if (!service) throw Object.assign(new Error('unavailable'), { status: 503 });
      grant(req, 'remark', id);
      const plain = service.decrypt(current, userId);
      current.encryptedPayload = service.keyring.encrypt({ content: plain.content, remark }, { userId, messageId: id });
      current.remark = ''; current.content = null;
      service.revokeMessage(userId, id);
    } else current.remark = remark;
  });
  const committed = getUserState(userId).messages.find(item => item.id === id);

  const publicMessage = toPublicMessage(committed, userId);
  req.app.get('io').broadcastRemark(userId, { id, remark: publicMessage.remark, message: publicMessage });

  return res.json({ success: true, message: publicMessage });
};

router.patch('/:id/remark', requireAuth, handleUpdateRemark);
router.post('/:id/remark', requireAuth, handleUpdateRemark);

// 更新分类标题
const handleUpdateTitle = async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { id } = req.params;
  const message = state.messages.find((item) => item.id === id);
  if (!message) return res.status(404).json({ error: '消息不存在' });
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 30) : '';
  await commitUserMutation(userId, candidate => {
    const current = candidate.messages.find(item => item.id === id);
    if (!current) throw Object.assign(new Error('not found'), { status: 404 });
    if (title) current.title = title;
    else delete current.title;
  });
  const committed = getUserState(userId).messages.find(item => item.id === id);
  const publicMessage = toPublicMessage(committed, userId);
  req.app.get('io').broadcastTitle(userId, { id, title: publicMessage.title || '', message: publicMessage });
  return res.json({ success: true, message: publicMessage });
};
router.patch('/:id/title', requireAuth, handleUpdateTitle);
router.post('/:id/title', requireAuth, handleUpdateTitle);

// ——— 分组管理（groups）———
// 获取分组列表
router.get('/groups', requireAuth, (req, res) => {
  const state = getUserState(req.userId);
  return res.json({ groups: state.groups || [] });
});

// 新增分组
router.post('/groups', requireAuth, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 30) : '';
  if (!name) return res.status(400).json({ code: 'INVALID_NAME' });
  const state = getUserState(req.userId);
  if ((state.groups || []).includes(name)) return res.json({ groups: state.groups });
  await commitUserMutation(req.userId, candidate => {
    if (!Array.isArray(candidate.groups)) candidate.groups = [];
    if (!candidate.groups.includes(name)) candidate.groups.push(name);
  });
  const newState = getUserState(req.userId);
  req.app.get('io').broadcastGroups(req.userId, { groups: newState.groups });
  return res.json({ groups: newState.groups });
});

// 删除分组（同时清空该分组下所有卡片的 title）
router.delete('/groups/:name', requireAuth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  await commitUserMutation(req.userId, candidate => {
    if (!Array.isArray(candidate.groups)) candidate.groups = [];
    candidate.groups = candidate.groups.filter(g => g !== name);
    candidate.messages.forEach(m => { if (m.title === name) delete m.title; });
  });
  const newState = getUserState(req.userId);
  req.app.get('io').broadcastGroups(req.userId, { groups: newState.groups });
  return res.json({ groups: newState.groups });
});

// ——— 隐私标记（private）———
// 加锁/解锁（永久改 DB 字段，无需验证——内容从未加密，只是前端遮罩）
router.post('/:id/private/toggle', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const userId = req.userId;
    const state = getUserState(userId);
    const id = req.params.id;
    const record = state.messages.find(item => item.id === id);
    if (!record) return res.status(404).json({ code: 'MESSAGE_NOT_FOUND' });

    const targetPrivate = !record.private;
    await commitUserMutation(userId, candidate => {
      const msg = candidate.messages.find(item => item.id === id);
      if (!msg) throw Object.assign(new Error('not found'), { status: 404 });
      if (targetPrivate) msg.private = true;
      else delete msg.private;
    });

    const committed = getUserState(userId).messages.find(item => item.id === id);
    const publicMessage = toPublicMessage(committed, userId);
    req.app.get('io').broadcastPrivate(userId, publicMessage);
    return res.json({ success: true, message: publicMessage });
  } catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});

// 会话解锁验证——消费邮箱验证码，不改 DB，只是证明身份
router.post('/private/verify', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const authService = req.app.get('authService');
    if (!authService) return res.status(503).json({ code: 'AUTH_UNAVAILABLE' });
    const userId = req.userId;
    const { challenge, code } = req.body || {};
    if (!challenge || !code) return res.status(400).json({ code: 'CODE_REQUIRED' });
    authService.emailVerification.consume(challenge, code, {
      userId,
      purpose: 'reauth',
      sessionId: authService.authenticateRequest(req).session.id,
      target: { action: 'private' }
    }, () => true);
    return res.json({ success: true });
  } catch (error) { return res.status(error.status || 500).json({ code: error.code || 'INTERNAL_ERROR' }); }
});

module.exports = router;