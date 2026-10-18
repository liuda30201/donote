'use strict';
const express = require('express');
const { createOperationsService, ACTIONS } = require('../security/operations');
const { trackHandler } = require('../lifecycle');
const { requireAuth } = require('../middleware/auth');

function createSecurityRouter({ authService, repo, encryptionKey, keyId, maxPasswordConcurrency = 1, now = Date.now, operations }) {
  const service = operations || createOperationsService({ authService, repo, encryptionKey, keyId, maxPasswordConcurrency, now });
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use('/auth', requireAuth);
  const endpoint = fn => trackHandler(async (req, res) => {
    try {
      const result = await fn(req, res);
      // Send self-invalidating responses before notifying sockets. Otherwise the
      // client epoch advances on `session-revoked` and drops recovery codes.
      res.json(result);
      if (result?.requiresLogin) {
        const callback = req.app.get('sessionInvalidated');
        if (typeof callback === 'function') callback();
      }
    }
    catch (error) { const status = Number.isInteger(error.status) ? error.status : 500; res.status(status).json({ success: false, code: status === 500 ? 'INTERNAL_ERROR' : error.code }); }
  });
  router.get('/auth/sessions', endpoint(req => service.sessions(req)));
  router.post('/auth/reauth', endpoint(req => service.reauth(req)));
  router.post('/auth/password', endpoint(req => service.changePassword(req)));
  router.post('/auth/totp/start', endpoint(async req => {
    const result = service.startFactor(req);
    const current = authService.authenticateRequest(req);
    const uri = `otpauth://totp/${encodeURIComponent(`DoNote:${current.user.username}`)}?secret=${encodeURIComponent(result.secret)}&issuer=DoNote&algorithm=SHA1&digits=6&period=30`;
    return { ...result, qrCode: await require('qrcode').toDataURL(uri, { width: 240, margin: 2 }) };
  }));
  router.post('/auth/totp/confirm', endpoint(req => service.confirmFactor(req)));
  router.post('/auth/totp/disable', endpoint(req => service.disableFactor(req)));
  router.get('/auth/history', endpoint(req => service.history(req, false)));
  router.get('/auth/history/details', endpoint(req => {
    const current = authService.authenticateRequest(req); authService.requireCsrf(req, current);
    const grant = req.headers['x-operation-grant'];
    if (!grant) { const error = new Error('grant required'); error.status = 401; error.code = 'GRANT_REQUIRED'; throw error; }
    const result = service.consume(current, grant, 'history.read-details', () => service.history(req, true));
    return result;
  }));
  router.post('/auth/sessions/:id/revoke', endpoint(req => {
    const current = authService.authenticateRequest(req); authService.requireCsrf(req, current);
    const grant = req.headers['x-operation-grant']; const result = service.consume(current, grant, 'session.revoke', target => { const session = repo.findSessionById(req.params.id); if (target.targetId !== req.params.id || !session || session.user_id !== current.user.id) { const error = new Error('not found'); error.status = 404; error.code = 'SESSION_NOT_FOUND'; throw error; } return repo.revokeSession({ sessionId: req.params.id, userId: current.user.id, at: now() }); });
    const callback = req.app.get('sessionInvalidated'); if (typeof callback === 'function') callback(); return { success: result };
  }));
  router.post('/auth/sessions/revoke-others', endpoint(req => {
    const current = authService.authenticateRequest(req); authService.requireCsrf(req, current);
    const grant = req.headers['x-operation-grant']; const result = service.consume(current, grant, 'session.revoke-others', target => { for (const id of target.targetIds) repo.revokeSession({ sessionId: id, userId: current.user.id, at: now() }); return target.targetIds.length; });
    const callback = req.app.get('sessionInvalidated'); if (typeof callback === 'function') callback(); return { success: true, count: result };
  }));
  router.post('/auth/sessions/revoke-all', endpoint(req => {
    const current = authService.authenticateRequest(req); authService.requireCsrf(req, current);
    const grant = req.headers['x-operation-grant']; const result = service.consume(current, grant, 'session.revoke-all', target => { for (const id of target.targetIds) repo.revokeSession({ sessionId: id, userId: current.user.id, at: now() }); return target.targetIds.length; });
    const callback = req.app.get('sessionInvalidated'); if (typeof callback === 'function') callback(); return { success: true, count: result };
  }));
  return router;
}
module.exports = { createSecurityRouter, ACTIONS };
