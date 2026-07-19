# @jojo/agent-runtime

JOJO Platform 的通用 Pi Agent 运行层。它只负责 Agent 循环，不包含 RAG、新闻、HTTP 或部署逻辑。

```text
@jojo/agent-runtime
├── Pi Agent 循环
├── 工具调用与预算
├── 通用流式事件
└── token / cost 聚合

业务应用
├── RAG：提供文档搜索工具和档案问答提示词
└── 九闻：提供新闻检索工具和新闻助手提示词
```

## 使用方式

```ts
import { runPlatformAgent } from "@jojo/agent-runtime";

const result = await runPlatformAgent({
  systemPrompt: "你是九闻新闻助手。",
  prompt: "总结今天的重要新闻",
  tools: newsTools,
  model,
  stream: (activeModel, context, options) =>
    models.streamSimple(activeModel, context, options),
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});

console.log(result.usage);
```

模型供应商、凭证、提示词和工具全部由使用方注入，因此同一个运行层可以用于不同产品，也能运行在本地服务器或 EdgeOne Agents。
