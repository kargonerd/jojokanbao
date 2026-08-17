# JOJO 看报

JOJO 看报的完整产品代码，包括 Web、官网、桌面端、移动端、Python 后端、后台任务和内部工具。

## 目录

```text
frontend/
  web/                 统一 Web 客户端
  homepage/            官网和博客
  desktop/             Electron 客户端与专属 engine
  mobile/              移动端
  packages/            前端共享 ui、auth、pdf-viewer
backend/
  src/app/             统一 FastAPI 与未上线业务模块
  tests/               Python 后端测试
  docs/                后端模块说明
agent/
  runtime/             通用 Pi Agent、Codex OAuth 与凭证
  edgeone/             Makers Agent 的认证、SSE 和持久化适配
tools/                 JOJO 管理台、Archive PDF 工具和管理员命令
infrastructure/        EdgeOne、Supabase 与线上腾讯 SCF Search
content/blog/          博客内容
```

详细边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 开发

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm typecheck
```

单独启动：

```bash
pnpm --filter @jojo/web dev
pnpm --filter @jojo/homepage dev
pnpm dev:desktop
pnpm dev:backend
pnpm dev:reader-search
pnpm dev:admin
pnpm --filter @jojo/agent auth:codex
pnpm --filter @jojo/agent smoke -- "你好"
pnpm push:credentials
```

Python API 测试：

```bash
python -m pip install -r backend/requirements-dev.txt
pnpm test:backend
```

## 环境配置

本地私密配置放在仓库根目录 `.env`，可提交的键名示例位于 `.env.example`。不要提交真实 token。
Desktop 的 MinerU API Key 例外：由每位用户在桌面“设置”中填写，并通过系统安全存储
保存在本机，不写入仓库 `.env`。

统一 API 使用：

- `JOJO_ENV`
- `JOJO_ALLOWED_ORIGINS`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Supabase migrations 位于 `infrastructure/supabase/migrations`。邀请注册的数据库约束、
部署顺序和管理员邀请码命令见
[`infrastructure/supabase/README.md`](./infrastructure/supabase/README.md)。

## 部署

- Homepage workflow 构建 `frontend/homepage`。
- Web workflow 构建 `frontend/web`。
- `pnpm prepare:web-deploy` 将 Web、`backend` 和 EdgeOne 薄入口组装到
  `.edgeone/web-deploy`。
- `pnpm prepare:agent-deploy` 生成 Codex Agent 的独立国际部署包。
- `infrastructure/edgeone/functions` 只包含平台适配代码。
- Codex Agent 的部署与环境变量见
  [`infrastructure/edgeone/AGENT_DEPLOYMENT.md`](./infrastructure/edgeone/AGENT_DEPLOYMENT.md)。
- `infrastructure/tencent-scf/search` 是 Reader 当前线上搜索运行时，独立部署。

线上部署由 GitHub Actions 完成；本地构建不会自动发布。

## 贡献

欢迎通过 Issue 和 Pull Request 参与开发。开始前请阅读
[CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请按照
[SECURITY.md](./SECURITY.md) 私下报告，不要发布到公开 Issue。

## 许可证

JOJO 看报的原创源代码按照
[GNU Affero General Public License v3.0 only](./LICENSE)（SPDX:
`AGPL-3.0-only`）发布。通过网络向用户提供修改后的版本时，需要按许可证要求向
这些用户提供对应源代码。

依赖项、品牌和报刊素材可能适用其他权利和许可证，详见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
