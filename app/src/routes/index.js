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
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
}

// 设置 API 路由
function setupApiRoutes(app) {
  // 认证路由
  app.use('/api', authRoutes.router);

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
  // 静态文件（前端）
  const publicPath = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicPath));

  // 上传文件静态路由
  setupUploadRoutes(app);

  // JSON 解析中间件
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  // API 路由
  setupApiRoutes(app);

  // 分享功能已禁用：不注册分享页面路由，分享接口由反向代理层直接拒绝
}

module.exports = {
  setupRoutes,
  extractUserId: authRoutes.extractUserId
};