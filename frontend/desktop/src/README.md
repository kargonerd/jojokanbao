# Desktop renderer

- `main.tsx` 是 renderer 入口。
- `shell/` 只提供桌面运行时适配和顶层模块路由；页面框架直接复用 Web 的
  `AppLayout` 与 `AppHeader`。
- `press/` 保留本地 PDF 工作流源码，但当前桌面版本不注册路由，也不进入 renderer。
- 报刊/书籍阅读、资料库、搜索、RAG、Times、通知和 Account 通过 `@jojo/web/desktop` 的显式导出接入，
  避免复制新版 Web 业务实现。
- `electron.d.ts` 和 `test-setup.ts` 是 renderer 级基础文件。

旧版 Archive 首页不在桌面路由中，报刊阅读路由直接复用 Web 实现。Desktop 特有业务
放在本目录；跨端业务优先从 Web 的桌面入口或 `packages/` 复用。
