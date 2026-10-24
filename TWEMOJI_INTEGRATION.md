# Emoji 头像

头像预设直接使用浏览器原生 emoji 字符。生产页面不再加载 Twemoji CDN，也不依赖第三方图片资源；这样 `script-src 'self'` 和 `img-src 'self' data: blob:` 可以保持收紧，同时避免 CDN、扩展或代理引入混合内容。

如果将来需要统一的 emoji 外观，应把脚本和实际 SVG 资源作为同源静态文件随应用发布，并在变更后同步更新 Service Worker 缓存版本。不要重新引入未经 CSP 允许的外部脚本或图片地址。
