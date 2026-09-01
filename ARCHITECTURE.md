# Architecture

JOJO 看报按运行职责组织，不按历史项目或部署平台组织。

```text
frontend/       Web、Homepage、Desktop、Mobile 以及前端共享包
agent/          产品无关的 Node Agent 运行层与模型适配
backend/        统一 Python 后端
tools/          JOJO 管理台与人工运维工具
infrastructure/ EdgeOne、Supabase 等部署和基础设施配置
content/        博客等内容源
```

## Frontend

- `frontend/web`：Archive、Account、RAG、JOJO Times 共用的浏览器运行时；`shell`、`home`、`library` 分别承载应用外壳、首页和资料库。
- `frontend/homepage`：官网与博客静态站点。
- `frontend/desktop`：Electron 桌面产品；`engine/` 是 Desktop 专属的 TypeScript 本地引擎。
- `frontend/mobile`：移动端客户端。
- `frontend/packages/ui`：React 组件以及通过 `@jojo/ui/styles` 导出的 CSS 设计系统。
- `frontend/packages/auth`、`pdf-viewer`：前端共享能力。

Homepage 已启用 Astro React integration，可以直接复用 `@jojo/ui` 组件。

## Backend

- `backend/src/app/main.py`：统一公网 FastAPI 入口。
- `backend/src/app/core`：认证、配置、错误和 HTTP 中间件。
- `backend/src/app/account`：已启用的账号 API。
- RAG 由独立 Agent 运行层承载，不在 Python 后端维护第二套实现；浏览器统一请求
  Reader 的 `/gateway/ask`，由同源 Cloud Function 转发到国际 Agent。
- Times 由 `tools/times-pipeline` 每十分钟离线采集，保存原始 HTML、渲染 DOM、抓取元数据和原始图片；
  发现直接使用出版方官方 RSS、API、sitemap 或栏目页，正文由 Chromium+BPC 原页归档和来源/通用解析器回填，
  再生成媒体 Canonical 与 Delivery Jox。Raw/Canonical 写入同一个 HF Dataset，GitHub Actions
  按对象依赖顺序只把 Delivery 发布到 B2。Web 与 Mobile 直接读取 B2 CDN，不在读者请求路径中
  抓取出版方或调用 Python API。

本地运行主 API：

```bash
pnpm dev:backend
```

EdgeOne 专有入口位于 `infrastructure/edgeone/functions`，只导入
`backend/src/app/main.py` 创建的应用，不承载业务逻辑。部署脚本将 Web 静态文件、
主 API 和平台入口组装到忽略的 `.edgeone/web-deploy`。

## Agent

- `agent`：单一 `@jojo/agent` 包，包含 Pi Agent 运行层、Codex 模型与凭证配置。
- `agent/src/edgeone`：同一包内的 EdgeOne 登录、SSE 和加密 Store
  适配。
- `agent/src/applications.ts`：RAG、JOJO Times 的最小业务占位函数；功能增长后再拆分。
- Codex Agent 使用不含中国大陆的独立 Makers 项目和域名；其他模型后续通过
  Makers Models 接入。
- 浏览器请求 Reader 同源 `/gateway/ask`，由 Reader 流式转发到国际 Agent 的内部
  `/rag` 入口；Mobile 直接请求国际 `/rag`。
  国际项目的 Edge Middleware 在进入 Agent 前校验 Supabase Bearer Token，随后由
  Agent 再做最终用户鉴权，不再使用 Node Cloud Function 嵌套转发或 HMAC 服务签名。
- 会话采用客户端管理的通用结构（`conversation + messages + references`）。Web 将完整历史
  按账号保存在 IndexedDB，不自动过期；每次只把最近 20 条上下文随请求发送给 Agent，
  服务端不保存聊天历史。Desktop 与 Mobile 可用同一结构接入各自的本地 SQLite，未来云
  同步作为独立可选层添加，不改变问答协议。
- Codex OAuth 只在 Store 中保留一条加密系统消息；凭据刷新覆盖同一 message，不随请求、
  用户或会话追加记录。
- Agent 先读取 `catalog.jox` 选择最多 8 本候选书，再把候选书随 Jox 发布的
  `jojo-book-search/1` 静态索引下载到本次运行内存中检索；只下载命中的少量章节正文，
  不依赖 Elasticsearch。书籍未提供静态索引时改为先看真实目录、再按章读取。通用聊天和
  书内面板共享同一套可跳转引用结构。
- Pi Agent 使用 Makers Agents Runtime，不塞进 Node Cloud Functions。

## Tools and infrastructure

- `tools/jojo-admin`：本机 JOJO 管理台。
- `tools/archive-pdf`：Archive PDF 人工操作与发布工具。
- `tools/times-pipeline`：Times 新闻源采集、Raw/Canonical 构建及 B2 Delivery 发布工具。
- `infrastructure/supabase`：数据库 migrations。
- `infrastructure/edgeone`：EdgeOne 配置、入口和部署组装脚本。
- `infrastructure/tencent-scf/search`：Reader 当前线上 Flask Search，独立运行。

书籍、报纸和杂志的统一规范数据、B2/CDN 交付对象以及 Jox 边界见
[`docs/data-format-v1.md`](./docs/data-format-v1.md)。

依赖只在真实复用后抽取。前端共享代码放在 `frontend/packages`；Python 代码当前不建立
推测性的共享包。
