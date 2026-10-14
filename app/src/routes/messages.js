const express = require('express');
const { EXPIRE_HOURS } = require('../config');
const { requireAuth, resolveCredential } = require('../middleware/auth');
const { getUserState, getMessagesPage, searchMessages, schedulePersist } = require('../storage');
const { deleteMessageFiles } = require('../upload');
const { toPublicMessage, persistImageContent, persistFileContent } = require('../message');
const { createMessageId, MAX_SEARCH_QUERY_LEN, readCookie } = require('../utils');
const { deleteSharesByMessageId } = require('../share');

const router = express.Router();

// ---------------------------------------------------------------------------
// nginx auth_request 内部校验端点：仅接受来自本机/容器网络的请求
router.get('/auth-verify', (req, res) => {
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
    userId
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

  try {
    if (type === 'image') {
      await persistImageContent(message, content, userId);
    } else if (type === 'file') {
      await persistFileContent(message, content, userId);
    } else if (type === 'text') {
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

  state.messages.push(message);
  state.lastActivity = Date.now();
  schedulePersist(userId);

  const publicMessage = toPublicMessage(message, userId);

  // 广播消息（需要通过 app.js 传入 io）
  req.app.get('io').broadcastMessage(userId, publicMessage);

  return res.json({ success: true, message: publicMessage });
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

  const [removed] = state.messages.splice(index, 1);
  state.lastActivity = Date.now();
  schedulePersist(userId);

  await deleteMessageFiles(removed, userId);

  // 删除该消息相关的所有分享
  await deleteSharesByMessageId(id, userId);

  req.app.get('io').broadcastDelete(userId, id);

  return res.json({ success: true });
});

// 清空消息
router.post('/clear', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);

  const favoriteMessages = state.messages.filter((msg) => msg.favorite);
  const removedMessages = state.messages.filter((msg) => !msg.favorite);

  state.messages = favoriteMessages;
  state.lastActivity = Date.now();
  schedulePersist(userId);

  await Promise.allSettled(removedMessages.map((msg) => deleteMessageFiles(msg, userId)));

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
  message.remark = remark;
  state.lastActivity = Date.now();
  schedulePersist(userId);

  const publicMessage = toPublicMessage(message, userId);
  req.app.get('io').broadcastRemark(userId, { id, remark, message: publicMessage });

  return res.json({ success: true, message: publicMessage });
};

router.patch('/:id/remark', requireAuth, handleUpdateRemark);
router.post('/:id/remark', requireAuth, handleUpdateRemark);

module.exports = router;