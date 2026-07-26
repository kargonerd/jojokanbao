# JOJO Desktop

`@jojo/desktop` 是 JOJO 桌面产品唯一的 Electron 运行时。Press 是当前第一个已实现的
业务能力，不再作为独立 app。

当前目录边界：

- `electron/`：Electron 主进程、preload bridge 和桌面端专属集成。
- `src/`：React renderer；当前路由和组件实现 Press 工作流。
- `services/press-engine/`：Press 使用的独立 Python engine。

后续桌面能力继续放在这里，共用 shell、登录状态、路由和发布流程，不再创建
`apps/press`。等第二个桌面能力真正开始实现时，再把 renderer 拆成平级业务模块；
现在提前给 Press 多套一层目录只会增加无效结构。

## 本地开发

```bash
pnpm --filter @jojo/desktop dev
pnpm --filter @jojo/desktop app:dev
pnpm --filter @jojo/desktop typecheck
pnpm --filter @jojo/desktop test
pnpm --filter @jojo/desktop test:e2e
pnpm --filter @jojo/desktop build
```
