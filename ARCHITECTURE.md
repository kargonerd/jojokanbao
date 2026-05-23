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
apps/jiuwen  ──→ @jojo/ui + @jojo/editorial-preset
```

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
