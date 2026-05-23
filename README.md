# JOJO Platform

红色杂志风格的历史文献数字平台 — pnpm monorepo。

## 项目结构

```
apps/
  reader/        PDF 报纸/杂志阅读器 (Vite + React 19)
  rag/           RAG 知识库问答 + 文档阅读器 (Vite + React 19)
  press/         PDF 校对工具 (Electron + Vite + React 19)
  jiuwen-web/    新闻聚合 (Next.js 16 + React 19)

packages/
  editorial-preset/   CSS 设计系统 (Tailwind v4 theme + base styles)
  ui/                 共享 React 组件库 (Button, Card, NavBar, Modal, Tag, Pagination, LoadingSpinner)
  pdf-viewer/         共享 PDF 渲染 (PdfPage, PdfViewer, usePdfDocument)

tooling/
  tsconfig/           共享 TypeScript 配置
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发（所有 app 并行启动）
pnpm dev

# 构建所有 app
pnpm build

# 运行所有测试
pnpm test

# 单独开发某个 app
pnpm --filter @jojo/reader dev
pnpm --filter @jojo/rag dev
pnpm --filter @jojo/press dev
pnpm --filter @jojo/jiuwen-web dev
```

## 技术栈

| 层面 | 选择 |
|------|------|
| 语言 | TypeScript (strict) |
| 框架 | React 19 + Vite / Next.js 16 |
| 样式 | Tailwind CSS v4 + @jojo/editorial-preset |
| 状态管理 | Zustand |
| 路由 | React Router 7 / Next.js App Router |
| 测试 | Vitest + @testing-library/react |
| 构建编排 | Turborepo |
| 包管理 | pnpm workspaces |

## 设计系统

所有 app 共享 `@jojo/editorial-preset`，提供：
- 红色杂志配色 (`--color-red: #8b1a1a`)
- 零圆角、衬线字体
- 基础组件类 (`.btn`, `.tag`, `.kicker`)
- 全局样式 (selection, scrollbar, focus ring)

在任何 app 中使用：
```css
@import "@jojo/editorial-preset";
```

## 共享组件

```tsx
import { Button, Card, NavBar, Tag, Pagination, Modal, LoadingSpinner } from "@jojo/ui";
import { PdfViewer, PdfPage, usePdfDocument } from "@jojo/pdf-viewer";
```
