# JOJO Desktop

`@jojo/desktop` 是 JOJO 桌面产品的 Electron 运行时。目前运行 Press 工作流，并为
Archive、Account、RAG 和 Olds 保留 renderer 模块位置。

当前目录边界：

- `electron/main.js`：唯一的 Electron 主进程入口；项目声明了 `"type": "module"`，
  因此普通 `.js` 即按 ESM 运行。
- `electron/preload.cjs`：唯一的 preload bridge；CommonJS 是 Electron sandbox
  preload 的运行时边界，不维护同名 TypeScript 或 ESM 副本。
- `e2e/`：Playwright 端到端测试。
- `tests/`：不依赖真实桌面运行时的应用级测试。
- `scripts/`：仅供 Desktop 本地开发使用的 Electron/Python engine 启动器。
- `src/main.tsx`：React renderer 入口。
- `src/press/`：当前可运行的 Press 页面、组件、路由和数据访问。
- `src/archive/`、`src/account/`、`src/rag/`、`src/olds/`：尚未接入的桌面模块占位目录。
- `src/electron.d.ts`：renderer 使用的 preload bridge 类型。
- `src/test-setup.ts`：renderer 测试环境配置。
- `engine/`：Press 使用的 Desktop 专属 Python engine。

Electron 运行时只暴露 `appName`、Python engine 地址和系统 PDF
选择器。项目、识别与校对等业务请求统一由 renderer 调用
`frontend/desktop/engine`，不在 Electron 主进程里维护第二套实现。

## 本地开发

```bash
pnpm --filter @jojo/desktop dev
pnpm --filter @jojo/desktop dev:electron
pnpm --filter @jojo/desktop typecheck
pnpm --filter @jojo/desktop test
pnpm --filter @jojo/desktop test:e2e
pnpm --filter @jojo/desktop build
```
