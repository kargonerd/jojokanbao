# Source modules

每个出版方拥有一个目录，边界以真实媒体为单位：

~~~text
{source}/
├─ source.json  # 栏目、发现入口、正文门槛、direct/browser 策略
├─ discover.ts  # 可选：出版方 API/栏目协议 → Candidate
├─ fetch.ts     # 页面 URL、正文 selector、来源抓取特例
├─ process.ts   # 可选：Canonical 前的来源修正
└─ index.ts     # 模块装配
~~~

共享层只提供 HTTP、RSS/XML、sitemap、浏览器、代理、去重、质量门槛和存储原语。出版方 URL、selector、
API 合约和过滤规则不得放入一个假定所有网站相同的通用 site adapter。

发现层默认轻量且不逐篇抓正文；接口保留 browser discovery 能力，但只有媒体自身明确需要时才能启用。
页面层处理发现到的每个待抓 URL。fetch.ts 只描述该媒体，不能引用另一个媒体目录。

process.ts 不负责联网。视频和图集应尽量在 discover.ts 或 accept 中排除；摘要、metadata 和抓取失败
可以进入 Raw 审计，但不能伪装成全文进入 Canonical 或 Delivery。
