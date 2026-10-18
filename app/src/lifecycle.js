'use strict';

// Track handler work separately from response lifetime: an aborted client does
// not cancel password hashing, filesystem work, or their continuations.
function createLifecycle() {
  let stopping = false;
  const active = new Set();
  function track(work) {
    const promise = Promise.resolve().then(work);
    active.add(promise);
    promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  }
  return {
    track,
    get stopping() { return stopping; },
    stop() { stopping = true; },
    async drain() {
      while (active.size) await Promise.allSettled([...active]);
    },
    middleware(req, res, next) {
      if (stopping) {
        res.set('Connection', 'close');
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ success: false, code: 'SERVER_STOPPING' });
      }
      next();
    }
  };
}

function trackHandler(handler) {
  if (handler.length === 4) return function trackedErrorHandler(error, req, res, next) {
    const lifecycle = req.app.get('lifecycle');
    return lifecycle ? lifecycle.track(() => handler(error, req, res, next)) : handler(error, req, res, next);
  };
  return function trackedHandler(req, res, next) {
    const lifecycle = req.app.get('lifecycle');
    return lifecycle ? lifecycle.track(() => handler(req, res, next)) : handler(req, res, next);
  };
}

// Register each middleware's promise, without inspecting Express internals.
function trackRouter(router) {
  for (const method of ['get', 'post', 'patch', 'put', 'delete', 'use', 'all', 'options', 'head']) {
    const register = router[method];
    router[method] = function registerTracked(route, ...handlers) {
      if (method === 'use' && (typeof route === 'function' || Array.isArray(route) && typeof route.flat(Infinity)[0] === 'function')) {
        return register.call(this, ...[route, ...handlers].flat(Infinity).map(trackHandler));
      }
      return register.call(this, route, ...handlers.flat(Infinity).map(trackHandler));
    };
  }
  return router;
}

module.exports = { createLifecycle, trackHandler, trackRouter };
