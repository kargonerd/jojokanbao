# Agent deployment

JOJO Agent 使用 EdgeOne Makers 的无框架 Agent Runtime，不放进 Node Cloud
Functions。原因是 Pi 当前要求 Node.js `>=22.19`，而 Cloud Functions 的默认
Node Runtime 仍低于该版本；Makers Agents 同时提供更长的执行时间、会话路由和
Agent 观测能力。

## 两种部署

```text
国内模式（同一个 Makers 项目）
jojokanbao.cn
├── Web 静态文件
├── /api/*       Python Cloud Functions
└── /jojo        Node Makers Agent（默认 DeepSeek）

国际模式（独立 Makers 项目）
agent-global.jojokanbao.cn
├── /agent       跨域/CORS Cloud Function 薄代理
└── /jojo        同一套 Node Makers Agent（默认 Codex）
```

- `pnpm prepare:web-deploy` 会把国内 Agent 与 Web、Python API 一起组装到
  `.edgeone/web-deploy`。
- `pnpm prepare:agent-deploy` 只生成国际 Agent 包
  `.edgeone/agent-deploy`。
- `.github/workflows/deploy-agent-international.yml` 使用
  `EDGEONE_AGENT_PROJECT_NAME` 指定独立的国际 Makers 项目。

部署入口只有平台适配代码；Agent 循环、provider 和认证实现仍位于
`agent/runtime` 与 `agent/edgeone`。

## 环境变量

两个项目都需要 JOJO 登录验证：

```dotenv
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

国内默认配置：

```dotenv
JOJO_AGENT_PROFILE=domestic
JOJO_AGENT_PROVIDER=deepseek
JOJO_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=...
```

也可以切换到 Gemini：

```dotenv
JOJO_AGENT_PROVIDER=google
JOJO_AGENT_MODEL=gemini-3.5-flash
GEMINI_API_KEY=...
```

国际 Codex 配置：

```dotenv
JOJO_AGENT_PROFILE=international
JOJO_AGENT_PROVIDER=openai-codex
JOJO_AGENT_MODEL=gpt-5.6-terra
CODEX_AUTH_JSON={"openai-codex":{...}}
JOJO_AGENT_CREDENTIAL_KEY=<32-byte AES key encoded as base64>
JOJO_AGENT_ALLOWED_ORIGINS=https://jojokanbao.cn
JOJO_AGENT_UPSTREAM_URL=https://agent-global.jojokanbao.cn/jojo
```

`CODEX_AUTH_JSON` 的初始值来自本机完成 Pi 登录后生成的
`agent/runtime/auth.json`。首次请求会将它用 AES-256-GCM 加密后写入
Makers Blob；Pi 刷新 OAuth 后也会写回加密 Blob。环境变量中的 JSON 只作为
首次初始化种子。

PowerShell 生成加密密钥：

```powershell
[Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
```

Codex 订阅模式适合 MVP 和低并发验证。正式商业流量优先使用独立 API Key
provider，避免多人共享个人订阅凭证。

可选预算配置：

```dotenv
JOJO_AGENT_MAX_TURNS=8
JOJO_AGENT_MAX_TOOL_CALLS=20
JOJO_AGENT_SYSTEM_PROMPT=你是 JOJO Platform 助手。
```

## 路由与安全

- 国内同域调用 `POST /jojo`；国际项目供主站调用 `POST /agent`，后者只处理
  CORS/OPTIONS 并把 SSE 流转给同项目 `/jojo`。
- `GET /jojo/health`：只返回 provider、model 和是否已配置，不返回凭证。
- 所有 Makers Agent 请求（包括 health）必须携带
  `Makers-Conversation-Id`；值为客户端生成并持续复用的 6–36 位会话 ID。
- `/jojo` 会使用与 Python API 相同的 Supabase `/auth/v1/user` 校验 Bearer
  Token。未登录请求不会初始化模型，也不会产生模型费用。

```http
POST /agent
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
Makers-Conversation-Id: conv_a1b2c3d4

{"message":"你好"}
```

SSE 的 `usage` 与 `done` 事件均包含 token 数和 Pi 提供的美元成本估算。

RAG 和九闻后续通过 `createEdgeOneAgentHandler()` 注入各自的系统提示词和工具，
不复制 provider、OAuth、SSE 或部署代码。
