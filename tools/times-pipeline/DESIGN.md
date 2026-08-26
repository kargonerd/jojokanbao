# JOJO 时事离线新闻系统设计

状态：v3 实施基线，2026-08-26。

## 1. 数据边界

系统只有三个数据层：

1. HF Raw：发现响应、原始 HTML、渲染 DOM、抓取元数据和原始图片，是可重新解析的权威来源；
2. HF Canonical：按真实媒体保存的单篇规范文章和每日引用索引，是翻译与搜索的输入；
3. B2 Delivery：按真实媒体发布的不可变正文/图片，以及供产品滚动读取的跨媒体日期索引。

Raw 与 Canonical 位于同一个 HF repo。B2 不保存 Raw、Canonical、代理状态或任务状态。实时与历史没有
存储分界：今天和多年前使用同一日期格式，前端只是默认先加载最新日期。

## 2. 执行流程

~~~text
每 10 分钟 Capture
  发现栏目 URL
    → 规范 URL / articleId 去重
    → 每个媒体选择 direct-first 或 browser-first
    → Playwright 控制锁定 Chromium/Brave + BPC（需要时切换代理节点）
    → 保存 original HTML、rendered DOM、正文图片
    → HF Raw commit

Capture 成功后触发 Process/Publish
  最新完整 Raw commit
    → 仅接受完整正文
    → 单篇 Canonical Article + 媒体每日引用
    → HF Canonical commit
    → B2 媒体 Article/Asset
    → 媒体每日/index
    → 全局 timeline 每日/index
~~~

Capture 和 Process 可独立重试。B2 失败时从 Canonical 重发，不重新访问媒体。

## 3. 去重与并发

~~~text
articleId    = SHA-256(sourceId + normalized canonical URL)
fingerprint  = SHA-256(capture URL + title + publishedAt)
assetId      = SHA-256(image bytes)
contentHash  = SHA-256(title + publishedAt + canonical body + asset hashes)
~~~

每个媒体的 state.json.gz 只决定 URL 是否已经成功抓取：成功页面在七天保留窗口内不重复抓，失败页面
两小时后重试，标题或发布时间变化立即重抓。该状态不是产品数据。不存在全局页面数量上限。

媒体之间最多八路并行；同一媒体始终串行并复用浏览器上下文、Cookie 和 BPC。代理轮换按全局回合进行，
避免多个并行媒体同时修改 Mihomo 路由。只有 browser-first 媒体且前一回合正文仍不完整的 URL 才进入
下一节点。每个节点只探测一篇，最多验证 32 个健康且分散的备用节点；命中后才补抓该媒体剩余文章。

## 4. 来源与页面抓取

每家媒体自己的目录包含 source.json、可选 discover.ts、fetch.ts、可选 process.ts 和 index.ts。
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

## 6. HF 契约

~~~text
raw/{source}/state.json.gz
raw/{source}/assets/{sha256}.{ext}
raw/{source}/runs/YYYY/MM/DD/{RUN_ID}/...
raw/runs/YYYY/MM/DD/{RUN_ID}.json

canonical/{source}/dataset.json
canonical/{source}/articles/{contentHash}.json.gz
canonical/{source}/dates/YYYY/MM/YYYY-MM-DD.json.gz
canonical/runs/{RUN_ID}.json
~~~

Source run 保存本轮发现和抓取证据；单篇 Canonical Article 是不可变内容对象；每日 Canonical 只引用
文章，不复制正文。历史修订由新的 content hash 和 HF commit 历史保留。

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

1. Asset、Article（长期 immutable）；
2. 媒体日期、媒体 index（短缓存）；
3. timeline 日期、timeline index（短缓存）；
4. catalog（短缓存）。

没有 content/newspapers/times、latest.jox、B2 Raw 或 B2 Canonical。前端读取 timeline index 的第一天，
到达列表底部后继续读取下一天；打开文章时才读取正文与图片。

## 8. 后续能力

翻译、实体抽取和 Elasticsearch 只消费 Canonical Article，以 articleId、contentHash 和处理器版本幂等
执行。它们的失败不能阻断原文 Capture、Canonical 或 Delivery。
