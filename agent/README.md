# @jojo/agent

JOJO 看报的通用 Pi Agent 运行层。当前阶段只接入 Codex OAuth。

```text
pi-ai
└── Codex OAuth、模型目录和流式请求

pi-agent-core / Agent
└── 消息状态、Agent Loop、工具执行、事件和取消

@jojo/agent
└── JOJO 事件格式、预算、token/cost 和 Codex 模型配置

applications.ts / rag-tools.ts
└── RAG 提示词，以及搜索、读片段、按需扫描整本三个工具
```

这里使用 `pi-agent-core` 的高层 `Agent`，不使用 `pi-coding-agent`，也不自行
实现模型与工具之间的循环。其他模型后续统一通过 Makers Models 接入，不在本
阶段预埋直接 Provider。

## 本地登录与验证

```powershell
pnpm --filter @jojo/agent auth:codex
pnpm --filter @jojo/agent smoke -- "用一句话介绍你自己"
```

Pi 会打开浏览器完成 ChatGPT 登录，并把凭证写入被 Git 忽略的
`agent/auth.json`。也可以用 `JOJO_AGENT_AUTH_PATH` 指向已有的 Pi
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
} from "@jojo/agent";

const config = resolvePlatformModelConfig(process.env);
const runtime = await createPlatformModelRuntime({
  config,
  credentials: new JsonCredentialStore("agent/auth.json"),
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

## 馆藏 RAG 工具

- `list_library_books`：读取小型 `catalog.jox`，列出支持 AI 的书籍，不下载正文。
- `list_book_items`：读取候选书的 Dataset Index，列出分卷与 Manifest 路径。
- `search_content`：把最多 8 本候选书的随书 `search.jox` 下载到本次运行内存中检索，
  不依赖 Elasticsearch，也不下载章节正文；默认静态索引压缩体预算为 16 MiB。
- `search_selected_item`：用户限定单本书时直接在该书的内存静态索引中查找。
- `read_fragment`：从 CDN 解码一个完整章节或文章，默认优先使用。
- `inspect_item`：考虑扫描全本时只读取小型 Manifest，返回章节数、字符数、预计处理量和
  预算以及目录预览，不读取正文；Agent 据此决定下一步。
- `list_item_toc`：分页查看完整层级目录，并返回每个可读目录项对应的 `fragmentObject`；
  Agent 可以先看目录、选择章节，再调用 `read_fragment`。
- `scan_full_item`：仅在跨章归纳、全书统计或证据不足时下载整个 Item 到工具侧扫描；受
  32 MiB 默认解码后内容预算限制，只返回统计和少量命中证据。实际 CDN 传输字节数在扫描
  结果的 `downloadedBytes` 中报告，通常小于保守的预计处理量。

部署只需设置 `JOJO_CONTENT_CDN_BASE`。不调用模型也可以验证真实目录、静态索引和 CDN
按章读取链路；需要指定一个支持 AI 的 Dataset：

```powershell
$env:JOJO_CONTENT_CDN_BASE="https://blacknews.jojokanbao.cn/"
$env:JOJO_CONTENT_DATASET_ID="mao-ze-dong-xuan-ji"
$env:JOJO_CONTENT_SMOKE_FULL_SCAN="true"
pnpm --filter @jojo/agent content:smoke -- "童年时代"
```

模型选书、内存静态检索和 B2/CDN 按章阅读的组合验证：

```powershell
pnpm --filter @jojo/agent rag:smoke -- "《毛泽东自述》的童年时代主要讲了什么？"
```
