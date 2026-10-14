const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { setupRoutes } = require('./routes');
const { setupSocket, socketHelper } = require('./socket');

// 创建 Express 应用
function createApp() {
  const app = express();
  // 注意：不要设置 trust proxy。nginx 的 auth_request 内部校验端点依赖
  // req.socket.remoteAddress 判断来源是否为容器网络，设置 trust proxy 后
  // 该值会被 X-Forwarded-For 覆盖，导致来自 nginx 容器的校验请求被误判为外部请求。
  app.set('trust proxy', false);
  const server = http.createServer(app);

  // 创建 Socket.io 服务器
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // 设置 socket helper 到 app，供路由使用
  app.set('io', socketHelper);

  // 设置路由
  setupRoutes(app);

  // 设置 Socket.io 处理
  setupSocket(io);

  return { app, server, io };
}

module.exports = {
  createApp
};