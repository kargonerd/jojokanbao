# JOJO Platform

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
tools/                 数据工作台、Archive PDF 工具和管理员命令
infrastructure/        EdgeOne、Supabase 与线上腾讯 SCF Search
content/blog/          博客内容
vendor/                第三方源码
references/            历史参考代码
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
pnpm dev:data-workbench
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
- `infrastructure/edgeone/functions` 只包含平台适配代码。
- `infrastructure/tencent-scf/search` 是 Reader 当前线上搜索运行时，独立部署。

线上部署由 GitHub Actions 完成；本地构建不会自动发布。
