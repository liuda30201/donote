const { MULTI_USER_MODE, ACCESS_PASSWORD, userPasswordMap } = require('../config');
const { readCookie } = require('../utils');

// 由密码推导 userId。单用户模式返回 null，多用户模式返回 userId，未匹配返回 undefined
function getUserByPassword(password) {
  if (!password) return undefined;
  if (MULTI_USER_MODE) {
    return userPasswordMap.get(password);
  }
  if (ACCESS_PASSWORD) {
    return password === ACCESS_PASSWORD ? null : undefined;
  }
  return null; // 未设置密码时不启用保护（部署时由反向代理强制要求密码）
}

// 解析请求中的访问凭据。
// 反向代理会把 Cookie 值（base64(密码)）原样放进 X-Access-Password 头，
// 因此明文与 base64 两种形式都要尝试。
function resolveCredential(...candidates) {
  const seen = new Set();
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (getUserByPassword(value) !== undefined) return value;
    // 尝试 base64 解码（Cookie / 代理内部头使用该编码）
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (decoded && !seen.has(decoded) && getUserByPassword(decoded) !== undefined) {
        return decoded;
      }
    } catch {
      // 解码失败，继续尝试下一个候选值
    }
  }
  return '';
}

// 统一的安全性认证中间件
function requireAuth(req, res, next) {
  const service = req.app && req.app.get('authService');
  if (service) return createSessionAuth(service)(req, res, next);
  const headers = req.headers || {};
  const query = req.query || {};
  const body = req.body || {};

  // 尝试从各个通道获取密码凭证和用户ID
  const cookieHeader = headers.cookie || '';
  const password = resolveCredential(
    headers['x-access-password'],
    body.password,
    readCookie(cookieHeader, 'wc_auth')
  );
  const userId = headers['x-user-id'] || body.userId || query.userId || null;

  if (MULTI_USER_MODE) {
    // 多用户模式
    if (!password) {
      return res.status(401).json({ error: '未授权访问：缺少凭证' });
    }

    const matchedUserId = userPasswordMap.get(password);
    if (!matchedUserId) {
      return res.status(401).json({ error: '未授权访问：凭证无效' });
    }

    // 校验传入的 userId 是否与由密码推导出的匹配
    if (userId && matchedUserId !== userId) {
      return res.status(401).json({ error: '未授权访问：凭证与用户ID不匹配' });
    }

    // 绑定校验成功后的真实 userId
    req.userId = matchedUserId;
    return next();
  }

  // 单用户模式
  if (ACCESS_PASSWORD) {
    if (password !== ACCESS_PASSWORD) {
      return res.status(401).json({ error: '未授权访问：密码错误' });
    }
  }

  req.userId = null;
  return next();
}

function createSessionAuth(service) {
  return (req, res, next) => {
    try {
      const authenticated = service.authenticateRequest(req);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) service.requireCsrf(req, authenticated);
      res.set('Cache-Control', 'no-store');
      req.userId = authenticated.user.id;
      req.auth = authenticated.context;
      req.authenticated = authenticated;
      next();
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      const code = Number.isInteger(error.status) ? error.code : 'AUTH_FAILED';
      res.status(Number.isInteger(error.status) ? error.status : 401).json({ code, error: code });
    }
  };
}

module.exports = {
  requireAuth,
  createSessionAuth,
  getUserByPassword,
  resolveCredential
};
