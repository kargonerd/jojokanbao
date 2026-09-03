# JOJO Times offline pipeline

JOJO Times 是每十分钟运行的离线新闻流水线。出版方访问发生在 GitHub Actions；Web、Mobile、Agent
只读取 B2 CDN，不通过用户请求触发抓取。完整存储契约见 [DESIGN.md](DESIGN.md)。

## 覆盖范围

sources.v2.json 启用 22 家媒体和 153 个已选栏目：AP、The Guardian、Bloomberg、The New York
Times、Reuters、Financial Times、Axios、NPR、Nikkei Asia、联合早报、Al Jazeera、SCMP、新华网、
人民网、中国新闻网、澎湃新闻、财联社、CNA、Deutsche Welle、Focus Taiwan、Africanews、Agência
Brasil。央视新闻、财新、WSJ、第一财经、Indian Express 和证券时报不在生产目录。

每家媒体位于 src/sources/{source}/：

- source.json：栏目、发现入口、正文门槛、页面抓取策略；
- discover.ts：仅在出版方需要自有 API/栏目协议时存在；
- fetch.ts：正文容器和页面抓取策略；
- images.ts：必需；按该媒体的结构化数据和正文 DOM 提取图片并排除站点装饰；
- availability.ts：仅在媒体有视频、图集或明确硬付费墙规则时存在；
- process.ts：仅在 Canonical 前需要来源修正时存在；
- index.ts：来源模块装配。

每个 `source.json` 还必须声明 `publicationTimeZone`（IANA 时区）。Epoch 和带 `Z/±offset` 的时间直接归一化；
不带时区的发布时间按该媒体声明的时区解释。新华网、人民网、中国新闻网和联合早报的 HTML 使用
`wall-clock` 模式，以纠正源站把本地墙上时间错误标作 UTC 的情况。发现窗口同时检查起点和终点，默认只
允许最多 120 秒的出版方时钟偏差，超出窗口的条目留在 Raw 审计计数中但不进入正文抓取。

发现默认使用官方 RSS、sitemap 或出版方轻量 API，不逐篇启动浏览器。正文阶段处理所有尚未成功抓取
的新 URL，没有全局抽样或 50 篇上限：

- direct-first：普通 HTML 能稳定给出全文的媒体先直连，正文不足再启动浏览器；
- browser-first：Bloomberg、NYT、Reuters、FT、Axios、Nikkei、联合早报和 SCMP 直接进入浏览器；
- 所有浏览器都由 Playwright 持久上下文控制，启用 JavaScript 和锁定版本 BPC；NYT 由 Playwright 直接控制锁定 Brave，其余媒体使用锁定 Playwright Chromium；
- NYT 的 BPC 请求若被 401/403/429 拒绝，会在同一节点用新的 Playwright Brave 原生 profile 重试，避免 BPC 的站点 UA 规则本身触发拦截；
- 同一媒体串行复用 Cookie，不同媒体默认最多八路并行；
- 401/403/429、JS challenge 或正文不完整不会被判成硬付费墙；需要代理的媒体在失败文章之间轮换探针，每个备用节点只探测一篇，最多验证 12 个分散的 Mihomo 节点，命中后才补抓该媒体剩余文章；
- 无正文的视频在发现阶段跳过；完整文字新闻和由出版方图片构成的图文报道进入 Canonical/Delivery，摘要只留在 Raw 审计数据。

## 本地运行

~~~powershell
pnpm install
pnpm --filter @jojo/times-pipeline exec playwright install chromium
pnpm --filter @jojo/times-pipeline build

Expand-Archive tools/times-pipeline/vendor/bpc/bypass-paywalls-chrome-clean.zip -DestinationPath $env:TEMP/bpc
$env:JOJO_TIMES_BRAVE_PATH = '<本机 Brave 可执行文件路径>'

node tools/times-pipeline/dist/src/capture-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --since-hours 24 --workers 8
node tools/times-pipeline/dist/src/page-capture-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --run-manifest '<runManifest>' --source-workers 8 --browser-extension-path $env:TEMP/bpc/bypass-paywalls-chrome-clean-master
node tools/times-pipeline/dist/src/process-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --run-manifest '<runManifest>' --raw-revision local
node tools/times-pipeline/dist/src/delivery-cli.js --config tools/times-pipeline/sources.v2.json --output $env:TEMP/jojo-times --process-result '<process-result.json>' --delivery-output $env:TEMP/jojo-times-delivery
~~~

自动轮次使用 3 小时发现回看，但只把最近 1 小时以及状态缓存中从未见过或仍需重试的 URL 送入页面抓取和
Canonical 处理。这样可以补到媒体延迟加入栏目页的文章，又不会每十分钟重复处理整天数据。

## 非中文新闻翻译

Process 在 `GEMINI_API_KEYS` 或 `GEMINI_API_KEY` 存在时自动翻译本轮新增的非中文全文；没有密钥的本地 dry run 保持原有行为，也可用
`--translate true|false` 显式控制。生产策略为：

- `gemma-4-31b-it` 主翻译，单个失败 chunk 自动降级到 `gemma-4-26b-a4b-it`；若两个 Gemma 都破坏受保护 HTML，再由 `gemini-3.5-flash` 救援一次；
- 标题和正文以原始完整 HTML blocks 输入，不拆 text node、不添加 ID、不要求 JSON；仅在约 20,000 源字符处按 block 边界分 chunk；
- 本地校验 block 顺序、链接及全部 HTML 属性后再回填译文；纯 `b/em/i/strong` 强调差异不阻断文章，模型新增的无属性强调标签会被移除；
- 默认八路 worker；每个 API 项目、每个模型独立按 28 RPM / 14K TPM 保守限流，Gemini 救援模型额外限制为每项目 5 RPM；请求在项目池中轮询并发，单个项目返回 429 或临时 5xx 时自动尝试下一个项目；
- 单请求默认最多等待 240 秒，整批最多占用 24 分钟；到达预算会中止在途翻译并将未完成文章留给下轮立即重试，不写失败退避缓存，给 30 分钟工作流保留 Process/Delivery 时间；
- 译文按源标题、正文、语言和翻译策略的 hash 缓存。刷新到同一内容时从 Runtime Process memory 恢复缓存，不重复请求 API；
- 三个模型都不可用时 fail-open 发布原文，并在 Process report 和 Actions Summary 中列出失败，不阻断新闻发布；
- Delivery 同时保存原文和 `zh-CN` fragment。中文 Web 默认读取译文对象，译文对象缺失或损坏时回退原文。

可选调优变量：`JOJO_TIMES_TRANSLATION_WORKERS`、`JOJO_TIMES_TRANSLATION_MODEL`、
`JOJO_TIMES_TRANSLATION_FALLBACK_MODEL`、`JOJO_TIMES_TRANSLATION_RESCUE_MODEL`、`JOJO_TIMES_TRANSLATION_REQUEST_TIMEOUT_MS` 和
`JOJO_TIMES_TRANSLATION_BATCH_TIMEOUT_MS`、`JOJO_TIMES_TRANSLATION_CHUNK_CHARACTERS`。

本地可继续使用单项目变量，也可增加任意数量的数字后缀；CLI 会按数字顺序去重并组成项目池：

~~~dotenv
GEMINI_API_KEY=project-one-key
GEMINI_API_KEY_2=project-two-key
GEMINI_API_KEY_3=project-three-key
~~~

使用 `.env.local` 时通过 Node 显式加载：

~~~powershell
node --env-file=.env.local tools/times-pipeline/dist/src/process-cli.js `
  --config tools/times-pipeline/sources.v2.json `
  --output $env:TEMP/jojo-times `
  --run-manifest '<runManifest>' `
  --raw-revision local
~~~

也可以设置逗号、分号或空白分隔的 `GEMINI_API_KEYS`，它会作为显式有序池并覆盖单个/数字后缀变量。GitHub
`maintenance` environment 推荐配置一个 `GEMINI_API_KEYS` Secret，例如 `key-one,key-two,key-three`；旧的
`GEMINI_API_KEY` Secret 保持兼容。发布轮次会在两者都缺失时提前失败，避免悄悄发布未翻译内容。

## 存储

实时流水线使用一个私有 HF Storage Bucket。Bucket 目录按用途命名，不暴露 Dataset revision、
checkpoint 或 canonical snapshot 等内部术语：

~~~text
times/
├─ capture-memory.tar.gz
├─ process-memory.json
├─ pending/{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}.json
├─ pending-jobs.json                         # 只读的旧队列迁移输入
└─ jobs/{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}/
   ├─ raw.tar
   ├─ processed-{sha256}.tar.gz
   └─ status.json
~~~

`raw.tar` 保存该轮完整 Raw：发现响应、页面、图片和新的来源状态。`status.json` 是最后上传的完成标记，
并记录归档及每个成员的大小和 SHA-256；Process 下载后必须逐项验证。job id 使用
`GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT`，因此 Actions 重跑不会覆盖已有 Raw。Raw 和 marker 落盘后会尽力更新
`capture-memory`；即使该记忆更新失败，已进入队列的 Raw 仍可处理，只是下一轮可能重复抓取少量文章。

`processed-{sha256}.tar.gz` 是在发布 B2 前固化的不可变 Process 结果。完整 generation 包含最近八天处理闭包和
本轮 `process-result.json`；后续 generation 默认只保存相对稳定基线的累计差量，并在 12 轮或差量超过完整状态
60% 时自动压成新基线。恢复最多读取基线和差量两个归档。B2 失败或 runner 中断时，下一轮直接重放已固化结果，
不再次调用翻译或解析。
B2 全部提交并验证后，`process-memory.json` 才指向这个 generation；随后才推进 job 状态。首次没有
Process memory 时发布会 fail closed，只允许人工指定 job 的一次 `bootstrap=true` 初始化，不能静默冷启动。
单篇处理异常会把 job 标为 `partial` 并保留待重试文章。每个未完成 job 使用独立的 `pending/{id}.json`
标记，不再让 Capture 与 Process 并发改写同一份队列文件；旧 `pending-jobs.json` 只在迁移期读取。
`status.json` 仍是权威来源，近期 marker 上传中断会从 status 自动修复。Process 每轮最多合并四个 FIFO job，
只执行一次 Canonical、翻译和 B2 Delivery；若仍有可处理积压，会自动触发下一轮直到排空。抓取失败则由
Capture memory 中的短退避状态在新 job 中重新抓取。

Runtime job 状态只有 `ready`、`partial` 和 `done`。`done` job 保留 14 天；未完成 job 保留 30 天并在
清理报告中告警。每日 cleanup 默认 dry-run，自动 schedule 显式使用 apply，并且只允许删除
`times/jobs/{id}` 下经过校验的 Raw、未提交 Process generation、pending marker 和 status marker；payload 始终先于 marker
分阶段删除。没有 status 的上传中断残留保留 30 天，当前 `process-memory.json` 指向的 generation 永不作为
孤儿删除；差量 generation 引用的基线也受到同样保护。一次最多处理 100 个 job。

B2 只保存 Delivery：

~~~text
catalog.jox
content/newspapers/{source}/
├─ index.jox
├─ articles/{content-hash}.jox
├─ assets/{content-hash}.jox
└─ dates/YYYY/MM/YYYY-MM-DD.jox

content/timeline/
├─ index.jox
└─ dates/YYYY/MM/
   ├─ YYYY-MM-DD.jox
   └─ YYYY-MM-DD/page-NNNN.jox
~~~

content/timeline 是跨媒体排序索引，不是虚拟媒体。不存在 content/newspapers/times 或 latest.jox。
时间线分页对象每页最多 50 篇，Web 只挂载当前页；完整日期对象保留给文章直达和旧客户端兼容。
文章和图片内容寻址并长期 immutable；当天日期对象、分页对象和 index 使用 60 秒重新验证。
Delivery 构建会合并旧 index，所以滚动历史不会在下一轮消失。不存在 `latest.jox`。
各新闻媒体的 Dataset index 与 catalog 条目固定写入 `aiEnabled: false`；它们可以继续在
资料库和时事页面展示，但不会进入馆藏 AI 的检索范围。

## GitHub Actions

- maintenance-times-capture.yml：每十分钟完成发现、URL 去重、页面/图片抓取，上传一个 Runtime job，
  最后更新 Capture memory；
- maintenance-times-process.yml：从 status marker 重建 FIFO，读取最早可运行 job 和已提交 Process memory，随后按
  Asset/Article → 媒体日期 → 媒体 index → 时间线日期 → 时间线 index → catalog 发布 B2；B2 成功后
  才推进 Process memory 指针和 job 状态；
- maintenance-times-runtime-cleanup.yml：每日按 14/30 天保留规则清理已完成和 dead-letter job。

手动运行默认 publish=false，只产生短期 artifact。代理订阅只从 Secret 读取；订阅 URL、节点名、
Cookie、Authorization 和 BPC 内部状态不会进入 Raw、日志或 artifact。

验证：

~~~powershell
pnpm --filter @jojo/times-pipeline typecheck
pnpm --filter @jojo/times-pipeline test
pnpm --filter @jojo/times-pipeline build
~~~
