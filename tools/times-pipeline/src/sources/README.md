# Source modules

每个出版方拥有一个目录，边界以真实媒体为单位：

~~~text
{source}/
├─ source.json  # 栏目、发现入口、正文门槛、direct/browser 策略
├─ discover.ts  # 可选：出版方 API/栏目协议 → Candidate
├─ fetch.ts     # 页面 URL 与正文 selector
├─ availability.ts # 可选：视频、图集、明确硬付费墙等来源规则
├─ process.ts   # 可选：来源专属正文解析与 Canonical 前修正
└─ index.ts     # 模块装配
~~~

共享层只提供 HTTP、RSS/XML、sitemap、浏览器、代理、去重、质量门槛和存储原语。出版方 URL、selector、
API 合约和过滤规则不得放入一个假定所有网站相同的通用 site adapter。

发现层默认轻量且不逐篇抓正文；接口保留 browser discovery 能力，但只有媒体自身明确需要时才能启用。
页面层处理发现到的每个待抓 URL。fetch.ts 和 availability.ts 只描述该媒体，不能引用另一个媒体目录。

process.ts 不负责联网。视频和图集应尽量在 discover.ts 或 accept 中排除；摘要、metadata 和抓取失败
可以进入 Raw 审计，但不能伪装成全文进入 Canonical 或 Delivery。

## Pipeline stage boundaries

~~~text
discovery/  媒体入口 → Candidate 和 URL，不抓逐篇正文
capture/    URL → 原始/渲染 HTML、页面 metadata、图片对象和抓取状态
content/    纯 HTML 正文识别原语；Capture 只用它做质量探测
process/    读取 Raw rendered HTML → 正文、资源引用和 Canonical
delivery-* Canonical → B2/CDN 使用的时间线与各媒体对象
~~~

Raw Candidate 不保存解析后的正文。`process/article.ts` 必须从 `rawPageObject` 读取存档后再解析，保证解析器
升级时可以离线重跑；`page-capture-cli.ts` 和 `process-cli.ts` 只负责各自阶段的编排。

## 正文完整性证据

来源专属 `extractBody` 可以返回旧版 HTML string，也可以返回结构化结果：

~~~ts
{
  html: "<p>...</p>",
  completeness: "publisher-complete" | "unknown" | "truncated",
  evidence: { kind: "terminal-marker", marker: "Enditem", location: ".author p" },
}
~~~

- `publisher-complete`：只有来源专属提取器可以声明，并且必须提供可复核的出版方证据，例如正文数据协议的
  明确结束状态或正文容器内的终止标记。HTTP 200、selector 命中、字符数以及页面底部没有更多节点都不构成
  完整性证据。共享层仍会执行 20 字、1 个内容块的卫生底线。
- `unknown`：没有确定的完整性证据。结构化 `unknown`、来源 selector、JSON-LD 和通用 selector 都必须通过
  `source.json` 中的正文质量门槛，且不能升级为 `publisher-complete`。
- `truncated`：来源协议已经确认正文不完整。该结果是 terminal rejection；Capture 不得再用 discovery body 或
  通用 selector 覆盖它。

旧版 string 返回值继续兼容，Raw 诊断会将其标记为 `publisher-extractor-legacy` 和 `unknown`。新增短文例外不得
依赖这个兼容路径，必须迁移为结构化证据。共享的 20/1 只是最终卫生底线；媒体若已有更严格的短讯定义，必须
在来源提取器内先验证该约束，再声明 `publisher-complete`。

修改 selector、证据规则、来源正文门槛或任何会改变 Capture 正文判定的提取逻辑时，必须同步提升该来源
`fetch.ts` 的 `revision`，确保 page-capture state 会重新抓取旧候选。正文 assessment 只写入 Raw candidate、
page metadata 和采集失败报告，不进入 Canonical 或 Delivery。
