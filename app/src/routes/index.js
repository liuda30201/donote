const path = require('path');
const express = require('express');
const authRoutes = require('./auth');
const messagesRoutes = require('./messages');
const favoritesRoutes = require('./favorites');

const { apiLimiter } = require('../middleware/rateLimit');

// 上传目录不再直接对外静态服务：任何文件必须经过带认证的流式接口
// 反向代理层亦对 /uploads/ 返回 404，双重保险
function setupUploadRoutes(app) {
  app.use('/uploads', (req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });
}

// 所有 API 路由之后统一返回 JSON 404，便于前端解析错误。
function apiNotFound(req, res) {
  res.status(404).json({ error: 'Not Found' });
}

// 设置 API 路由
function setupApiRoutes(app) {
  // 认证路由
  const authService = app.get('authService');
  app.use('/api', authService ? authRoutes.createAuthRouter({ authService }) : authRoutes.router);
  if (app.get('securityRouter')) app.use('/api', app.get('securityRouter'));
  if (app.get('adminRouter')) app.use('/api', app.get('adminRouter'));

  // 消息路由（需要在 /api/messages 路径）
  app.use('/api/messages', apiLimiter, messagesRoutes);

  // 收藏路由（需要在 /api/messages 路径，但 favorites.js 已经处理了 /:id/favorite）
  // 所以 favorites 路由需要挂载到 /api/messages
  app.use('/api/messages', apiLimiter, favoritesRoutes);

  // 兼容旧的路由 /api/favorites
  app.use('/api/favorites', apiLimiter, favoritesRoutes);

  // 分享接口已禁用（用户要求关闭公开分享入口）：返回 404，且反向代理层同样拒绝
  app.use('/api/share', (req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // 必须放在最后
  app.use('/api', apiNotFound);
}

// 设置所有路由
function setupRoutes(app) {
  // 官网是默认入口，认证工作台保留独立入口，避免营销页和应用状态互相干扰。
  const publicPath = path.join(__dirname, '..', '..', 'public');
  app.get(['/login', '/app'], (req, res) => {
    res.sendFile(path.join(publicPath, 'app.html'));
  });
  app.use(express.static(publicPath));

  // 上传文件静态路由
  setupUploadRoutes(app);

  // JSON 解析中间件
  // JSON and form endpoints carry metadata only; file uploads use Multer streams.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  // API 路由
  setupApiRoutes(app);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = error.code || 'INTERNAL_ERROR';
    const quotaStatus = code === 'QUOTA_EXCEEDED' || code === 'UPLOAD_TOO_LARGE' ? 413
      : code === 'DISK_HEADROOM' ? 507
      : /^(USAGE_|MUTATION_|UPLOAD_POLICY_|ACCOUNT_UNAVAILABLE)/.test(code) ? 503 : null;
    const status = quotaStatus || error.status || error.statusCode || 500;
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ code, error: status === 413 ? '存储空间或上传大小超限' : status >= 500 ? '服务暂不可用' : '请求无法完成' });
  });

  // 分享功能已禁用：不注册分享页面路由，分享接口由反向代理层直接拒绝
}

module.exports = {
  setupRoutes,
  extractUserId: authRoutes.extractUserId
};