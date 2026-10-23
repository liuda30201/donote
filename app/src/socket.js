const { MULTI_USER_MODE, ACCESS_PASSWORD, SOCKET_SYNC_LIMIT, userPasswordMap } = require('./config');
const { getMessagesPage } = require('./storage');
const { toPublicMessage } = require('./message');

// Socket.io 广播辅助对象
const socketHelper = {
  io: null,

  // 设置 io 实例
  setIo(ioInstance, sessionBroadcast = null) {
    this.io = ioInstance;
    this.sessionBroadcast = sessionBroadcast;
  },

  // 广播新消息
  broadcastMessage(userId, message) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-new', message);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-new', message);
    } else {
      this.io.emit('message-new', message);
    }
  },

  broadcastSensitive(userId, message) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-sensitive', message);
    if (MULTI_USER_MODE && userId) this.io.to(userId).emit('message-sensitive', message);
    else this.io.emit('message-sensitive', message);
  },

  // 广播删除消息
  broadcastDelete(userId, messageId) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-delete', messageId);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-delete', messageId);
    } else {
      this.io.emit('message-delete', messageId);
    }
  },

  // 广播清空消息
  broadcastClear(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'messages-clear', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('messages-clear', data);
    } else {
      this.io.emit('messages-clear', data);
    }
  },

  // 广播收藏状态变更
  broadcastFavorite(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-favorite', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-favorite', data);
    } else {
      this.io.emit('message-favorite', data);
    }
  },

  // 广播备注变更
  broadcastRemark(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-remark', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-remark', data);
    } else {
      this.io.emit('message-remark', data);
    }
  },

  // 广播隐私状态变更
  broadcastPrivate(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-private', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-private', data);
    } else {
      this.io.emit('message-private', data);
    }
  },

  // 广播分类标题变更
  broadcastTitle(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'message-title', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('message-title', data);
    } else {
      this.io.emit('message-title', data);
    }
  },

  // 广播分组列表变更
  broadcastGroups(userId, data) {
    if (this.sessionBroadcast) return this.sessionBroadcast(userId, 'groups-update', data);
    if (MULTI_USER_MODE && userId) {
      this.io.to(userId).emit('groups-update', data);
    } else {
      this.io.emit('groups-update', data);
    }
  }
};

// 设置 Socket.io 处理
function setupSocket(io, { authService } = {}) {
  if (authService) return setupSessionSocket(io, authService);
  socketHelper.setIo(io);

  // 连接建立时的鉴权拦截器
  io.use((socket, next) => {
    const { password, userId } = socket.handshake.auth || {};

    if (MULTI_USER_MODE) {
      if (!password) {
        return next(new Error('Authentication error: password required'));
      }
      const matchedUserId = userPasswordMap.get(password);
      if (!matchedUserId) {
        return next(new Error('Authentication error: invalid password'));
      }
      if (userId && matchedUserId !== userId) {
        return next(new Error('Authentication error: userId mismatch'));
      }
      // 将认证通过的 userId 绑定至 socket 实例上
      socket.userId = matchedUserId;
      return next();
    }

    if (ACCESS_PASSWORD) {
      if (password !== ACCESS_PASSWORD) {
        return next(new Error('Authentication error: invalid password'));
      }
    }

    socket.userId = null;
    return next();
  });

  io.on('connection', (socket) => {
    console.log('用户连接:', socket.id, '绑定用户ID:', socket.userId);

    if (MULTI_USER_MODE) {
      socket.on('join', (userId) => {
        // 安全防御：只能加入经由认证绑定到该 Socket 实例的自身房间
        if (userId && userId === socket.userId) {
          socket.join(userId);
          console.log(`用户 ${socket.id} 成功加入自身房间: ${userId}`);

          const initialPage = getMessagesPage({
            before: Number.NaN,
            limit: SOCKET_SYNC_LIMIT,
            userId
          });

          socket.emit('sync', {
            ...initialPage,
            messages: initialPage.messages.map((msg) => toPublicMessage(msg, userId))
          });
        } else {
          console.warn(`用户 ${socket.id} 企图越权加入房间: ${userId}，已被拦截`);
          socket.emit('error', '越权访问被拒绝');
        }
      });
    } else {
      const initialPage = getMessagesPage({
        before: Number.NaN,
        limit: SOCKET_SYNC_LIMIT
      });

      socket.emit('sync', {
        ...initialPage,
        messages: initialPage.messages.map((msg) => toPublicMessage(msg))
      });
    }

    socket.on('disconnect', () => {
      console.log('用户断开连接:', socket.id);
    });
  });
}

// Accounts mode deliberately bypasses legacy global broadcasts and client-selected rooms.
function setupSessionSocket(io, authService) {
  const connections = new Map();
  let closed = false;
  function revoke(socket) {
    const entry = connections.get(socket);
    if (entry) clearTimeout(entry.timer);
    connections.delete(socket);
    socket.emit('session-revoked', { code: 'SESSION_INVALID' });
    socket.disconnect(true);
  }
  function validate(socket) {
    try {
      const entry = connections.get(socket);
      if (!entry) return null;
      const result = authService.authenticateRequest(entry.request);
      const ctx = result.context;
      if (ctx.userId !== socket.userId || ctx.sessionId !== socket.sessionId || ctx.securityVersion !== entry.securityVersion) throw new Error('Identity changed');
      return result;
    } catch {
      revoke(socket);
      return null;
    }
  }
  function schedule(socket, authenticated) {
    const entry = connections.get(socket);
    if (!entry || closed) return;
    clearTimeout(entry.timer);
    // Poll for database revocations even when no traffic is flowing. Never extend expiry.
    const expiry = Math.min(authenticated.session.expires_at, authenticated.session.idle_expires_at);
    const delay = Math.max(1, Math.min(1000, expiry - Date.now()));
    entry.timer = setTimeout(() => {
      const current = validate(socket);
      if (current) schedule(socket, current);
    }, delay);
    entry.timer.unref?.();
  }
  function revalidateSessions() {
    for (const socket of connections.keys()) validate(socket);
  }
  function broadcast(userId, event, payload) {
    if (closed) return;
    for (const socket of connections.keys()) {
      const authenticated = validate(socket);
      if (authenticated && socket.userId === userId) socket.emit(event, payload);
    }
  }
  socketHelper.setIo(io, broadcast);
  io.revalidateSessions = revalidateSessions;
  io.use((socket, next) => {
    try {
      if (closed) throw new Error('Socket service closed');
      const auth = socket.handshake.auth || {};
      if (Object.hasOwn(auth, 'password') || Object.hasOwn(auth, 'userId')) throw new Error('Legacy credentials rejected');
      const headers = { ...socket.handshake.headers };
      const request = { headers, socket: { remoteAddress: socket.request?.socket?.remoteAddress || socket.handshake.address } };
      // Same-origin browser polling GETs omit Origin. Accept only that transport
      // with browser same-origin metadata and an independently allowlisted Referer.
      // WebSocket and explicit Origin requests always use the exact-Origin policy.
      if (!headers.origin && socket.handshake.query?.transport === 'polling' &&
          headers['sec-fetch-site'] === 'same-origin' &&
          socket.request?.method === 'GET') {
        const referer = new URL(headers.referer);
        if (referer.username || referer.password) throw new Error('Invalid polling source');
        authService.requireOrigin({ headers: { origin: referer.origin } });
      } else {
        authService.requireOrigin(request);
      }
      const authenticated = authService.authenticateRequest(request);
      socket.userId = authenticated.context.userId;
      socket.sessionId = authenticated.context.sessionId;
      // Defer tracking/timers until connection succeeds (later middleware may reject).
      socket.sessionAuthentication = { request, securityVersion: authenticated.context.securityVersion, timer: null };
      next();
    } catch {
      next(new Error('Authentication error'));
    }
  });
  io.on('connection', socket => {
    connections.set(socket, socket.sessionAuthentication);
    delete socket.sessionAuthentication;
    socket.once('disconnect', () => {
      clearTimeout(connections.get(socket)?.timer);
      connections.delete(socket);
    });
    const authenticated = validate(socket);
    if (!authenticated) return;
    schedule(socket, authenticated);
    socket.join(socket.userId);
    socket.on('join', userId => {
      if (!validate(socket)) return;
      if (userId !== socket.userId) socket.emit('error', '越权访问被拒绝');
    });
    const page = getMessagesPage({ before: Number.NaN, limit: SOCKET_SYNC_LIMIT, userId: socket.userId });
    if (validate(socket)) socket.emit('sync', { ...page, messages: page.messages.map(msg => toPublicMessage(msg, socket.userId)) });
  });
  function close() {
    closed = true;
    for (const socket of connections.keys()) revoke(socket);
    io.httpServer?.removeListener('close', close);
  }
  io.httpServer?.once('close', close);
  return { revalidateSessions, close };
}

module.exports = {
  setupSocket,
  socketHelper
};