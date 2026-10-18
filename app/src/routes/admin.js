'use strict';
const express = require('express');
const { createAdminService } = require('../security/admin');
const { trackHandler } = require('../lifecycle');
const { requireAuth } = require('../middleware/auth');

function createAdminRouter(options) {
  const service = createAdminService(options);
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const endpoint = fn => trackHandler(async (req, res) => {
    try {
      if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ success: false, code: 'JSON_REQUIRED' });
      const result = await fn(req, res);
      if (result?.success && req.method === 'POST') {
        const notify = req.app.get('sessionInvalidated');
        if (typeof notify === 'function') notify();
      }
      res.json(result);
    } catch (error) {
      let status = Number.isInteger(error.status) ? error.status : 500;
      let code = status === 500 ? 'INTERNAL_ERROR' : error.code;
      if (error.code === 'LAST_ADMIN') { status = 409; code = 'LAST_ADMIN'; }
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') { status = 409; code = 'USER_CONFLICT'; }
      if (status === 429 || status === 503) res.set('Retry-After', '60');
      res.status(status).json({ success: false, code });
    }
  });
  router.use('/admin', requireAuth);
  router.get('/admin/users', endpoint(req => service.users(req)));
  router.post('/admin/reauth', endpoint((req) => service.reauth(req)));
  router.post('/admin/users', endpoint(req => service.create(req)));
  router.post('/admin/users/:id/disabled', endpoint(req => service.disable(req)));
  router.post('/admin/users/:id/role', endpoint(req => service.role(req)));
  router.post('/admin/users/:id/password', endpoint(req => service.resetPassword(req)));
  return router;
}
module.exports = { createAdminRouter };
