# @jojo/agent-runtime

JOJO Platform 的通用 Pi Agent 运行层。它使用 `pi-agent-core` 的高层
`Agent`，不使用 `pi-coding-agent`，也不自行实现模型与工具之间的循环。

```text
pi-ai
└── Codex OAuth、Gemini/DeepSeek API Key、模型目录和流式请求

pi-agent-core / Agent
└── 消息状态、Agent Loop、工具执行、事件和取消

@jojo/agent-runtime
└── JOJO 事件格式、预算、token/cost 和部署配置

RAG / 九闻
└── 各自的提示词和业务工具
```

## Provider

| 配置值 | Pi provider | 凭证 |
| --- | --- | --- |
| `codex` / `openai-codex` | `openai-codex` | ChatGPT Plus/Pro OAuth |
| `gemini` / `google` | `google` | `GEMINI_API_KEY` |
| `deepseek` | `deepseek` | `DEEPSEEK_API_KEY` |

公共配置：

```dotenv
JOJO_AGENT_PROFILE=domestic
JOJO_AGENT_PROVIDER=deepseek
JOJO_AGENT_MODEL=deepseek-v4-flash
```

`domestic` 默认使用 `deepseek/deepseek-v4-flash`；`international`
默认使用 `openai-codex/gpt-5.6-terra`。三项都可以通过环境变量覆盖。

## Codex 登录

在本机执行：

```powershell
pnpm --filter @jojo/agent-runtime auth:codex
```

Pi 会打开浏览器完成 ChatGPT 登录，并把凭证写入被 Git 忽略的
`agent/runtime/auth.json`。运行一次真实连通测试：

```powershell
$env:JOJO_AGENT_PROFILE="international"
pnpm --filter @jojo/agent-runtime smoke -- "用一句话介绍你自己"
```

也可以用 `JOJO_AGENT_AUTH_PATH` 指向已有的兼容 `auth.json` 文件做本地测试。

API Key provider 的测试方式：

```powershell
$env:JOJO_AGENT_PROVIDER="gemini"
$env:JOJO_AGENT_MODEL="gemini-3.5-flash"
$env:GEMINI_API_KEY="..."
pnpm --filter @jojo/agent-runtime smoke -- "你好"
```

## SDK

```ts
import {
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
} from "@jojo/agent-runtime";

const config = resolvePlatformModelConfig(process.env, "domestic");
const runtime = await createPlatformModelRuntime({
  config,
  environment: process.env,
});

const result = await runPlatformAgent({
  systemPrompt: "你是九闻新闻助手。",
  prompt: "总结今天的重要新闻",
  tools: newsTools,
  model: runtime.model,
  stream: modelRuntimeStream(runtime),
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
```

Pi `Agent` 负责实际循环；JOJO 包装层只保留跨产品需要的事件格式、工具/轮次预算、
错误边界以及 token/cost 汇总。模型错误、取消或未完成的预算终止都会拒绝本次运行，
不会返回伪成功。
