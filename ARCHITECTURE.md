# Architecture

## 设计原则

1. **共享优先** — 可复用的逻辑和组件提取到 `packages/`，app 层只写业务特有代码
2. **CSS 驱动设计** — 设计系统是纯 CSS（editorial-preset），不绑定任何框架
3. **渐进式** — 每个 app 独立部署，互不依赖运行时

## 依赖关系

```
apps/reader  ──→ @jojo/ui + @jojo/pdf-viewer + @jojo/editorial-preset
apps/rag     ──→ @jojo/ui + @jojo/editorial-preset
apps/press   ──→ @jojo/ui + @jojo/pdf-viewer + @jojo/editorial-preset
apps/jiuwen-web ─→ @jojo/ui + @jojo/editorial-preset
apps/jiuwen-mobile ─→ Expo / React Native
```

## 仓库分层

```
apps/        面向用户的前端、桌面端、移动端应用，参与 pnpm workspace
packages/    共享 UI、设计系统、PDF viewer、工具配置，参与 pnpm workspace
services/    后端、搜索、批处理工具，不参与 pnpm workspace
references/  外部参考工程、旧实现和迁移线索归档，不参与构建
tooling/     共享 TypeScript / ESLint 配置
```

`services/` 保留迁移前各项目的后端与工具源码，并保持各自原技术栈：

- `rag-backend`：Flask / SCF
- `press-engine`：FastAPI
- `jiuwen-api`：FastAPI
- `jiuwen-news-reader`：旧 React 前端原型；旧 Express 后端已归档到 `references/legacy-node-backends`
- `reader-search`：Flask + Elasticsearch
- `internal/data-workbench`：内部数据工作台（React Web + Flask / Python 批处理）
- `notebooklm-py`：Python package

这些服务不加入 Turborepo，是为了避免 Python、Expo 等依赖影响当前前端工作区的安装、构建和测试。旧 Node/Nest/Express 后端实现归档到 `references/legacy-node-backends`，只作为迁移对照。

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
- `dev` 任务不缓存，持久运行

## 部署

| App | 部署方式 |
|-----|---------|
| reader | 静态站点 (Vercel / COS) |
| rag | 静态站点 + SCF 后端 |
| press | Electron 打包分发 |
| jiuwen-web | Vercel (Next.js) |
