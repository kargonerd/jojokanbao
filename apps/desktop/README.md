# JOJO Desktop

`@jojo/desktop` 是 JOJO 桌面产品的 Electron 运行时。目前运行 Press 工作流，并为
Archive、Account、RAG 和 Olds 保留 renderer 模块位置。

当前目录边界：

- `electron/`：Electron 主进程、preload bridge 和桌面端专属集成。
- `src/main.tsx`：React renderer 入口。
- `src/press/`：当前可运行的 Press 页面、组件、路由和数据访问。
- `src/archive/`、`src/account/`、`src/rag/`、`src/olds/`：尚未接入的桌面模块占位目录。
- `src/electron.d.ts`：renderer 使用的 preload bridge 类型。
- `src/test-setup.ts`：renderer 测试环境配置。
- `services/press-engine/`：Press 使用的独立 Python engine。

## 本地开发

```bash
pnpm --filter @jojo/desktop dev
pnpm --filter @jojo/desktop app:dev
pnpm --filter @jojo/desktop typecheck
pnpm --filter @jojo/desktop test
pnpm --filter @jojo/desktop test:e2e
pnpm --filter @jojo/desktop build
```
