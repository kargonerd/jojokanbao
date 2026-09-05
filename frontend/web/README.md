# JOJO Web

`@jojo/web` 是部署到 `reader.jojokanbao.cn` 的统一 Web 客户端。应用外壳、首页、资料库分别位于 `src/shell`、`src/home`、`src/library`；Archive、Account、RAG、JOJO Times 分别位于 `src/archive`、`src/account`、`src/rag`、`src/times`。不再为每个模块维护独立 SPA，也不额外套 `features/`。

## 路由与整站发布开关

- 生产默认（`VITE_ENABLE_PLATFORM_REDESIGN=false`）：保持原站路由和界面，`/` 跳转 `/archive`
- 新版预览（`VITE_ENABLE_PLATFORM_REDESIGN=true`）：一次开放新版首页、资料库、账号、RAG、时事和阅读器，并保留 `/archive/*`
- 本地 `vite dev`：始终使用新版，不需要配置发布开关

旧 Reader 地址（例如 `/rmrb/19761009#page-5`）以及短暂使用过的 `/reader/*` 前缀会迁移到 `/archive/*`，并保留查询参数和锚点。静态托管必须将未知路径回退到 `index.html`，否则深链接会返回 404。

首页搜索框只搜索已发布书籍的书名，并在浏览器端完成模糊匹配；正文检索继续由 `/search` 提供。登录读者可从资料库加入“我的书架”，书架保存在账号的服务端数据中；继续阅读记录仍保存在浏览器本地。未登录点击加入书架会前往账号登录并带上 `returnTo`。资料库顶层直接展示报刊与书籍封面，不提供重复的标题、日期和二次搜索工具栏。

## 桌面安装与在线阅读

`/download` 仅提供 iPhone 的网页版安装入口，点击“添加到主屏幕”后进入独立的
`/download/iphone` 页面查看 Safari 安装说明，可返回下载页。Android 卡片只提供原生安装包。
安装后以独立窗口打开，启动地址为 `/`，继续遵循当前整站发布开关与账号权限。

应用清单位于 `public/manifest.webmanifest`，图标由
`public/brand/jojo-kanbao-mark.svg` 导出：保留猫咪与报纸，将圆形底色扩展为铺满画布的
不透明酒红色背景，不预先裁圆角，避免系统裁切后出现白边。Apple touch icon 为
`app-icon-180.png`，普通图标为 192px / 512px；512px maskable 图标将图案缩至
410px 居中，背景仍铺满画布，保留系统裁切安全区。更换图片时同步更新资源文件名；
已安装的旧图标需删除后从 Safari 重新添加。
入口保留默认视口安全区与非透明状态栏，不启用 `viewport-fit=cover`。
Archive 阅读外壳使用动态视口高度，兼容浏览器工具栏变化和独立窗口。

基础版仅提供联网阅读，不注册 Service Worker，不额外缓存账号 API、PDF 或书籍。
安装不会自动迁移 Safari、其他浏览器或原生客户端的本地阅读记录；
账号可在独立窗口内重新登录。正式版与 Beta 使用各自来源的清单与启动地址。

发布沿用现有 Web 构建与 EdgeOne 流程，`public/` 下的清单和图标会进入部署产物。
`pnpm --filter @jojo/web verify:build` 同时检查清单引用及 PNG 尺寸。
发布前应在真机验证桌面添加、冷启动、登录回跳、阅读与搜索、返回、横竖屏和键盘遮挡；
基础版不承诺离线阅读或系统推送。

## 本地运行

在仓库根目录 `.env` 配置共享变量；仅需覆盖当前机器的值时使用
优先级更高的 `.env.local`：

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Git worktree 自己没有 `.env` 时，Web、Desktop 和本地 Agent 会自动读取主工作区的 `.env` 和 `.env.local`；
当前 worktree 若存在自己的环境文件，则优先使用自己的配置。真实值不会写入或提交到功能分支。

报刊、书籍、RAG 馆藏与 Times 都通过 `VITE_CONTENT_CDN_BASE` 读取 B2 CDN 已发布的
Jox 内容，不为不同模块配置额外的内容源。Agent 请求走
`/gateway/ask`，再由 Reader Cloud Function 转发到国际 Agent。浏览器不配置模块 API
Base 或直连 Agent 域名。AI 与时事入口仍只向已登录读者显示；账号、Agent 和划线评论等
写操作继续校验 Supabase access token。本地 Vite 服务器使用服务端
`JOJO_AGENT_URL` 把同一个 `/gateway/ask` 路径流式转发到国际 `/rag`。
历史记录按登录账号保存在浏览器 IndexedDB，不设置自动过期。每轮请求只携带最近 20
条用户/助手消息，国际问答服务不保存聊天历史。以后云同步只需同步同一套会话、消息和
引用结构。单本提问
优先使用书籍随附的静态搜索索引，回答引用可直接跳转到 Reader 章节和原文。AI 首页默认直接在
所有 `catalog.jox` 中显式标记 `aiEnabled: true` 的书籍里提问；选择一本或多本书籍只是
可选的范围收窄。字段缺失或为 `false` 的报刊、杂志和 JOJO 时事不会出现在 AI 资料列表中。

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
pnpm dev:reader-search
pnpm dev:agent
pnpm --filter @jojo/web dev
```

本地 Agent 默认监听 `127.0.0.1:8789`，读取本机 Codex OAuth。Web 对话保存在浏览器
IndexedDB，因此重启本地 Agent 不会清空历史。`.env.local` 可用
`JOJO_AGENT_URL=http://127.0.0.1:8789/rag` 让 Web 开发代理连接它。正式环境不使用这套
进程内聊天存储；国际 EdgeOne Makers Agent 只负责流式回答，Web 历史仍留在用户浏览器。

`VITE_ENABLE_PLATFORM_REDESIGN` 是生产环境唯一的整站构建开关。关闭时不会注册新版首页、资料库、账号、RAG 和公开书籍阅读入口，共享的 Archive 导航、搜索、反馈页也按旧版呈现。仓库的正式部署工作流默认把它设为 `false`；合并代码不会开放新版，只有显式设置仓库变量为 `true` 并重新部署 Reader 才会切换。本地开发不读取这个回滚开关，始终启动新版。

其他未完成模块默认不可路由、不会显示在导航中，但源码仍会随项目进行类型检查和单元测试。账号模块需要配置根目录 `.env.example` 列出的 Supabase 浏览器端公开值。

RAG 与 JOJO Times 的旧管理页面源码暂时保留用于迁移对照，但不注册路由。它们必须先接入统一账号的权限模型，才能在后续变更中开放。

## 账号中心

首页与 Archive 导航始终提供登录入口。未登录读者在 `/account` 看到登录与邀请注册；
邮箱确认成功页会先展示数据库分配的读者代号，
读者确认后再进入 `/archive` 首页。已登录时，Archive 导航右侧直接显示读者代号；已
登录读者主动进入 `/account` 时，只显示数据库自动分配且暂不可修改的读者代号，以及
个人邀请码。邀请码可复制、在未使用时换码，并显示过期、已使用和管理员停用状态。

邀请码状态由 `src/account/invitationStore.ts` 管理，并绑定当前 user id。切换账号会
立即清空旧状态，晚返回的旧请求不能覆盖新账号数据。每个邀请码的生成、换码和
最终可用性仍以 Supabase 数据库函数为准，前端状态不作为授权依据。
