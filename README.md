# Web Clipboard · 私有跨设备剪贴板

用于在设备之间传递文本、截图、图片和文件。基于 [aiChenK/web-clipboard](https://github.com/aiChenK/web-clipboard) v1.6.8，包含本地认证、文件访问、历史搜索和卡片布局补丁。

默认部署入口为 **https://node.7705.work**。浏览器通过 Nginx 的 HTTPS 入口访问应用；应用的 3000 端口只在 Docker 网络内使用，数据持久化在 `data/`。

## 文档入口

| 要做的事 | 文档 |
| --- | --- |
| 部署、启停、密码、备份恢复、证书和排障 | [部署与运维](docs/operations.md) |
| 修改代码、理解模块、检查和测试 | [开发说明](docs/development.md) |
| 用户管理、群组分类、定向共享与 2FA 安全规划 | [演进规划方案](docs/feature-planning.md) |
| 了解本地补丁与上游资料的关系 | [上游来源](docs/upstream/README.local.md) |
| 查看历史镜像记录 | [镜像记录](docs/deployment-images.txt) |

## 项目结构

```text
web-clipboard/
├── app/                    # 应用源码，也是 Docker 构建上下文
│   ├── src/                # 后端：配置、存储、路由、中间件、实时通信
│   ├── public/             # 前端：原生 HTML/CSS/JS，无打包步骤
│   ├── test/               # 使用临时数据的接口回归测试
│   ├── server.js           # 服务启动入口
│   ├── package.json
│   ├── package-lock.json
│   └── Dockerfile
├── docs/                   # 开发、运维和上游参考资料
├── nginx/                  # 反向代理配置、证书、ACME 挑战目录
├── scripts/                # 检查、备份、恢复与证书脚本
│   └── lib/common.sh       # 共享路径、日志、镜像解析
├── .github/workflows/      # 检查与测试，不发布镜像
├── docker-compose.yml      # app + nginx 编排
├── .env.example            # 环境变量模板
├── LICENSE                 # 保留上游 MIT 许可
├── .env                    # 本地密码，忽略提交
├── data/                   # 消息与附件，忽略提交
└── backup/                 # 备份，忽略提交
```

## 首次部署

需要 Docker 和 Docker Compose。配置中的域名为 `node.7705.work`；换域名时按[运维文档](docs/operations.md#域名与入口)调整。

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，将 ACCESS_PASSWORD 改成自己的密码
./scripts/self-signed-cert.sh
# 首次启动先生成证书，再构建和启动服务
docker compose up -d --build
docker compose ps
```

已有部署无需重新生成证书或迁移数据。目录整理后仍使用原来的 `.env`、`data/` 和 `nginx/` 挂载路径；下次构建自动使用 `app/`。

## 功能与边界

- **极简全屏剪贴工作台**：100% 视口流式布局，首屏 Anti-FOUC 防闪屏秒开，支持深浅色模式切换。
- **纯粹剪切板体验**：移除多余上传与繁重附件，聚焦文本、代码片段与剪贴板截图；全局 `Ctrl + V` 原生识别粘贴。
- **紧凑无空洞瀑布流（Masonry）**：卡片高度完全由内容驱动，彻底消除旧网格大面积留白；支持按“今天/昨天/7天内/月份”时间轴分组。
- **顶栏内嵌极简搜索**：单行嵌入导航栏，快捷键 `/` 或 `Ctrl+K` 快速聚焦，不占用下方任何垂直展示空间。
- **卡片大小无级缩放滑块**：顶栏直观微型滑块（200px~650px），自由调整瀑布流列宽与显示密度，本地自动持久记忆。
- **SWR 离线秒开缓存**：本地快照 0ms 瞬间渲染，后台静默校准与 WebSocket 实时推送。
- **私有隔离与安全守卫**：全私有数据需要鉴权；支持即将落地的管理员专控用户体系、定向共享收件箱与 TOTP 2FA 防异地泄密。

上游文档中的公开分享、免密码部署等说明不代表本地 Compose 的实际行为。
