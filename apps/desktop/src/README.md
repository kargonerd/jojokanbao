# Desktop renderer

- `main.tsx` 是 renderer 入口。
- `press/` 是当前可运行模块。
- `archive/`、`account/`、`rag/`、`olds/` 当前仅保留模块位置，不注册路由，也不包含在
  可用功能中。
- `electron.d.ts` 和 `test-setup.ts` 是 renderer 级基础文件。

业务代码放在对应一级模块内，可按 `pages/`、`components/`、`stores/` 和 `api.ts`
继续拆分。跨业务复用的代码应优先进入 `packages/`。
