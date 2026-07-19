# JOJO RAG Agent（本地验证版）

这是一个 Node.js/TypeScript 服务：本地保存 Markdown，使用 Pi agent 调用模型，并只向 agent 暴露两个受限工具：按词搜索文档、按行读取文档。模型不会获得本机文件路径，也不能执行 shell。

## 启动

需要 Node.js 22.19 或更高版本。先在仓库根目录安装依赖：

```powershell
pnpm install
```

真实模型模式：

```powershell
$env:OPENAI_API_KEY="你的 API Key"
$env:RAG_AGENT_MODE="openai"
pnpm --filter @jojo/rag-agent dev
```

本地也可以通过 Pi 自己的 OpenAI Codex OAuth 使用 ChatGPT Plus/Pro 登录态。第一次先在浏览器完成授权：

```powershell
pnpm --filter @jojo/rag-agent auth:codex
```

授权完成后启动：

```powershell
$env:RAG_AGENT_MODE="codex"
pnpm --filter @jojo/rag-agent dev
```

OAuth 凭证保存在 `services/rag-agent/auth.json`，已被 Git 忽略。该模式适合本地质量验证；腾讯云部署仍使用 `openai` 模式和云端密钥管理，不上传本机 OAuth 凭证。

另开一个终端启动前端：

```powershell
pnpm --filter @jojo/rag dev
```

前端默认是 `http://127.0.0.1:5173`，后端默认是 `http://127.0.0.1:8787`。

如果只验证上传、流式界面和统计展示，可以显式启用 mock 模式。mock 返回的不是模型答案：

```powershell
$env:RAG_AGENT_MODE="mock"
pnpm --filter @jojo/rag-agent dev
```

## 数据与配置

- 文档和清单保存在 `services/rag-agent/data/`，已经被 Git 忽略。
- 当前只接受 `.md`，单文件最大 12 MB。
- 默认模型是 `gpt-5.6-luna`，可通过 `RAG_MODEL` 修改。
- 默认推理强度是 `low`，可通过 `RAG_REASONING` 修改。
- 每轮最多 5 个 agent turn、10 次工具调用，防止无界消耗。
- 回答要求给出 `【文档 ID:L起始行-L结束行】` 格式的行号引用。
- SCF 基础估算按 1 GB 内存、实际运行时长和一次调用计算；不含外网流量、COS、CLS 等其他云产品费用。
