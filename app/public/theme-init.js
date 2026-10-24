// Apply the saved theme before the app renders. Keeping this in a same-origin
// file lets the production CSP remain `script-src 'self'` without an inline
// script exception.
(function applySavedTheme() {
  try {
    var savedTheme = localStorage.getItem('web-clipboard-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
    // 身份仅由服务器确认；不凭本地密码预先展示工作台。
  } catch (e) {}
})();
