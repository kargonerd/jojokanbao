# Codex Agent deployment

Codex Agent 运行时只部署在不含中国大陆的独立 EdgeOne Makers 项目。Reader 项目仅部署
同源 `/gateway/ask` 与 `/gateway/times/explain` 流式中继，不包含 Agent 运行时或任何签名密钥；Python 业务 API
不承载 RAG。

```text
reader.jojokanbao.cn                  agent-global.jojokanbao.cn
┌──────────────────────┐             ┌──────────────────────────┐
│ Web + Python API     │             │ Edge Middleware          │
│ /gateway/* relay     │ ── SSE ───▶ │ /rag, /times Agents      │
│ IndexedDB Web history │             │ /gateway/credentials     │
│ JOJO/Supabase 登录   │             │ encrypted OAuth Store    │
└──────────────────────┘             └──────────────────────────┘
```

- 馆藏问答请求 Reader 同源 `/gateway/ask`，Times 随文解释请求同源
  `/gateway/times/explain`。Reader 只转发允许的请求头和请求体，并将
  上游 `ReadableStream` 原样返回；它不读取 Token 内容，也不缓冲 SSE。
- Mobile 直接请求国际 `/rag`，不再经过国际 `/gateway/ask`。
- 国际项目根部 `middleware.ts` 只匹配 `/rag` 与 `/times`。它先向 Supabase Auth 校验 Bearer
  Token，再用 `context.next()` 在项目内部进入 Makers Agent，因此没有第二次 HTTP
  转发或 Node Cloud Function 响应缓冲。
- `/rag` 与 `/times` 内部仍会再次校验 Supabase Token。Middleware 是低成本的前置拒绝，Agent
  鉴权才是执行模型前的最终边界。
- `/rag/health` 与 `/times/health` 不匹配 Middleware，可用于部署健康检查；它们只报告模型配置状态，不
  执行模型。
- `/gateway/credentials` 仍是平台通用的凭据管理 Cloud Function，不返回凭据。当前只
  注册 `agent/openai-codex`，以后由其他业务注册自己的 scope/provider 和校验器。加密
  凭据固定覆盖同一条 Store message，不因 OAuth 刷新持续增长。
- Web 历史按账号保存在 IndexedDB，浏览器不自动清理；Mobile 当前面板的最近对话保留在
  客户端内存。两端每轮都附带最近 20 条上下文，问答服务不读取或写入聊天 Store。
- 默认全馆提问时，Agent 先读取 `catalog.jox` 选最多 8 本候选书，再把这些书随附的
  `jojo-book-search/1` 下载到本次运行内存中检索，只下载命中的少量章节正文。只选中一个
  Item 时，Web 与 Mobile 会把 `manifestObject` 放进请求 scope，Agent 可直接书内查找。
  这条书籍问答链路不再依赖 ES；书籍未提供静态索引时先看目录再按章读取。

`pnpm prepare:agent-deploy` 会生成 `.edgeone/agent-deploy`，其中包括根目录
`middleware.ts`、Makers Agent、凭据管理 Cloud Function 及工作区依赖。
`.github/workflows/deploy-agent-international.yml` 使用 EdgeOne CLI `1.6.26` 部署；这是
Makers Store 跨实例持久化所需的最低版本。Preview 只验证
`/gateway/credentials` 路由，Production 才通过自定义域名检查 `/rag/health`。

## 项目环境变量

Reader 项目只需要配置国际 Agent 地址；未配置时使用代码中的生产默认值：

```dotenv
JOJO_AGENT_URL=https://agent-global.jojokanbao.cn/rag
JOJO_TIMES_AGENT_URL=https://agent-global.jojokanbao.cn/times
```

国际 Agent 项目配置：

```dotenv
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
JOJO_AUTH_TIMEOUT_SECONDS=5
JOJO_AGENT_MODEL=gpt-5.6-luna

JOJO_CREDENTIAL_ENCRYPTION_KEY=<32-byte random key encoded as base64>
JOJO_OPERATOR_TOKEN=<at least 32 random characters>
```

Agent 默认使用 Luna，推理强度固定为 `low`，优先控制 MVP 阶段的订阅额度消耗。

## Trace

JOJO 使用的 Pi Agent 不在 Makers 自动适配框架列表中，因此 Handler 会通过
`context.tracer.span()` 手动创建 `jojo.rag_agent` 或 `jojo.times_agent`，并为每次馆藏工具调用创建
`jojo.tool.*` 子 span。云端控制台只汇总已经部署到该 Makers 项目的真实 `/rag`
请求；`pnpm dev:rag-agent` 的本地请求不会出现在云端控制台。若使用
`edgeone makers dev`，本地 Trace 在 `http://localhost:8088/agent-metrics` 查看。

`JOJO_CREDENTIAL_ENCRYPTION_KEY` 用于把平台托管凭据以 AES-256-GCM 形式写入
Makers 内置 Store。Agent 的 `context.store` 与 Cloud Function 的
`context.agent.store` 访问同一份数据。`JOJO_OPERATOR_TOKEN` 用于平台运维操作，
不能发送给浏览器；后续由 JOJO 管理员登录和 RBAC 替代。

PowerShell 生成两个随机值：

```powershell
$encryptionBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToBase64String($encryptionBytes)

$adminBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToHexString($adminBytes).ToLowerInvariant()
```

## 发布顺序

1. 部署国际 Agent、Reader 和 Mobile。
2. 验证首个 `text_delta` 能在回答结束前到达。
3. 验证 Web 刷新后可从 IndexedDB 恢复历史，并继续携带上下文提问。

当前产品尚未上线，不保留旧 `/gateway/ask` 国际入口或旧 Mobile 兼容分支。

## 初始化 Codex OAuth

先在本机登录：

```powershell
pnpm --filter @jojo/agent auth:codex
```

部署国际项目后，把本地凭证通过 HTTPS 写入加密 Store：

```powershell
$env:JOJO_CREDENTIAL_SERVICE_URL="https://agent-global.jojokanbao.cn"
$env:JOJO_OPERATOR_TOKEN="<与 Makers 项目一致>"
pnpm push:credentials
```

也可以启动 `pnpm dev:admin`，在本机 JOJO 管理台的 `/agent` 页面检查凭据来源并确认
更新。管理台复用同一个 `JOJO_OPERATOR_TOKEN`，浏览器不读取 Token 或 OAuth 明文；
部署端必须先配置相同的 Operator Token。

上传体不经过环境变量，因此不受 Makers 单个环境变量 500 字节限制。命令只上传
`openai-codex` OAuth 项，不上传 Pi 文件里的其他 Provider 凭据。

## 调用

Web 调用 Reader 同源入口：

```http
POST /gateway/ask
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
Makers-Conversation-Id: conv_a1b2c3d4

{"message":"继续解释","history":[{"role":"user","content":"上一问"},{"role":"assistant","content":"上一答"}],"scope":{"datasetIds":["book-a"],"itemIds":["book-a:item-a"],"manifestObjects":["content/books/book-a/items/item-a/manifest.jox"]}}
```

Reader 将同一请求流式转发到国际 `/rag`。Mobile 则直接使用完整 `/rag` URL。
`Makers-Conversation-Id` 必须是客户端生成并持续复用的 6–36 位 URL-safe 会话 ID。
SSE 的 `usage` 与 `done` 事件均包含 token 数和 Pi 提供的美元成本估算。
`tool_end` 事件只携带精简引用位置，不把整段工具结果塞进 SSE；Web 将最终助手消息和
同一组引用写入 IndexedDB。服务端不提供聊天历史的列表、恢复或删除接口。

可选预算：

```dotenv
JOJO_AGENT_MAX_TURNS=8
JOJO_AGENT_MAX_TOOL_CALLS=20
JOJO_AGENT_SYSTEM_PROMPT=你是 JOJO 看报助手。
```

Codex 订阅模式只用于 MVP 和低并发验证。DeepSeek、Gemini 等后续通过 Makers Models
统一网关接入，不在 JOJO 中直接保存厂商 API Key。
