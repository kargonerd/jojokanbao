# JOJO Web

`@jojo/web` 是部署到 `reader.jojokanbao.cn` 的统一 Web 客户端。Archive、Account、RAG、Olds 分别位于 `src/archive`、`src/account`、`src/rag`、`src/olds`；不再为每个模块维护独立 SPA，也不额外套 `features/`。

## 路由与整站发布开关

- 生产默认（`VITE_ENABLE_PLATFORM_REDESIGN=false`）：保持原站路由和界面，`/` 跳转 `/archive`
- 新版预览（`VITE_ENABLE_PLATFORM_REDESIGN=true`）：开放 `/`、`/library`、`/search`、`/support`、`/account`、`/book/:datasetId/:itemKey`，并保留 `/archive/*`
- 待发布：`/rag/*`、`/olds/*`

旧 Reader 地址（例如 `/rmrb/19761009#page-5`）以及短暂使用过的 `/reader/*` 前缀会迁移到 `/archive/*`，并保留查询参数和锚点。静态托管必须将未知路径回退到 `index.html`，否则深链接会返回 404。

首页搜索框只搜索已发布书籍的书名，并在浏览器端完成模糊匹配；正文检索继续由 `/search` 提供。登录读者可从资料库加入“我的书架”，书架保存在账号的服务端数据中；继续阅读记录仍保存在浏览器本地。未登录点击加入书架会前往账号登录并带上 `returnTo`。资料库顶层直接展示报刊与书籍封面，不提供重复的标题、日期和二次搜索工具栏。

## 本地运行

在仓库根目录 `.env` 配置共享变量；仅需覆盖当前机器的值时使用
优先级更高的 `.env.local`：

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_ENABLE_PLATFORM_REDESIGN=true
VITE_ENABLE_RAG=false
VITE_ENABLE_OLDS=false
VITE_RAG_API_BASE=
VITE_OLDS_API_BASE=http://127.0.0.1:3001
```

## 划线评论

最新设计中的书籍阅读器和新闻正文共用 `src/annotations/`。读者必须登录且命中
`reader.annotations` 功能开关，才能读取划线、发表评论、回复其他读者或举报评论。
旧 `src/archive/` PDF 页面不接入此能力。后端契约由 Supabase 迁移
`202608180001_unified_annotations.sql` 提供。

同一迁移还提供通用站内通知表和用户 RPC。回复评论会通知被回复者，直接评论划线会
通知划线作者；自己触发的事件不会给自己发通知。登录读者可从新版页头进入
`/notifications`，前台每 30 秒及窗口重新聚焦时刷新未读数。当前不包含邮件或系统推送。

然后运行：

```bash
pnpm --filter @jojo/web dev
```

`VITE_ENABLE_PLATFORM_REDESIGN` 是整站构建开关。关闭时不会注册新版首页、资料库、公开书籍阅读和新版账号入口，共享的 Archive 导航、搜索、反馈页也按旧版呈现。仓库的正式部署工作流默认把它设为 `false`；合并代码不会开放新版，只有显式设置仓库变量为 `true` 并重新部署 Reader 才会切换。

其他未完成模块默认不可路由、不会显示在导航中，但源码仍会随项目进行类型检查和单元测试。本地开发某个模块时，将对应的 `VITE_ENABLE_*` 改为 `true` 并重启 Vite。账号模块需要配置根目录 `.env.example` 列出的 Supabase 浏览器端公开值。

RAG 与 Olds 的旧管理页面源码暂时保留用于迁移对照，但不注册路由。它们必须先接入统一账号的权限模型，才能在后续变更中开放。

## 账号中心

首页与 Archive 导航始终提供登录入口。未登录读者在 `/account` 看到登录与邀请注册；
邮箱确认成功页会先展示数据库分配的读者代号，
读者确认后再进入 `/archive` 首页。已登录时，Archive 导航右侧直接显示读者代号；已
登录读者主动进入 `/account` 时，只显示数据库自动分配且暂不可修改的读者代号，以及
个人邀请码。邀请码可复制、在未使用时换码，并显示过期、已使用和管理员停用状态。

邀请码状态由 `src/account/invitationStore.ts` 管理，并绑定当前 user id。切换账号会
立即清空旧状态，晚返回的旧请求不能覆盖新账号数据。每个邀请码的生成、换码和
最终可用性仍以 Supabase 数据库函数为准，前端状态不作为授权依据。
