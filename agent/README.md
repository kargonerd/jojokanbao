# @jojo/agent

JOJO 看报的通用 Pi Agent 运行层，支持 Codex OAuth 和 Antigravity OAuth。

```text
pi-ai
└── Codex OAuth、模型目录、消息转换和流式请求

pi-agent-core / Agent
└── 消息状态、Agent Loop、工具执行、事件和取消

@jojo/agent
└── JOJO 事件格式、预算、token/cost、Provider 切换和 Antigravity 适配

applications.ts / rag-tools.ts
└── RAG 提示词，以及搜索、读片段、按需扫描整本三个工具
```

这里使用 `pi-agent-core` 的高层 `Agent`，不使用 `pi-coding-agent`，也不自行
实现模型与工具之间的循环。当前 Pi 0.84.4 已无内置 Antigravity；`src/antigravity`
通过 `pi-antigravity` 包适配 OAuth、模型目录及 Cloud Code Assist SSE。
其他模型后续统一通过 Makers Models 接入。

## Provider 切换

`JOJO_AGENT_PROVIDER` 支持 `openai-codex`（默认）和 `antigravity`。
`JOJO_AGENT_MODEL` 留空时分别使用 `gpt-5.6-luna` 和 `gemini-3.5-flash-lite`。
切换 provider 时清空旧的 model 覆盖，或指定该 provider 的模型；错误组合会直接报错。
本地 `pnpm dev:agent` 从仓库根目录 `.env`、`.env.local` 读取配置，进程环境变量优先级最高；
修改后重启服务。部署端在国际 Agent 的 EdgeOne Makers 项目环境变量中修改，再重新部署。
管理台的 provider 下拉框只决定上传哪套凭据，不切换运行模型。

```dotenv
JOJO_AGENT_PROVIDER=antigravity
JOJO_AGENT_MODEL=gemini-3.5-flash-lite
```

`smoke`、`rag:smoke` 等 CLI 验证命令读取当前终端环境变量，不自动加载根目录 `.env.local`。

```powershell
pnpm --filter @jojo/agent auth:antigravity
pnpm --filter @jojo/agent verify:antigravity
$env:JOJO_AGENT_PROVIDER="antigravity"
$env:JOJO_AGENT_MODEL=""
pnpm --filter @jojo/agent smoke -- "用一句话介绍你自己"

# 切回 Codex
$env:JOJO_AGENT_PROVIDER="openai-codex"
$env:JOJO_AGENT_MODEL=""
```

Antigravity 登录命令输出 Google 授权网址，在本机浏览器打开后自动接收回调
（`127.0.0.1:51121`），校验 OAuth state/PKCE 并发现账号项目，再把凭据与 `projectId`
写入 `agent/auth.json`（支持现有 `JOJO_AGENT_AUTH_PATH` / `JOJO_CODEX_AUTH_PATH`）。
账号需已在 Antigravity 完成启用；项目发现和回退规则由上游包处理。
同一文件可以同时保留两套凭据。登录入口只在本地 CLI 使用，不打包进部署产物。
登录监听等待 15 分钟，期间需保持命令运行。若回跳 `localhost:51121` 显示拒绝连接，
先检查命令是否已退出；超时后重新运行 `auth:antigravity` 并使用新链接，旧链接无法续用。

接入固定版本 [pi-antigravity 0.7.2](https://pi.dev/packages/pi-antigravity)，复用其 OAuth、
模型发现和流式工具协议。默认模型为 `gemini-3.5-flash-lite`，也可配置 `gemini-3.1-pro`、`claude-sonnet-4-6`、
`claude-opus-4-6` 等；实际权限、模型和配额取决于账号。成本是包提供的模型估算，不是订阅账单。
已知模型直接请求；配置目录中尚无的模型时，会先执行认证后的模型发现。

Pi 在每次请求前检查有效期；过期时刷新并回写凭据。Google 未返回新的 refresh token 时保留
原值，刷新失败也不会删除已有凭据。撤销授权或账号受限仍需人工处理。该包是社区非官方集成。

`agent/patches/pi-antigravity@0.7.2.patch` 适配核心模型类型、严格 TypeScript 检查和
刷新取消信号，并延迟加载本地 HTTP 登录监听器。登录补丁延长等待时间、忽略旧回调，并为
令牌兑换增加超时与阶段提示。3.1 / 3.5 Flash-Lite 的输出上限设为已验证的 65,535，避免服务端拒绝 65,536。
核心模块不依赖 `pi-coding-agent`；
根包和生成的部署包均将该可选 peer 排除。升级包时需同步复核补丁和内部导入路径。

上传指定 provider（不改变运行时 provider）：

```powershell
pnpm --filter @jojo/agent credentials:push -- antigravity
pnpm --filter @jojo/agent credentials:push -- openai-codex
```

不传参数时按 `JOJO_AGENT_PROVIDER` 选择。部署端先刷新并校验上传的 OAuth，再写入
现有加密 Store。两家 provider 使用独立命名空间，Codex 继续读取原有存储地址，
避免相互刷新时覆盖凭据。管理台 `/agent` 也可选择上传的 provider。

## 本地登录与验证

```powershell
pnpm --filter @jojo/agent auth:codex
pnpm --filter @jojo/agent smoke -- "用一句话介绍你自己"
```

Pi 会打开浏览器完成 ChatGPT 登录，并把凭证写入被 Git 忽略的
`agent/auth.json`。也可以用 `JOJO_AGENT_AUTH_PATH` 指向一份由 Agent 独占、可回写的 Pi
兼容凭证文件；不要指向 Codex 应用自身的 `~/.codex/auth.json`。

向已部署项目上传凭据时，`credentials:push` 不是简单复制
`agent/auth.json`：部署端会先刷新一次 OAuth 凭据，再把新生成的 rotating refresh
token 写入加密 Store，从而把该 token 的所有权转移给部署端。上传成功后，本地文件中的
refresh token 已被消费；如果还要在本地继续运行 Agent，必须再次执行
`pnpm --filter @jojo/agent auth:codex`，为本地建立一份独立登录。不要把这次本地登录再次
上传，除非确实要替换部署端凭据。

如果出现 `refresh_token_reused`，不要重试旧凭据。先重新登录，再重新上传：

```powershell
pnpm --filter @jojo/agent auth:codex
pnpm --filter @jojo/agent credentials:push
```

上传后若仍需本地运行，再单独执行一次 `auth:codex`。

Codex 默认使用 `gpt-5.6-luna`，推理强度固定为 `low`。模型可以覆盖：

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

请求通过 `scope.contentType` 选择 `book`（默认，兼容已有请求）或 `periodical`。
Web 和原生移动端 AI 页面可切换书籍与报刊，历史对话保存该选择。报刊目前只开放《人民日报》
（`datasetIds: ["rmrb"]`），由 `JOJO_AI_PERIODICAL_IDS` 维护；不依赖书籍目录的 AI 标记。
两种范围提供各自的工具，报刊不下载书籍索引或报纸的整期 Manifest。

- `search_periodicals`：调用现有 Reader Search 的 `POST /content/search` ES 接口，
  固定限定已开放报刊与 `newspaper` 类型，支持日期范围、时间排序和分页，每次最多 8 篇。
- `read_periodical_article`：按需读取本轮搜索命中的文章正文，默认每次 6000 字，
  上限 12000 字，长文章按 `nextOffset` 继续读取。引用保留文章标识、日期及版次，
  Web 跳转至对应 Archive 页面并定位文章标题。

报刊复用 `@jojo/content` 的 `CONTENT_SEARCH_API`，无需在 Agent 中配置 ES 账号或新增服务。
搜索服务失败会返回工具错误，不回退到书籍检索。

书籍继续使用以下工具：

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
