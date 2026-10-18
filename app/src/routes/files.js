const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { MAX_PREVIEW_BYTES } = require('../config');
const { requireAuth, getUserByPassword, resolveCredential } = require('../middleware/auth');
const { getUserState, getUploadRoot, schedulePersist } = require('../storage');
const { uploadMiddleware, resolveUploadAbsolute, resolveUploadPolicy, withUploadOperation, commitUploadMutation, actualFileBytes } = require('../upload');
const { toPublicMessage } = require('../message');
const {
  createMessageId, toDateFolder, sanitizeFilename, decodeFilename,
  extensionFromMime, ensureDir, toPosixPath, normalizeImageIncomingContent,
  contentDisposition, isActiveContent, isPreviewableText, readCookie
} = require('../utils');

const { trackRouter } = require('../lifecycle');
const router = trackRouter(express.Router());

// multipart/form-data 上传：Multer、文件发布、usage admission 和JSON提交
// 全程占用同一个进程级 upload slot；落盘真实字节由文件流计数及lstat复核。
const uploadFields = uploadMiddleware.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

router.post('/upload', requireAuth, async (req, res) => {
  try {
    const result = await withUploadOperation(async () => {
      await new Promise((resolve, reject) => uploadFields(req, res, error => error ? reject(error) : resolve()));
      const mainFile = req.files?.file?.[0] || req.file;
      const thumbFile = req.files?.thumbnail?.[0] || null;
      if (!mainFile) {
        const error = new Error('缺少文件'); error.statusCode = 400; throw error;
      }
      const userId = req.userId;
      const type = req.body.type || 'file';
      if (!['image', 'file'].includes(type)) { const error = new Error('不支持的消息类型'); error.statusCode = 400; throw error; }
      if (type !== 'image' && thumbFile) { const error = new Error('非图片上传不接受缩略图'); error.statusCode = 400; throw error; }

      const mainBytes = await actualFileBytes(mainFile.path);
      const thumbBytes = thumbFile ? await actualFileBytes(thumbFile.path) : 0;
      if (mainBytes + thumbBytes > 2 * 100 * 1024 * 1024) { const error = new Error('上传内容过大'); error.statusCode = 413; throw error; }
      const id = createMessageId();
      const category = type === 'image' ? 'images' : 'files';
      const dateDir = toDateFolder();
      const safeName = sanitizeFilename(decodeFilename(mainFile.originalname || 'file'));
      const parsed = path.parse(safeName);
      const ext = parsed.ext || extensionFromMime(mainFile.mimetype) || '';
      const mainName = category === 'files' ? `${id}-${parsed.name}${ext}` : `${id}-orig${ext}`;
      const mainRelativePath = path.join(category, dateDir, mainName);
      const thumbRelativePath = thumbFile
        ? path.join(category, dateDir, `${id}-thumb${path.extname(thumbFile.originalname) || extensionFromMime(thumbFile.mimetype) || '.webp'}`)
        : mainRelativePath;
      const remark = typeof req.body.remark === 'string' ? req.body.remark.trim().slice(0, 500) : '';
      const message = { id, type, content: {}, remark, timestamp: Date.now() };
      if (type === 'image') {
        message.content = {
          originalPath: mainRelativePath,
          thumbnailPath: thumbRelativePath,
          hasOriginal: Boolean(thumbFile),
          originalMimeType: mainFile.mimetype,
          thumbnailMimeType: thumbFile?.mimetype || mainFile.mimetype
        };
      } else {
        message.content = { name: safeName, size: mainBytes, mimeType: mainFile.mimetype, filePath: mainRelativePath };
      }

      const policy = resolveUploadPolicy(req);
      await commitUploadMutation(userId, async candidate => {
        const mainTarget = resolveUploadAbsolute(mainRelativePath, userId);
        const thumbTarget = thumbFile ? resolveUploadAbsolute(thumbRelativePath, userId) : null;
        const { publishTempFile } = require('../upload');
        await publishTempFile(mainFile.path, mainRelativePath, userId);
        if (thumbFile) await publishTempFile(thumbFile.path, thumbRelativePath, userId);
        // Verify actual published bytes, never the multipart header's declared size.
        const finalMainSize = await actualFileBytes(mainTarget);
        if (thumbTarget) await actualFileBytes(thumbTarget);
        if (type === 'file') message.content.size = finalMainSize;
        candidate.messages.push(message);
        return toPublicMessage(message, userId);
      }, { policy });
      const publicMessage = toPublicMessage(message, userId);
      req.app.get('io')?.broadcastMessage(userId, publicMessage);
      return publicMessage;
    }, { req });
    if (res.destroyed || res.writableEnded) return;
    return res.json({ success: true, message: result });
  } catch (error) {
    console.error('文件上传失败:', error);
    if (res.destroyed || res.writableEnded) return;
    const status = error.statusCode || (error.code === 'UPLOAD_TOO_LARGE' || error.code === 'QUOTA_EXCEEDED' ? 413 : error.code === 'UPLOAD_POLICY_UNAVAILABLE' ? 503 : 400);
    return res.status(status).json({ error: status === 413 ? '存储空间或上传大小超限' : status === 503 ? '上传服务暂不可用' : (error.statusCode === 400 ? error.message : '文件上传失败'), code: error.code || 'UPLOAD_FAILED' });
  }
});

// Media elements authenticate through the HttpOnly session cookie or proxy header.
function requireAuthOrCookie(req, res, next) {
  if (req.app.get('authService')) return requireAuth(req, res, next);
  const header = req.headers || {};
  // Legacy cookie credentials are base64 encoded; never accept URL passwords.
  const resolved = resolveCredential(
    header['x-access-password'],
    readCookie(header.cookie || '', 'wc_auth')
  );
  const userId = getUserByPassword(resolved);
  if (userId === undefined) {
    return res.status(401).json({ error: '未授权访问' });
  }
  const claimed = req.query?.userId || header['x-user-id'] || null;
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

module.exports = router;
