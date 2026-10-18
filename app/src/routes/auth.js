const express = require('express');
const { MULTI_USER_MODE, ACCESS_PASSWORD, APP_VERSION, userPasswordMap } = require('../config');
const { authLimiter } = require('../middleware/rateLimit');
const { trackHandler } = require('../lifecycle');

const router = express.Router();

// 认证中间件：提取 userId
function extractUserId(req, res, next) {
  const body = req.body || {};
  const query = req.query || {};
  const headers = req.headers || {};
  const userId = body.userId || query.userId || headers['x-user-id'];
  req.userId = userId || null;
  next();
}

// 认证 API
router.post('/auth', authLimiter, (req, res) => {
  const { password } = req.body;

  if (MULTI_USER_MODE) {
    const userId = userPasswordMap.get(password);
    if (userId) {
      return res.json({ success: true, userId, mode: 'multi' });
    }
    return res.status(401).json({ success: false, error: '密码错误' });
  }

  if (!ACCESS_PASSWORD) {
    return res.json({ success: true, noPassword: true, mode: 'single' });
  }

  if (password === ACCESS_PASSWORD) {
    res.json({ success: true, mode: 'single' });
  } else {
    res.status(401).json({ success: false, error: '密码错误' });
  }
});

// 认证状态 API
router.get('/auth/status', (req, res) => {
  if (MULTI_USER_MODE) {
    // 该接口在 nginx 侧免登录放行，因此绝不能返回用户 ID 列表（用户枚举）。
    // 只暴露“是否需要密码”这一必要信息。
    res.json({
      mode: 'multi',
      requirePassword: true
    });
  } else {
    res.json({
      mode: 'single',
      requirePassword: Boolean(ACCESS_PASSWORD)
    });
  }
});

// 版本信息 API
router.get('/version', (req, res) => {
  res.json({ version: APP_VERSION, mode: MULTI_USER_MODE ? 'multi' : 'single' });
});

// New session-only router: mount at /api instead of the legacy router above.
function createAuthRouter({ authService, version = APP_VERSION }) {
  if (!authService) throw new TypeError('authService is required');
  const sessionRouter = express.Router();
  sessionRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  function endpoint(fn) {
    return trackHandler(async (req, res) => {
      try { await fn(req, res); }
      catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status === 429 || status === 503) res.set('Retry-After', '60');
        res.status(status).json({ success: false, code: status === 500 ? 'INTERNAL_ERROR' : error.code, error: status === 500 ? 'Request failed' : error.message });
      }
    });
  }
  function setCookie(res, name, value, options) { res.cookie(name, value, options); }
  function issue(result, res) {
    if (result.requiresSecondFactor || result.requiresSetup) return res.json(result);
    setCookie(res, authService.cookieName, result.token, authService.cookieOptions(result.ephemeral, result.session.expires_at));
    res.json({ success: true, user: result.user, sessionId: result.session.id, expiresAt: result.session.expires_at, requiresFactorSetup: result.requiresFactorSetup, optionalFactorSetup: result.optionalFactorSetup });
  }
  function jsonRequest(req) {
    if (!req.is('application/json')) { const e = new Error('JSON request required'); e.status = 415; e.code = 'JSON_REQUIRED'; throw e; }
  }
  sessionRouter.get('/auth/status', (req, res) => res.json({ mode: 'accounts', requirePassword: true, secondFactorSupported: true, registration: Boolean(authService.emailVerification?.registrationAvailable?.()) }));
  sessionRouter.post('/auth/register/start', endpoint(async (req, res) => { jsonRequest(req); res.json(await authService.emailVerification.startRegistration(req)); }));
  sessionRouter.post('/auth/register/confirm', endpoint((req, res) => { jsonRequest(req); res.json(authService.emailVerification.completeRegistration(req)); }));
  sessionRouter.get('/version', (req, res) => res.json({ version, mode: 'accounts' }));
  sessionRouter.post('/auth', (req, res) => res.status(410).json({ code: 'LEGACY_AUTH_DISABLED' }));
  sessionRouter.post('/auth/login', endpoint(async (req, res) => { jsonRequest(req); issue(await authService.login(req), res); }));
  sessionRouter.post('/auth/login/verify', endpoint(async (req, res) => { jsonRequest(req); issue(await authService.completeLogin(req), res); }));
  function notify(req) { const callback = req.app.get('sessionInvalidated'); if (typeof callback === 'function') callback(); }
  sessionRouter.post('/auth/setup/start', endpoint((req, res) => { jsonRequest(req); res.json(authService.startSetup(req)); }));
  sessionRouter.post('/auth/setup/complete', endpoint(async (req, res) => { jsonRequest(req); const result = await authService.completeSetup(req); notify(req); res.json(result); }));
  sessionRouter.post('/auth/recovery/start', endpoint(async (req, res) => { jsonRequest(req); const result = await authService.startRecovery(req); notify(req); res.json(result); }));
  sessionRouter.post('/auth/enrollment/start', endpoint(async (req, res) => { jsonRequest(req); res.json(await authService.startPostLoginSetup(req)); }));
  sessionRouter.post('/auth/enrollment/confirm', endpoint((req, res) => { jsonRequest(req); res.json(authService.completePostLoginSetup(req)); }));
  sessionRouter.post('/auth/enrollment/skip', endpoint((req, res) => { jsonRequest(req); res.json(authService.skipPostLoginSetup(req)); }));
  sessionRouter.get('/auth/verification', endpoint((req,res)=>res.json(authService.emailVerification.settings(req))));
  sessionRouter.post('/auth/email/reauth', endpoint(async(req,res)=>{jsonRequest(req);res.json(await authService.emailVerification.sendReauth(req));}));
  sessionRouter.post('/auth/email/start', endpoint(async(req,res)=>{jsonRequest(req);res.json(await authService.emailVerification.startBind(req));}));
  sessionRouter.post('/auth/email/confirm', endpoint((req,res)=>{jsonRequest(req);const result=authService.emailVerification.confirmBind(req);notify(req);res.json(result);}));
  sessionRouter.post('/auth/verification', endpoint(async(req,res)=>{jsonRequest(req);const result=await authService.emailVerification.change(req);notify(req);res.json(result);}));
  sessionRouter.get('/auth/me', endpoint((req, res) => res.json(authService.me(req))));
  sessionRouter.post('/auth/logout', endpoint((req, res) => {
    jsonRequest(req); authService.logout(req); notify(req);
    setCookie(res, authService.cookieName, '', { ...authService.cookieOptions(true, 0), maxAge: 0 });
    setCookie(res, 'wc_auth', '', { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: 0 });
    res.json({ success: true });
  }));
  return sessionRouter;
}

module.exports = {
  router,
  extractUserId,
  createAuthRouter
};