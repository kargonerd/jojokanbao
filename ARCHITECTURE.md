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
- `backend/src/app/times`：未上线的 JOJO Times（时事）模块，默认不进入公开路由或部署产物。
- RAG 由独立 Agent 运行层承载，不在 Python 后端维护第二套实现。

本地运行主 API：

```bash
pnpm dev:backend
```

EdgeOne 专有入口位于 `infrastructure/edgeone/functions`，只导入
`backend/src/app/main.py` 创建的应用，不承载业务逻辑。部署脚本将 Web 静态文件、
主 API 和平台入口组装到忽略的 `.edgeone/web-deploy`。

## Agent

- `agent`：单一 `@jojo/agent` 包，包含 Pi Agent 运行层、Codex 模型与凭证配置。
- `agent/src/edgeone`：同一包内的 EdgeOne 登录、SSE、服务鉴权和加密 Store
  适配。
- `agent/src/applications.ts`：RAG、JOJO Times 的最小业务占位函数；功能增长后再拆分。
- Codex Agent 使用不含中国大陆的独立 Makers 项目和域名；其他模型后续通过
  Makers Models 接入。
- Agent 项目用一个不运行 Pi 的 Node Cloud Function 处理浏览器 CORS 预检，再把
  SSE 请求转给同项目的 Makers Agent。
- Pi Agent 使用 Makers Agents Runtime，不塞进 Node Cloud Functions。

## Tools and infrastructure

- `tools/jojo-admin`：本机 JOJO 管理台。
- `tools/archive-pdf`：Archive PDF 人工操作与发布工具。
- `tools/bloomberg-archive`：定时 Bloomberg 数据归档工具。
- `infrastructure/supabase`：数据库 migrations。
- `infrastructure/edgeone`：EdgeOne 配置、入口和部署组装脚本。
- `infrastructure/tencent-scf/search`：Reader 当前线上 Flask Search，独立运行。

书籍、报纸和杂志的统一规范数据、B2/CDN 交付对象以及 Jox 边界见
[`docs/data-format-v1.md`](./docs/data-format-v1.md)。

依赖只在真实复用后抽取。前端共享代码放在 `frontend/packages`；Python 代码当前不建立
推测性的共享包。
