# JOJO 时事离线新闻系统设计

状态：v4 Runtime Bucket 实施基线，2026-09-01。

## 1. 数据边界

系统只有三个在线数据层：

1. Runtime job：发现响应、原始 HTML、渲染 DOM、抓取元数据和原始图片，是 14/30 天热重试来源；
2. Runtime memory：Capture 去重记忆，以及 Process 最近八天的文章、译文缓存、日期索引和图片闭包；
3. B2 Delivery：按真实媒体发布的不可变正文/图片，以及供产品滚动读取的跨媒体日期索引。

Runtime 位于独立的私有 HF Storage Bucket。B2 不保存 Raw、处理记忆、代理状态或任务状态。旧 HF Dataset
退出实时写入，可独立作为历史归档；它不参与每十分钟流水线。

## 2. 执行流程

~~~text
每 10 分钟 Capture
  发现栏目 URL
    → 规范 URL / articleId 去重
    → 每个媒体选择 direct-first 或 browser-first
    → Playwright 控制锁定 Chromium/Brave + BPC（需要时切换代理节点）
    → 保存 original HTML、rendered DOM、正文图片
    → Runtime jobs/{id}/raw.tar
    → Runtime jobs/{id}/status.json（最后写入的 ready 标记）
    → 尽力更新 Capture memory（失败不丢已落盘 job）

Capture 成功后触发 Process/Publish
  status marker 重建 FIFO，选择最早 ready 或到期 partial job + 已提交 Process memory
    → 仅接受完整正文
    → 非中文完整 HTML blocks 并发翻译与结构校验（Gemma 31B，26B 降级，失败保留原文）
    → 单篇 Canonical Article + 媒体每日引用
    → Runtime jobs/{id}/processed-{sha256}.tar.gz（B2 前固化，重试直接重放）
    → B2 媒体 Article/Asset
    → 媒体每日/index
    → 全局 timeline 每日/index
    → process-memory.json 指向已提交 generation
    → job 标记为 done；单篇处理异常则标记 partial
~~~

Capture 和 Process 可独立重试。Raw job 完整落盘后即使 Capture memory 更新失败也可继续 Process；
Process 前半段失败时复用同一 `raw.tar`，B2 阶段失败时复用同一 `processed-{sha256}.tar.gz`，既不重新访问媒体，
也不重新生成译文。Process memory 指针和 job 完成状态只在 B2 catalog 成功提交并验证后推进。

## 3. 去重与并发

~~~text
articleId    = SHA-256(sourceId + normalized canonical URL)
fingerprint  = SHA-256(capture URL + title + publishedAt)
assetId      = SHA-256(image bytes)
contentHash  = SHA-256(title + publishedAt + canonical body + asset hashes + translations)
~~~

每个媒体的 state.json.gz 只决定 URL 是否已经成功抓取：成功页面在七天保留窗口内不重复抓，失败页面
两小时后重试，标题或发布时间变化立即重抓。该状态不是产品数据。不存在全局页面数量上限。

媒体之间最多八路并行；同一媒体始终串行并复用浏览器上下文、Cookie 和 BPC。代理轮换按全局回合进行，
避免多个并行媒体同时修改 Mihomo 路由。只有 browser-first 媒体且前一回合正文仍不完整的 URL 才进入
下一节点。失败文章轮流作为探针，每个节点只探测一篇，最多验证 12 个健康且分散的备用节点；命中后才补抓该媒体剩余文章。

## 4. 来源与页面抓取

每家媒体自己的目录包含 source.json、可选 discover.ts、fetch.ts、可选 availability.ts、可选 process.ts 和 index.ts。
共享层只提供 HTTP、RSS、sitemap、浏览器、代理、质量门槛、去重和存储原语。媒体 URL、selector 和
API 合约不得放入假定所有网站相同的通用适配器。

发现层默认轻量。没有分类能力的官方 feed 可以只提供 URL，不为文章伪造栏目。浏览器发现能力保留在
契约中，但当前只有媒体明确需要时才允许启用。

direct-first 只有在主文档为 HTML 且正文质量通过时才停止；否则进入浏览器。browser-first 不执行
已知无意义的直连。浏览器默认开启 JavaScript，使用持久上下文加载锁定 BPC。所有浏览器都由
Playwright 控制；NYT 使用锁定 Brave，其他来源默认使用与 Playwright 配套的锁定 Chromium。NYT 的
BPC 请求若被站点拒绝，会在同一节点以新的原生 Brave profile 重试。流水线不生成 WARC/WACZ。

主文档保存两份：

- original.html.gz：直连或浏览器主响应体；
- rendered.html.gz：JavaScript/BPC 完成后的 DOM。

403、challenge、登录提示只是抓取信号，不是硬付费墙证据；多节点仍无完整正文时记录失败。视频和图集
跳过，摘要和 metadata 不进入 Canonical/Delivery。

## 5. 图片

图片从 og:image、img/src、data-src、srcset 和正文 figure 中发现。Logo、头像、广告、推荐图、小于
等于 80px 的图和追踪像素会被排除。下载后的图片以字节哈希存储；Canonical 正文只使用
figure[data-asset-id]，不依赖出版方外链。图片失败会写入抓取记录，但不会删除已经取得的完整文字正文。

## 6. Runtime Bucket 契约

~~~text
times/capture-memory.tar.gz
times/process-memory.json
times/pending-jobs.json
times/jobs/{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}/raw.tar
times/jobs/{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}/processed-{sha256}.tar.gz
times/jobs/{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}/status.json
~~~

`raw.tar` 是不可变 job payload；`status.json` 保存 archive/member 的 size 与 SHA-256，并作为 marker-last
完成标记。状态为 `ready | partial | done`。Process 下载后逐成员校验，任何缺失或损坏都 fail closed。
`pending-jobs.json` 是可重建的 FIFO 索引，`status.json` marker 才是任务权威；queue 丢失、损坏或 marker
与 enqueue 之间中断时，selector 会扫描 marker 并重建。partial job 按指数退避重试。
Capture memory 只保存各媒体 `state.json.gz`。每份 `processed-{sha256}.tar.gz` 保存保留窗口内的 Canonical 日期索引、
被引用 article、翻译缓存、被引用 Raw asset 和本轮 Process result；`process-memory.json` 只是当前已完成
generation 的小指针。首次空状态必须通过人工审核的显式 bootstrap，发布任务不得静默从空 memory 开始。

`done` job 在 14 天后清理；`ready/partial` job 在 30 天后进入 dead-letter 清理并告警。清理只接受精确
allowlist 路径，默认 dry-run、显式 apply，一次最多删除 100 个 job。Bucket 不依赖 Git commit、revision
或目录级递归删除。上传中断产生且没有 status marker 的 payload 在 30 天后清理，但当前 Process memory
指针引用的 generation 永远受到保护；payload 删除成功后才删除 status marker。

## 7. B2 契约与提交顺序

~~~text
content/newspapers/{source}/articles/{hash}.jox
content/newspapers/{source}/assets/{hash}.jox
content/newspapers/{source}/dates/YYYY/MM/YYYY-MM-DD.jox
content/newspapers/{source}/index.jox
content/timeline/dates/YYYY/MM/YYYY-MM-DD.jox
content/timeline/index.jox
catalog.jox
~~~

发布顺序保证指针不引用未上传对象：

1. Asset、原文 Article 和译文 Article（长期 immutable）；
2. 媒体日期、媒体 index（短缓存）；
3. timeline 日期、timeline index（短缓存）；
4. catalog（短缓存）。

没有 content/newspapers/times、latest.jox、B2 Raw 或 B2 Canonical。前端读取 timeline index 的第一天，
到达列表底部后继续读取下一天；打开文章时才读取正文与图片。

Timeline 文章保留原文 `articleObject`，并在 `translations.zh-CN.articleObject` 指向中文 fragment；列表所需的
中文标题和摘要随翻译引用一起保存。中文客户端优先读取译文，译文对象不可用时回退原文。

## 8. 后续能力

实体抽取和 Elasticsearch 只消费 Canonical Article，以 articleId、contentHash 和处理器版本幂等执行。
Gemma 翻译在 Process 内以受控并发执行并使用独立内容缓存；翻译服务失败不能阻断原文 Canonical 或 Delivery。
