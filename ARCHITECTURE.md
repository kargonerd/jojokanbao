# Architecture

## 设计原则

1. **共享优先** — 可复用的逻辑和组件提取到 `packages/`，app 层只写业务特有代码
2. **CSS 驱动设计** — 设计系统是纯 CSS（editorial-preset），不绑定任何框架
3. **产品边界优先** — Archive、Account、RAG 和 Olds 属于同一个 Web 客户端，不再按功能拆成独立 SPA；未完成模块通过构建期开关分阶段发布
4. **桌面运行时统一** — Desktop 当前运行 Press，并为 Archive、Account、RAG 和 Olds 保留平级模块；它们共用 Electron shell、会话和发布流程

## 依赖关系

```
apps/homepage ──→ Astro 静态博客
apps/web     ──→ @jojo/auth + @jojo/ui + @jojo/pdf-viewer + @jojo/editorial-preset
apps/desktop ──→ @jojo/ui + @jojo/pdf-viewer + @jojo/editorial-preset
apps/jiuwen-mobile ─→ Expo / React Native
```

## 仓库分层

```
apps/        面向用户的前端、桌面端、移动端应用，参与 pnpm workspace
packages/    共享 UI、设计系统、PDF viewer、工具配置，参与 pnpm workspace
internal/    内部应用与运维工作台；Web 参与 pnpm workspace，Python server 独立
services/    独立 Python 后端、搜索和归档任务，不参与 pnpm workspace
references/  外部参考工程、旧实现和迁移线索归档，不参与构建
tooling/     仓库级共享配置、构建和运维工具
```

`services/` 保留迁移前各项目的后端与工具源码，并保持各自原技术栈：

- `rag-backend`：Flask / SCF
- `press-engine`：FastAPI
- `jiuwen-api`：现有旧闻 FastAPI；服务端重命名单独处理
- `olds-api`：Olds 历史归档任务
- `reader-search`：Flask + Elasticsearch
- `notebooklm-py`：Python package

`internal/data-workbench` 是内部数据工作台：`web/` 是 pnpm workspace，
`server/` 保持独立 Python 依赖。Python 服务不加入 Turborepo，避免服务端依赖影响
前端工作区的安装、构建和测试。旧 Node/Nest/Express 后端实现归档到
`references/legacy-node-backends`，只作为迁移对照。

## 包职责

### @jojo/editorial-preset
- Tailwind v4 `@theme` 定义设计 token（颜色、字体、间距）
- `@layer base` 全局重置（零圆角、selection、scrollbar、focus ring）
- `@layer components` 工具类（`.btn`、`.tag`、`.kicker`）
- Vue Datepicker 主题覆盖（仅 reader 使用）

### @jojo/ui
- 纯展示型 React 组件，通过 Tailwind class 实现样式
- 不含业务逻辑，不含 API 调用
- 通过 `className` prop 支持扩展

### @jojo/pdf-viewer
- 封装 pdfjs-dist 的 React 组件
- `usePdfDocument` — 加载 PDF 文档
- `PdfPage` — 渲染单页到 canvas
- `PdfViewer` — 带懒加载的多页查看器

## 构建流程

Turborepo 管理任务依赖：
- `build` 任务有 `dependsOn: ["^build"]`，确保 packages 先于 apps 构建
- `test` 任务依赖 `^build`
- `typecheck` 任务按 workspace 依赖关系执行
- `verify:build` 在对应 app 构建完成后校验产物
- `dev` 任务不缓存，持久运行

Pull request 统一进入 `.github/workflows/ci.yml`。pnpm workspace 使用 Turborepo
计算受影响范围；`blog/`、`supabase/` 和 Python 服务等 workspace 外内容由独立 job
显式分类。部署、发版和定时运维不混入 CI。

## 部署

| App | 部署方式 |
|-----|---------|
| homepage | `jojokanbao.cn` 的 Astro 静态博客，保持独立部署 |
| web | 部署到 `reader.jojokanbao.cn` 的统一 Web 客户端；当前仅开放 Archive，RAG / Olds 待 rollout |
| desktop | 统一 Electron 客户端；当前包含 Press，后续能力共用同一运行时和发布流程 |
