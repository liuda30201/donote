const fs = require('fs/promises');
const path = require('path');
const { MIME_EXTENSION_MAP, MESSAGE_PAGE_SIZE, MULTI_USER_MODE } = require('./config');

const MAX_DATA_URL_BYTES = 110 * 1024 * 1024;

// 分页大小限制
function clampPageSize(limit) {
  if (!Number.isFinite(limit)) return MESSAGE_PAGE_SIZE;
  return Math.min(Math.max(limit, 1), 100);
}

// 检查是否为 Data URL
function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:');
}

// 转换为 POSIX 路径
function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

// 获取上传文件 URL
function toUploadUrl(relativePath, userId = null) {
  if (MULTI_USER_MODE && userId) {
    return `/uploads/${userId}/${toPosixPath(relativePath)}`;
  }
  return `/uploads/${toPosixPath(relativePath)}`;
}

// 生成日期文件夹名
function toDateFolder(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 创建消息 ID
//
// 为什么不用 Math.random()：
//   1) V8 的 Math.random 是可预测的 xorshift128+，攻击者拿到几个 ID 就能推算后续值；
//      ID 在本项目里直接出现在 URL 中（/api/messages/:id/...），且是删除消息的唯一凭据；
//   2) Math.random().toString(36).slice(2, 7) 只有 5 个 base36 字符 ≈ 30 bit，生日碰撞
//      在几十万条量级就会实际发生，不同消息撞 ID 会导致互相覆盖/误删。
// 这里改用 crypto.randomUUID()（Node 14.17+ 内置，122 bit 随机），时间戳前缀保留，
// 便于按创建时间粗略排序与人工排查。
function createMessageId() {
  const { randomUUID } = require('crypto');
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

// 解码文件名（处理 multipart 上传时的编码问题）
function decodeFilename(originalname) {
  if (!originalname || typeof originalname !== 'string') {
    return 'file';
  }
  try {
    const latin1Buffer = Buffer.from(originalname, 'latin1');
    const utf8String = latin1Buffer.toString('utf8');
    if (utf8String && !utf8String.includes('\ufffd')) {
      return utf8String;
    }
  } catch (e) {
  }
  return originalname;
}

// 清理文件名
function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    return 'file';
  }
  return filename
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}._\- ]/gu, '_')
    .trim()
    .slice(0, 120) || 'file';
}

// 从 MIME 类型获取扩展名
function extensionFromMime(mimeType) {
  if (!mimeType) return '';
  return MIME_EXTENSION_MAP[mimeType] || '';
}

// 解码 Data URL
function decodeDataUrl(dataUrl) {
  if (!isDataUrl(dataUrl)) {
    throw new Error('invalid data url');
  }

  // Reject oversized input before regex captures or decoding allocate more memory.
  if (dataUrl.length > MAX_DATA_URL_BYTES || Buffer.byteLength(dataUrl, 'utf8') > MAX_DATA_URL_BYTES) {
    throw Object.assign(new Error('data url too large'), { code: 'UPLOAD_TOO_LARGE', status: 413 });
  }
  const matched = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]+)$/);
  if (!matched) {
    throw new Error('malformed data url');
  }

  const mimeType = matched[1] || 'application/octet-stream';
  const isBase64 = Boolean(matched[2]);
  const payload = matched[3] || '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  return { mimeType, buffer };
}

// 规范化图片输入内容
function normalizeImageIncomingContent(content) {
  if (isDataUrl(content)) {
    return { thumbnail: content, original: content };
  }

  if (content && typeof content === 'object') {
    const thumbnail = isDataUrl(content.thumbnail) ? content.thumbnail : null;
    const original = isDataUrl(content.original) ? content.original : null;

    if (!thumbnail && !original) return null;

    return {
      thumbnail: thumbnail || original,
      original: original || thumbnail
    };
  }

  return null;
}

// 确保目录存在
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

// 添加优先扩展名
function withPreferredExt(filename, fallbackExt) {
  const parsed = path.parse(filename || '');
  const ext = parsed.ext || fallbackExt || '';
  const base = parsed.name || 'file';
  return `${base}${ext}`;
}

// 搜索关键词最大长度，防止超长输入
// 注意：必须声明在 module.exports 之前 —— module.exports 在模块顶层立即求值，
// 引用到尚未初始化的 const 会抛 ReferenceError（TDZ），进程直接起不来。
const MAX_SEARCH_QUERY_LEN = 200;

module.exports = {
  isActiveContent,
  isPreviewableText,
  sniffContentType,
  contentDisposition,
  readCookie,
  clampPageSize,
  MAX_SEARCH_QUERY_LEN,
  isDataUrl,
  toPosixPath,
  toUploadUrl,
  toDateFolder,
  createMessageId,
  sanitizeFilename,
  decodeFilename,
  extensionFromMime,
  decodeDataUrl,
  normalizeImageIncomingContent,
  ensureDir,
  withPreferredExt
};

// 读取 Cookie 中的指定键（无第三方依赖）
function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}


// 判断是否为可被浏览器当作“主动内容”执行的文件类型
function isActiveContent(name, mime) {
  const lowerName = String(name || '').toLowerCase();
  const lowerMime = String(mime || '').toLowerCase().split(';')[0].trim();
  const dangerousMime = new Set([
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
    'application/javascript', 'text/javascript', 'application/x-javascript',
    'application/x-shockwave-flash', 'text/x-component', 'application/x-httpd-php'
  ]);
  if (dangerousMime.has(lowerMime)) return true;
  return /\.(html?|xhtml|svgz?|xml|js|mjs|mht|mhtml|swf|hta|vbs|wsf|shtml|php[0-9]?)$/.test(lowerName);
}

// 与文件内容匹配的安全 Content-Type（仅在确认非主动内容时使用）
function sniffContentType(name, mime) {
  if (isActiveContent(name, mime)) return 'application/octet-stream';
  return mime || 'application/octet-stream';
}

// 可在浏览器窗口内以纯文本安全预览的类型（白名单）
// 注意：必须在 isActiveContent 之上叠加——主动内容一律不可预览
const PREVIEWABLE_MIME = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/yaml'
]);

const PREVIEWABLE_EXT = /\.(json|jsonl|ndjson|txt|md|markdown|csv|tsv|log|ya?ml|ini|conf|properties|env|toml|editorconfig|gitignore)$/;

// 判断文件是否允许在浏览器内以受限方式（inline 纯文本）预览
function isPreviewableText(name, mime) {
  if (isActiveContent(name, mime)) return false;
  const lowerMime = String(mime || '').toLowerCase().split(';')[0].trim();
  if (PREVIEWABLE_MIME.has(lowerMime)) return true;
  const lowerName = String(name || '').toLowerCase();
  return PREVIEWABLE_EXT.test(lowerName);
}

// RFC 6266 / RFC 5987 兼容的内容处置头，正确处理中文文件名
function contentDisposition(name, disposition = 'attachment') {
  const fallback = String(name || 'download')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(String(name || 'download')).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
