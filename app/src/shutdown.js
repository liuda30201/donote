'use strict';

function createShutdown({ closeApp, stopCleanup, flushPersist, closeSecurity, timeoutMs = 25000, onTimeout = () => {} }) {
  let result;
  return function shutdown() {
    if (result) return result;
    result = (async () => {
      let timer;
      // Failure is explicit: never close SQLite while handlers still use it.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Graceful shutdown timed out');
          error.code = 'SHUTDOWN_TIMEOUT';
          reject(error);
          onTimeout(error);
        }, timeoutMs);
      });
      let cancelled = false;
      const work = (async () => {
        await Promise.all([closeApp(), stopCleanup()]);
        if (cancelled) {
          console.error('关闭超时：跳过持久化刷新和安全数据库关闭');
          return;
        }
        await flushPersist();
        if (!cancelled) await closeSecurity();
      })();
      try { await Promise.race([work, deadline]); }
      catch (error) { cancelled = true; throw error; }
      finally { clearTimeout(timer); }
    })();
    return result;
  };
}
module.exports = { createShutdown };
