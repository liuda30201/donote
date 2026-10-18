const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { setupRoutes } = require('./routes');
const { setupSocket, socketHelper } = require('./socket');
const { ACCOUNTS_MODE } = require('./config');
const { createLifecycle } = require('./lifecycle');

// 创建 Express 应用
function createApp({ authService, securityRouter, adminRouter, sensitiveService, quotaRuntime } = {}) {
  if (ACCOUNTS_MODE && !authService) throw new Error('Accounts mode requires an authentication service');
  const app = express();
  const lifecycle = createLifecycle();
  app.set('lifecycle', lifecycle);
  app.use(lifecycle.middleware);
  if (authService) app.set('authService', authService);
  if (securityRouter) app.set('securityRouter', securityRouter);
  if (adminRouter) app.set('adminRouter', adminRouter);
  if (sensitiveService) app.set('sensitiveService', sensitiveService);
  if (quotaRuntime) { app.set('quotaService', quotaRuntime.quotaService); app.set('uploadPolicy', quotaRuntime.uploadPolicy); }
  // Only trust direct peer addresses until deployment defines explicit trusted proxies.
  // req.socket.remoteAddress remains the transport peer regardless of forwarding headers.
  app.set('trust proxy', false);
  const server = http.createServer(app);

  // 创建 Socket.io 服务器
  const origins = ACCOUNTS_MODE
    ? String(process.env.AUTH_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
    : String(process.env.CORS_ORIGIN || '*').split(',').map(value => value.trim()).filter(Boolean);
  if (ACCOUNTS_MODE && origins.length === 0) throw new Error('Accounts mode requires AUTH_ORIGIN');
  const io = new Server(server, {
    cors: {
      origin: origins,
      credentials: ACCOUNTS_MODE,
      methods: ['GET', 'POST']
    }
  });

  io.engine.use((req, res, next) => lifecycle.stopping ? next(new Error('Server stopping')) : next());
  io.use((socket, next) => lifecycle.stopping ? next(new Error('Server stopping')) : next());

  // 设置 socket helper 到 app，供路由使用
  app.set('io', socketHelper);

  // 设置路由
  setupRoutes(app);

  // 设置 Socket.io 处理
  const sessionSockets = setupSocket(io, { authService });
  if (sessionSockets) app.set('sessionInvalidated', sessionSockets.revalidateSessions);

  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    lifecycle.stop();
    closePromise = (async () => {
      sessionSockets?.close();
      // Socket.IO owns its HTTP server and closes it after disconnecting clients.
      // Its callback waits for HTTP connections; drain also waits for aborted work.
      await new Promise((resolve, reject) => io.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
      await lifecycle.drain();
    })();
    return closePromise;
  }
  return { app, server, io, lifecycle, close };
}

module.exports = {
  createApp
};