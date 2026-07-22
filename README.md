# JOJO Platform

红色杂志风格的历史文献数字平台 — pnpm monorepo。

## 项目结构

```
blog/
  articles/      Obsidian 博客文章

apps/
  homepage/      博客静态站点渲染器 (Astro 5)
  reader/        PDF 报纸/杂志阅读器 (Vite + React 19)
  rag/           RAG 知识库问答 + 文档阅读器 (Vite + React 19)
  press/         PDF 校对工具桌面端 (Electron + Vite + React 19)
  jiuwen-web/    新闻聚合 (Next.js 16 + React 19)
  jiuwen-mobile/ 新闻聚合移动端 (Expo + React Native)

services/
  rag-backend/          JOJO-RAG Flask/SCF 后端
  press-engine/         JOJO Press FastAPI 后端
  jiuwen-api/           JOJO旧闻 FastAPI 后端
  jiuwen-news-reader/   旧新闻阅读器前端原型；旧 Express 后端已归档
  reader-search/        JOJO看报 Elasticsearch 搜索服务
  jojo-pipe/            PDF 入库/批处理工具
  notebooklm-py/        NotebookLM Python 客户端 vendored copy

references/
  jiuwen-folo-analysis/ Folo/Follow 上游参考工程归档，不参与本仓库构建
  legacy-rag-frontend/  原 jojo-rag Vue 前端归档
  legacy-reader-web/   原 WebstormProjects/web Vue reader 归档
  legacy-press-root/   原 jojo-press 根目录旧 server/static/scripts 归档
  legacy-jiuwen-root/  原 jojojiuwen 根目录 docs/demo/docker/scripts 归档

packages/
  auth/               Supabase 客户端、会话状态与账号资料访问
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
pnpm --filter @jojo/homepage dev
pnpm --filter @jojo/reader dev
pnpm --filter @jojo/rag dev
pnpm --filter @jojo/press dev
pnpm --filter @jojo/jiuwen-web dev
pnpm dev:jiuwen-mobile

# 后端/服务（需先按各 service README 安装依赖）
pnpm dev:rag-backend
pnpm dev:press-engine
pnpm dev:reader-search
pnpm dev:jiuwen-api
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
| 后端 | Python Flask / FastAPI services |

## 迁移边界

`apps/` 和 `packages/` 参与当前 pnpm/turbo 前端工作区；`services/` 保留当前 Python 后端和工具源码，但不加入 pnpm workspace，避免服务依赖污染前端工作区。服务各自独立安装依赖和运行。旧 Node/Nest/Express 后端归档在 `references/legacy-node-backends/`，不参与构建、测试或部署。

迁移时刻意排除了 `.env`、数据库、运行输出、截图、日志、`node_modules`、构建产物等本地状态文件。配置只保留 `*.example.*` 或源码中的默认配置。

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

## Auth 基础设施

`@jojo/auth` 封装浏览器端 Supabase 客户端、会话同步和账号资料访问。前端仅配置
`.env.local` 中的 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`；这两个值是
可公开的项目标识，不要在前端配置 `service_role` key 或 Supabase access token。

账号资料表、RLS 策略和头像存储规则位于 `supabase/migrations/`。注册方式和邀请码校验
不属于该基础包，将由独立变更实现。

## Reader release

Reader deploys are isolated from the rest of the monorepo. Ordinary pushes to `master` run Reader CI only when reader-related paths change, and they do not deploy. Other apps can use their own tags without triggering reader deployment.

`master` is protected by a repository ruleset and must be updated through pull requests. Reader release tags are also protected: only repository admins can create, update, or delete `reader-*` tags.

Automatic reader deployment is triggered only by reader-specific tags:

```bash
git checkout master
git pull
git tag reader-vYYYYMMDD
git push origin reader-vYYYYMMDD
```

For example:

```bash
git tag reader-v20260628
git push origin reader-v20260628
```

The `Deploy reader web` workflow builds `@jojo/reader` and uploads `apps/reader/dist/` to Tencent COS. It is also available through manual `workflow_dispatch` in GitHub Actions.

## Reader PDF protection

Reader can load JOJO-protected PDF bytes through HTTP Range requests while crawlers that fetch the raw `.pdf` object receive bytes that do not open as a normal PDF.

Encode local PDF files before uploading them back to the reader CDN/object storage:

```bash
# one file, write to another path
pnpm protect:reader-pdf encode input.pdf output.pdf

# directory, update *.pdf in place
pnpm protect:reader-pdf encode ./pdf-root --recursive

# publish selected reader issues through qpdf linearization + protection
# destination comes from services/jojo-pipe/config.json storage settings
pnpm publish:reader-pdf -- --collection rmrb --source D:\PDF\RMRB --issue 19460515 --issue 19460516
```

Verify local files or published URLs after upload:

```bash
pnpm verify:reader-pdf ./pdf-root/RMRB/1946/19460515.pdf
pnpm verify:reader-pdf https://blacknews.jojokanbao.cn/RMRB/1946/19460515.pdf
```

If `blacknews.jojokanbao.cn` still reports `state=plain` after the object storage copy is verified as protected, clear EdgeOne URL cache and verify again:

```bash
pnpm purge:reader-pdf -- --zone-id <edgeone-zone-id> https://blacknews.jojokanbao.cn/RMRB/1946/19460515.pdf
pnpm verify:reader-pdf https://blacknews.jojokanbao.cn/RMRB/1946/19460515.pdf

# or purge and poll until verification passes
pnpm finalize:reader-pdf -- --zone-id <edgeone-zone-id> https://blacknews.jojokanbao.cn/RMRB/1946/19460515.pdf
```

Expected protected output is `PASS ... state=protected range=206 direct=fails decodedPages=N` for URLs. If the verifier reports `state=plain`, the object is still an ordinary PDF and must be encoded before publishing.
