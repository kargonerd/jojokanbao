# @jojo/agent-runtime

JOJO Platform 的通用 Pi Agent 运行层。当前阶段只接入 Codex OAuth。

```text
pi-ai
└── Codex OAuth、模型目录和流式请求

pi-agent-core / Agent
└── 消息状态、Agent Loop、工具执行、事件和取消

@jojo/agent-runtime
└── JOJO 事件格式、预算、token/cost 和 Codex 模型配置

RAG / 九闻
└── 各自的提示词和业务工具
```

这里使用 `pi-agent-core` 的高层 `Agent`，不使用 `pi-coding-agent`，也不自行
实现模型与工具之间的循环。其他模型后续统一通过 Makers Models 接入，不在本
阶段预埋直接 Provider。

## 本地登录与验证

```powershell
pnpm --filter @jojo/agent-runtime auth:codex
pnpm --filter @jojo/agent-runtime smoke -- "用一句话介绍你自己"
```

Pi 会打开浏览器完成 ChatGPT 登录，并把凭证写入被 Git 忽略的
`agent/runtime/auth.json`。也可以用 `JOJO_AGENT_AUTH_PATH` 指向已有的 Pi
兼容凭证文件。

默认使用 `gpt-5.6-luna`，推理强度固定为 `low`。模型可以覆盖：

```powershell
$env:JOJO_AGENT_MODEL="gpt-5.6-terra"
```

## SDK

```ts
import {
  createPlatformModelRuntime,
  JsonCredentialStore,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
} from "@jojo/agent-runtime";

const config = resolvePlatformModelConfig(process.env);
const runtime = await createPlatformModelRuntime({
  config,
  credentials: new JsonCredentialStore("agent/runtime/auth.json"),
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

返回值包含聚合后的 token、Pi 成本估算、执行时间、轮次和工具调用数。
