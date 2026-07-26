# AGENTS.md

## 项目概述

JOJO Platform 是一个 pnpm monorepo，包含 4 个前端应用和 3 个共享包，统一使用红色杂志风格设计系统。

## 关键命令

```bash
pnpm install          # 安装所有依赖
pnpm build            # 构建所有 app（通过 Turborepo）
pnpm test             # 运行所有测试
pnpm dev              # 并行启动所有 dev server
pnpm --filter @jojo/reader dev   # 单独启动 reader
pnpm dev:jojo-pipe               # 启动内部数据工作台前后端
```

## 代码规范

- 全局 TypeScript strict 模式
- React 19 + 函数组件 + hooks
- 样式用 Tailwind CSS v4 utility classes，颜色/字体引用 editorial-preset 的 token
- 状态管理用 Zustand（不用 Redux/Context）
- 测试用 Vitest + @testing-library/react

## 共享包使用

```tsx
// UI 组件
import { Button, Card, NavBar, Tag, Pagination, Modal, LoadingSpinner } from "@jojo/ui";

// PDF 渲染
import { PdfViewer, PdfPage, usePdfDocument } from "@jojo/pdf-viewer";

// 设计系统（在 CSS 中）
@import "@jojo/editorial-preset";
```

## 设计系统 Token

- 主色：`--color-red: #8b1a1a`（暗红）
- 文字：`--color-ink: #202020`
- 背景：`--color-paper: #fff`
- 字体：Noto Serif SC 衬线体
- 圆角：全局 0（零圆角）
- hover 效果：`translateY(-2px) + box-shadow: 4px 4px 0 rgba(139,26,26,.14)`

## 文件结构约定

- `apps/*/src/pages/` — 页面组件
- `apps/*/src/components/` — app 特有组件
- `apps/*/src/stores/` — Zustand stores
- `apps/*/src/api.ts` — API 层
- `packages/*/src/` — 共享代码
- `packages/*/tests/` — 包测试
- `internal/data-workbench/web/` — 内部数据工作台 React 前端
- `internal/data-workbench/server/` — 内部数据工作台 Flask 后端与 migration

## 注意事项

- pdfjs-dist 在 jsdom 环境下需要 mock（DOMMatrix 不可用）
- editorial-preset 是纯 CSS，不含 JS，通过 Tailwind v4 的 @import 机制加载
- 各 app 独立部署，不共享运行时状态
