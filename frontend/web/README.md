# JOJO Web

`@jojo/web` 是部署到 `reader.jojokanbao.cn` 的统一 Web 客户端。Archive、Account、RAG、Olds 分别位于 `src/archive`、`src/account`、`src/rag`、`src/olds`；不再为每个模块维护独立 SPA，也不额外套 `features/`。

## 路由

- 当前正式开放：`/archive`、`/archive/{rmrb|ckxx|hq|rmhb|sjzs}/:id`、`/archive/search`、`/archive/support`
- 待发布：`/account`、`/rag/*`、`/olds/*`

旧 Reader 地址（例如 `/rmrb/19761009#page-5`）以及短暂使用过的 `/reader/*` 前缀会迁移到 `/archive/*`，并保留查询参数和锚点。静态托管必须将未知路径回退到 `index.html`，否则深链接会返回 404。

## 本地运行

在仓库根目录 `.env` 配置共享变量；仅需覆盖当前机器的值时使用
优先级更高的 `.env.local`：

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_ENABLE_ACCOUNT=false
VITE_ENABLE_RAG=false
VITE_ENABLE_OLDS=false
VITE_RAG_API_BASE=
VITE_OLDS_API_BASE=http://127.0.0.1:3001
```

然后运行：

```bash
pnpm --filter @jojo/web dev
```

未完成模块默认不可路由、不会显示在导航中，但源码仍会随项目进行类型检查和单元测试。本地开发某个模块时，将对应的 `VITE_ENABLE_*` 改为 `true` 并重启 Vite；正式部署在 rollout 前保持这些变量缺省或为 `false`。账号模块还需要同时配置根目录 `.env.example` 列出的 Supabase 浏览器端公开值。

RAG 与 Olds 的旧管理页面源码暂时保留用于迁移对照，但不注册路由。它们必须先接入统一账号的权限模型，才能在后续变更中开放。

## 账号中心

启用 Account 后，未登录读者在 `/account` 看到登录与邀请注册；已登录读者留在
同一路径管理账号，不会被重定向到 Archive。账号中心可以修改昵称、查看或复制
个人邀请码、在邀请码未使用时换码，并显示过期、已使用和管理员停用状态。

邀请码状态由 `src/account/invitationStore.ts` 管理，并绑定当前 user id。切换账号会
立即清空旧状态，晚返回的旧请求不能覆盖新账号数据。每个邀请码的生成、换码和
最终可用性仍以 Supabase 数据库函数为准，前端状态不作为授权依据。
