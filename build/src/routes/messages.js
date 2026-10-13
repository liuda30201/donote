const express = require('express');

const fs = require('fs/promises');
const path = require('path');
const { MULTI_USER_MODE, EXPIRE_HOURS, MAX_PREVIEW_BYTES } = require('../config');
const { requireAuth, getUserByPassword, resolveCredential } = require('../middleware/auth');
const { getUserState, getMessagesPage, searchMessages, schedulePersist } = require('../storage');
const { getUploadRoot, getUserUploadRoot, getDataFile, SINGLE_USER_DATA_FILE } = require('../storage');
const { uploadMiddleware, resolveUploadAbsolute, deleteMessageFiles, removeFileIfExists } = require('../upload');
const { toPublicMessage, persistImageContent, persistFileContent } = require('../message');
const { createMessageId, toDateFolder, sanitizeFilename, decodeFilename, extensionFromMime, ensureDir, toPosixPath, normalizeImageIncomingContent, decodeDataUrl, contentDisposition, sniffContentType, isActiveContent, isPreviewableText, MAX_SEARCH_QUERY_LEN } = require('../utils');
const { deleteSharesByMessageId } = require('../share');

const router = express.Router();

// ---------------------------------------------------------------------------
// nginx auth_request 内部校验端点：仅接受来自本机/容器网络的请求
router.get('/auth-verify', (req, res) => {
  const remote = String(req.socket.remoteAddress || '').toLowerCase();
  const isInternal = remote === '127.0.0.1' || remote === '::1' ||
    remote.startsWith('::ffff:127.') || remote.startsWith('10.') ||
    remote.startsWith('172.16.') || remote.startsWith('172.17.') ||
    remote.startsWith('172.18.') || remote.startsWith('172.19.') ||
    remote.startsWith('172.2') || remote.startsWith('172.30.') ||
    remote.startsWith('172.31.') || remote.startsWith('192.168.') ||
    remote.startsWith('::ffff:172.') || remote.startsWith('::ffff:10.') ||
    remote.startsWith('::ffff:192.168.');
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
  if (!q) {
    return res.status(400).json({ error: '缺少搜索关键词' });
  }

  // 非法值一律忽略（不报错），避免前端传参异常导致整个搜索不可用
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const result = searchMessages({
    q,
    type: typeof req.query.type === 'string' ? req.query.type : undefined,
    from: num(req.query.from),
    to: num(req.query.to),
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

// multipart/form-data 上传
const uploadFields = uploadMiddleware.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

router.post('/upload', requireAuth, (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      console.error('上传中间件错误:', err);
      return res.status(400).json({ error: err.message || '文件上传失败' });
    }
    next();
  });
}, async (req, res) => {
  const mainFile = req.files && req.files.file ? req.files.file[0] : req.file;
  const thumbFile = req.files && req.files.thumbnail ? req.files.thumbnail[0] : null;

  if (!mainFile) {
    if (thumbFile) await fs.unlink(thumbFile.path).catch(() => {});
    return res.status(400).json({ error: '缺少文件' });
  }

  const userId = req.userId;
  const state = getUserState(userId);
  const uploadRoot = getUploadRoot(userId);

  const type = req.body.type || 'file';
  if (type !== 'image' && type !== 'file') {
    await fs.unlink(mainFile.path).catch(() => {});
    if (thumbFile) await fs.unlink(thumbFile.path).catch(() => {});
    return res.status(400).json({ error: '不支持的消息类型' });
  }

  const id = createMessageId();
  const category = type === 'image' ? 'images' : 'files';
  const dateDir = toDateFolder();
  const decodedName = decodeFilename(mainFile.originalname || 'file');
  const safeName = sanitizeFilename(decodedName);
  const parsed = path.parse(safeName);
  const ext = parsed.ext || extensionFromMime(mainFile.mimetype) || '';
  const suffix = type === 'image' ? '-orig' : '';
  const filename = category === 'files'
    ? `${id}-${parsed.name}${ext}`
    : `${id}${suffix}${ext}`;

  const mainOldPath = mainFile.path;
  const mainRelativePath = path.join(category, dateDir, filename);
  const mainAbsolutePath = path.join(uploadRoot, mainRelativePath);

  await ensureDir(path.dirname(mainAbsolutePath));

  try {
    await fs.rename(mainOldPath, mainAbsolutePath);
  } catch (error) {
    await fs.copyFile(mainOldPath, mainAbsolutePath);
    await fs.unlink(mainOldPath).catch(() => {});
  }

  let thumbRelativePath = mainRelativePath;
  let thumbMimeType = mainFile.mimetype;

  if (type === 'image' && thumbFile) {
    const thumbExt = path.extname(thumbFile.originalname) || extensionFromMime(thumbFile.mimetype) || '.webp';
    const thumbFilename = `${id}-thumb${thumbExt}`;
    const thumbOldPath = thumbFile.path;
    const thumbNewRelPath = path.join(category, dateDir, thumbFilename);
    const thumbNewAbsPath = path.join(uploadRoot, thumbNewRelPath);

    try {
      await fs.rename(thumbOldPath, thumbNewAbsPath);
      thumbRelativePath = thumbNewRelPath;
      thumbMimeType = thumbFile.mimetype;
    } catch (error) {
      try {
        await fs.copyFile(thumbOldPath, thumbNewAbsPath);
        await fs.unlink(thumbOldPath).catch(() => {});
        thumbRelativePath = thumbNewRelPath;
        thumbMimeType = thumbFile.mimetype;
      } catch (copyErr) {
        console.error('保存缩略图失败，回退使用原图:', copyErr);
      }
    }
  } else if (thumbFile) {
    await fs.unlink(thumbFile.path).catch(() => {});
  }

  const remark = typeof req.body.remark === 'string' ? req.body.remark.trim().slice(0, 500) : '';

  const message = {
    id,
    type,
    content: {},
    remark,
    timestamp: Date.now()
  };

  if (type === 'image') {
    message.content = {
      originalPath: mainRelativePath,
      thumbnailPath: thumbRelativePath,
      hasOriginal: Boolean(thumbRelativePath && thumbRelativePath !== mainRelativePath),
      originalMimeType: mainFile.mimetype,
      thumbnailMimeType: thumbMimeType
    };
  } else {
    message.content = {
      name: safeName,
      size: mainFile.size,
      mimeType: mainFile.mimetype,
      filePath: mainRelativePath
    };
  }

  state.messages.push(message);
  state.lastActivity = Date.now();
  schedulePersist(userId);

  const publicMessage = toPublicMessage(message, userId);

  req.app.get('io').broadcastMessage(userId, publicMessage);

  return res.json({ success: true, message: publicMessage });
});

// 读取 Cookie（内部使用）
function readCookie(header, name) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return part.slice(idx + 1).trim(); }
    }
  }
  return null;
}

// 允许通过查询参数 password 或 Cookie wc_auth 认证（供 <img>/<audio>/<video> 直接引用）
function requireAuthOrCookie(req, res, next) {
  const header = req.headers || {};
  const query = req.query || {};
  // Cookie 中的凭据为 base64(密码)，直传的 password 参数为明文，两种都接受
  const resolved = resolveCredential(
    header['x-access-password'],
    query.password,
    readCookie(header.cookie || '', 'wc_auth')
  );
  const userId = getUserByPassword(resolved);
  if (userId === undefined) {
    return res.status(401).json({ error: '未授权访问' });
  }
  const claimed = query.userId || header['x-user-id'] || null;
  if (claimed && userId !== null && claimed !== userId) {
    return res.status(401).json({ error: '未授权访问' });
  }
  req.userId = userId;
  return next();
}

// 统一文件输出：认证 + 安全响应头 + 流式传输
async function serveMessageFile(req, res, options = {}) {
  const userId = req.userId;
  const state = getUserState(userId);
  const message = state.messages.find((item) => item.id === req.params.id);
  if (!message) return res.status(404).json({ error: '消息不存在' });

  let relPath;
  let rawName;
  let mime;

  if (message.type === 'image') {
    const wantOriginal = options.preferOriginal && message.content.originalPath;
    relPath = wantOriginal ? message.content.originalPath : (message.content.thumbnailPath || message.content.originalPath);
    mime = wantOriginal
      ? (message.content.originalMimeType || 'image/png')
      : (message.content.thumbnailMimeType || message.content.originalMimeType || 'image/png');
    rawName = (wantOriginal ? 'image-original' : 'image-thumb') + (path.extname(relPath) || '.png');
  } else if (message.type === 'file') {
    relPath = message.content.filePath;
    rawName = message.content.name || path.basename(relPath || 'file');
    mime = message.content.mimeType || 'application/octet-stream';
  } else {
    return res.status(400).json({ error: '该消息不含文件' });
  }

  const absolute = resolveUploadAbsolute(relPath, userId);
  if (!absolute) return res.status(400).json({ error: '非法路径' });

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') return res.status(404).json({ error: '文件不存在' });
    console.error('读取文件失败:', error);
    return res.status(500).json({ error: '读取文件失败' });
  }

  const active = isActiveContent(rawName, mime);
  const previewable = !active && isPreviewableText(rawName, mime);
  const inlineOk = !active && (message.type === 'image' || (options.allowInline && previewable));
  const safeMime = active ? 'application/octet-stream' : (mime || 'application/octet-stream');

  // 受限预览：只对通过白名单的纯文本类型生效，且限制大小
  if (options.allowInline && previewable && message.type === 'file' && stat.size > MAX_PREVIEW_BYTES) {
    return res.status(413).json({ error: '文件过大，无法在窗口内预览' });
  }

  const inlineType = inlineOk && message.type === 'file' && !active
    ? `${safeMime}; charset=utf-8`
    : safeMime;
  res.setHeader('Content-Type', inlineOk ? inlineType : 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', contentDisposition(rawName, inlineOk ? 'inline' : 'attachment'));
  // 安全响应头：禁止执行任何上传内容
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; img-src 'self' data:; media-src 'self'");
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  return res.sendFile(absolute);
}

// 图片原图/缩略图流式输出（替代超大 base64 JSON）
router.get('/:id/image-file', requireAuthOrCookie, async (req, res) => {
  return serveMessageFile(req, res, { forceImage: true, preferOriginal: req.query.original === '1' });
});

// 文件下载（流式，支持 Range，中文文件名）
// ?inline=1 时允许白名单内的纯文本类型受限内联（供浏览器内文件查看器读取）
router.get('/:id/file-stream', requireAuthOrCookie, async (req, res) => {
  return serveMessageFile(req, res, { forceImage: false, allowInline: req.query.inline === '1' });
});

// 获取原图
router.get('/:id/image-original', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { id } = req.params;
  const message = state.messages.find((item) => item.id === id);
  if (!message) {
    return res.status(404).json({ error: '消息不存在' });
  }
  if (message.type !== 'image') {
    return res.status(400).json({ error: '该消息不是图片' });
  }

  const content = message.content;

  if (content && typeof content === 'object' && typeof content.originalPath === 'string') {
    try {
      const absolute = resolveUploadAbsolute(content.originalPath, userId);
      const binary = await fs.readFile(absolute);
      const mimeType = content.originalMimeType || 'image/png';
      const original = `data:${mimeType};base64,${binary.toString('base64')}`;
      return res.json({ id: message.id, original });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return res.status(404).json({ error: '原图不存在' });
      }
      console.error('读取原图失败:', error);
      return res.status(500).json({ error: '读取原图失败' });
    }
  }

  const legacy = normalizeImageIncomingContent(content);
  if (legacy) {
    return res.json({ id: message.id, original: legacy.original });
  }

  return res.status(404).json({ error: '原图不存在' });
});

// 文件下载
router.get('/:id/file-download', requireAuth, async (req, res) => {
  const userId = req.userId;
  const state = getUserState(userId);
  const { id } = req.params;
  const message = state.messages.find((item) => item.id === id);
  if (!message) {
    return res.status(404).json({ error: '消息不存在' });
  }
  if (message.type !== 'file') {
    return res.status(400).json({ error: '该消息不是文件' });
  }

  const content = message.content;
  if (!content || typeof content !== 'object' || typeof content.filePath !== 'string') {
    return res.status(404).json({ error: '文件不存在' });
  }

  try {
    const absolute = resolveUploadAbsolute(content.filePath, userId);
    const isActive = isActiveContent(content.name, content.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (isActive) res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(content.name, 'attachment'));
    return res.download(absolute, content.name);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return res.status(404).json({ error: '文件不存在' });
    }
    console.error('下载文件失败:', error);
    return res.status(500).json({ error: '下载文件失败' });
  }
});

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