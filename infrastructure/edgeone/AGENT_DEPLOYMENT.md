# Codex Agent deployment

Codex Agent 运行时只部署在不含中国大陆的独立 EdgeOne Makers 项目。
Reader 项目仅部署同源 `/gateway/ask` 流式中继，不包含 Agent 运行时或签名密钥；
Python 业务 API 不承载 RAG。

```text
reader.jojokanbao.cn                  agent-global.jojokanbao.cn
┌──────────────────────┐             ┌──────────────────────────┐
│ Web + Python API     │ ── HTTPS ─▶ │ /gateway/ask auth proxy │
│ /gateway/ask relay   │             │ /jojo   Makers Agent     │
│ JOJO/Supabase 登录   │             │ /gateway/credentials     │
└──────────────────────┘             └──────────────────────────┘
```

- Reader 的 `/gateway/ask` 只把允许的请求头和 AI 请求体转发给国际 Gateway，并把上游
  SSE 响应返回给浏览器；它不读取 Token 内容，也不持有 Agent 签名密钥。国际
  `/gateway/ask` 使用当前用户 Bearer Token
  向 Supabase Auth 确认用户身份；通过后添加短时 HMAC 服务签名，再把
  SSE 请求转给同项目 `/jojo`。
- `/jojo` 运行 Pi Agent，并在调用 Codex 前依次校验 Cloud Function 服务签名
  和 JOJO/Supabase Bearer Token；它不处理平台入口开关，浏览器也不能直接调用。
- `/gateway/credentials` 是平台通用的凭据管理入口，不返回凭据。当前只注册
  `agent/openai-codex`，以后由其他业务注册自己的 scope/provider 和校验器。
- `pnpm prepare:agent-deploy` 生成 `.edgeone/agent-deploy`。
- `.github/workflows/deploy-agent-international.yml` 部署到
  `EDGEONE_AGENT_PROJECT_NAME` 指定的独立 Makers 项目。
- Preview 的 `.edgeone.dev` 地址只检查 `/gateway/credentials` Cloud Function 路由；
  Makers Agent endpoint 需要绑定自定义域名，Production 才通过
  `EDGEONE_AGENT_BASE_URL` 检查 `/gateway/ask` 到 `/jojo/health` 的完整链路。

## 项目环境变量

Reader 项目只需要配置国际 Gateway 地址；未配置时使用下方默认地址：

```dotenv
JOJO_AGENT_GATEWAY_URL=https://agent-global.jojokanbao.cn/gateway/ask
```

国际 Agent 项目配置：

```dotenv
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
JOJO_AGENT_MODEL=gpt-5.6-luna
JOJO_AGENT_ALLOWED_ORIGINS=https://reader.jojokanbao.cn
JOJO_AGENT_UPSTREAM_URL=https://agent-global.jojokanbao.cn/jojo
JOJO_AGENT_SERVICE_SECRET=<32-byte random key encoded as base64>

JOJO_CREDENTIAL_ENCRYPTION_KEY=<32-byte random key encoded as base64>
JOJO_OPERATOR_TOKEN=<at least 32 random characters>
```

Agent 默认使用 Luna，推理强度固定为 `low`，优先控制 MVP 阶段的订阅额度消耗。

`JOJO_AGENT_SERVICE_SECRET` 只保存在同一 Makers 项目的 Cloud Function 和
Agent 运行环境中。`/gateway/ask` 使用它对请求方法、会话 ID、规范化请求体、60 秒
时间戳和随机 nonce 做 HMAC-SHA256 签名；`/jojo` 在用户鉴权及模型初始化前
验证签名。签名头不允许由浏览器传入，也不会把密钥发送给客户端。

`JOJO_CREDENTIAL_ENCRYPTION_KEY` 用于把平台托管凭据以 AES-256-GCM 形式写入
Makers 内置 Store。Agent 的 `context.store` 与 Cloud Function 的
`context.agent.store` 访问同一份数据。`JOJO_OPERATOR_TOKEN` 用于平台运维操作，
不能发送给浏览器；后续由 JOJO 管理员登录和 RBAC 替代。

PowerShell 生成三个随机值：

```powershell
$encryptionBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToBase64String($encryptionBytes)

$serviceBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToBase64String($serviceBytes)

$adminBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToHexString($adminBytes).ToLowerInvariant()

```

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

也可以启动 `pnpm dev:admin`，在本机 JOJO 管理台的 `/agent` 页面检查凭据
来源并确认更新。管理台复用同一个 `JOJO_OPERATOR_TOKEN`，浏览器不读取 Token
或 OAuth 明文；部署端必须先配置相同的 Operator Token。

上传体不经过环境变量，因此不受 Makers 单个环境变量 500 字节限制。命令只上传
`openai-codex` OAuth 项，不上传 Pi 文件里的其他 Provider 凭证。

## 调用

```http
POST /gateway/ask
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
Makers-Conversation-Id: conv_a1b2c3d4

{"message":"你好"}
```

`Makers-Conversation-Id` 必须是客户端生成并持续复用的 6–36 位 URL-safe 会话
ID。SSE 的 `usage` 与 `done` 事件均包含 token 数和 Pi 提供的美元成本估算。

可选预算：

```dotenv
JOJO_AGENT_MAX_TURNS=8
JOJO_AGENT_MAX_TOOL_CALLS=20
JOJO_AGENT_SYSTEM_PROMPT=你是 JOJO 看报助手。
```

Codex 订阅模式只用于 MVP 和低并发验证。DeepSeek、Gemini 等后续通过 Makers
Models 统一网关接入，不在 JOJO 中直接保存厂商 API Key。
