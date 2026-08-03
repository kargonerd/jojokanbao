# Codex Agent deployment

当前阶段只部署 Codex Agent。它位于不含中国大陆的独立 EdgeOne Makers 项目，
不进入国内 Web/Python 项目。

```text
jojokanbao.cn                         agent-global.jojokanbao.cn
┌──────────────────────┐             ┌──────────────────────────┐
│ Web + Python API     │ ── HTTPS ─▶ │ /agent  CORS/SSE proxy   │
│ JOJO/Supabase 登录   │             │ /jojo   Makers Agent     │
└──────────────────────┘             │ /internal/codex-auth     │
                                     └──────────────────────────┘
```

- `/agent` 处理浏览器 CORS 预检，并把 SSE 请求转给同项目 `/jojo`。
- `/jojo` 运行 Pi Agent，并在调用 Codex 前校验 JOJO/Supabase Bearer Token。
- `/internal/codex-auth` 只供本地管理命令上传 Codex OAuth，不返回凭证。
- `pnpm prepare:agent-deploy` 生成 `.edgeone/agent-deploy`。
- `.github/workflows/deploy-agent-international.yml` 部署到
  `EDGEONE_AGENT_PROJECT_NAME` 指定的独立 Makers 项目。

## 项目环境变量

```dotenv
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...

JOJO_AGENT_MODEL=gpt-5.6-terra
JOJO_AGENT_ALLOWED_ORIGINS=https://jojokanbao.cn
JOJO_AGENT_UPSTREAM_URL=https://agent-global.jojokanbao.cn/jojo

CODEX_CREDENTIAL_ENCRYPTION_KEY=<32-byte random key encoded as base64>
CODEX_CREDENTIAL_ADMIN_TOKEN=<at least 32 random characters>
```

`CODEX_CREDENTIAL_ENCRYPTION_KEY` 用于把会自动刷新的 Codex OAuth 凭证以
AES-256-GCM 形式写入 Makers 内置 Store。Agent 的 `context.store` 与 Cloud
Function 的 `context.agent.store` 访问同一份数据。`CODEX_CREDENTIAL_ADMIN_TOKEN` 只保护凭证
上传接口；完成初始化后可以从项目环境变量删除它并重新部署。

PowerShell 生成两个随机值：

```powershell
$encryptionBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToBase64String($encryptionBytes)

$adminBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToHexString($adminBytes).ToLowerInvariant()
```

## 初始化 Codex OAuth

先在本机登录：

```powershell
pnpm --filter @jojo/agent-runtime auth:codex
```

部署国际项目后，把本地凭证通过 HTTPS 写入加密 Store：

```powershell
$env:JOJO_AGENT_DEPLOYMENT_URL="https://agent-global.jojokanbao.cn"
$env:CODEX_CREDENTIAL_ADMIN_TOKEN="<与 Makers 项目一致>"
pnpm push:codex-auth
```

上传体不经过环境变量，因此不受 Makers 单个环境变量 500 字节限制。命令只上传
`openai-codex` OAuth 项，不上传 Pi 文件里的其他 Provider 凭证。

## 调用

```http
POST /agent
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
JOJO_AGENT_SYSTEM_PROMPT=你是 JOJO Platform 助手。
```

Codex 订阅模式只用于 MVP 和低并发验证。DeepSeek、Gemini 等后续通过 Makers
Models 统一网关接入，不在 JOJO 中直接保存厂商 API Key。
