# JOJO 时事离线新闻系统设计

状态：v2 实施基线，2026-08-23。

## 1. 目标与边界

时事系统是每十分钟运行的离线任务，不提供实时抓取 API。出版方访问、正文抓取、原始网页存档、
规范化和发布全部发生在 GitHub Actions；Web、Mobile 和 Agent 只读取 B2 CDN 或搜索索引。

系统只有三层数据：

1. **Raw**：出版方原始 RSS、API、HTML 和 WARC/WACZ，可重放、可重新解析。
2. **Canonical**：按媒体保存的规范文章，是翻译、搜索和 Delivery 的唯一输入。
3. **Delivery**：跨媒体聚合后的 JOJO 时事 Jox，仅供 CDN 消费。

Raw 与 Canonical 位于同一个 Hugging Face Dataset repo 的 `raw/`、`canonical/` 目录。B2 只保存
Delivery，不保存 WACZ、Canonical 或任务状态。

“实时”和“历史”不是两套数据：当前日期的 Delivery manifest 更新频繁，过去日期的同类 manifest
按需加载。前端从最新可用日期开始，并在用户继续滚动时逐日加载历史；系统不建立 `latest.jox`，也
不以七天窗口删除 Delivery。

## 2. 总体流程

```text
Capture workflow（每 10 分钟）
  │
  ├─ RSSHub npm package / 官方 RSS / 自有站点适配器
  ├─ canonical URL、稳定 article id、发布时间和来源分类
  ├─ 新文章与到期重试进入 Playwright Chromium + BPC
  ├─ 原始请求、响应和页面资源写入 WARC/WACZ
  └─ 单次原子 commit → HF raw/news/{source}/...

Process workflow（错开 5 分钟）
  │
  ├─ 读取尚未处理的 HF Raw commit
  ├─ 合并 route/feed 正文与浏览器正文回填
  ├─ 按媒体写入 HF canonical/news/{source}/...
  ├─ 从所有媒体 Canonical 构建按日期的时事版面
  └─ Canonical commit 成功后发布 B2 Delivery
       ├─ immutable article/asset Jox
       ├─ 日期 manifest
       ├─ index
       └─ 必要时最后更新 catalog
```

Capture 成功以 HF Raw commit 成功为准。Process 先提交 HF Canonical，再更新 B2；B2 发布失败时可
从 Canonical 重试，不重新访问出版方。

## 3. 来源模型

每家媒体配置三个互相独立的策略：

```json
{
  "id": "reuters",
  "name": "Reuters",
  "language": "en",
  "discovery": {
    "kind": "sitemap",
    "url": "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml",
    "maximumPages": 20
  },
  "content": { "priority": ["browser-parser", "discovery-summary"] },
  "archive": {
    "mode": "browser",
    "bpc": true,
    "proxyPolicy": "reuters"
  }
}
```

发现策略：

- `rsshub-package`：在任务进程内调用 RSSHub 的 `init()`、`request()`，不部署 RSSHub 服务。
- `official-rss`：直接读取出版方 RSS/Atom。
- `sitemap`：读取出版方官方 sitemap，只负责发现 URL 和更新时间。
- `official-rss-list`：合并同一媒体的多个官方分类 feed，例如 CNA。
- `site-adapter`：预留给没有稳定 feed 的媒体列表页或内容 API；当前 23 家没有启用。

正文策略按优先级执行：

- `discovery-body`：已经验证 route/feed 正文与原页一致。
- `browser-parser`：Chromium 捕获原页后，优先读取 JSON-LD `articleBody`，再按通用文章容器和段落
  质量门槛提取正文；需要来源特例时优先修复 RSSHub route，再增加锁定的来源适配器。
- `discovery-summary`：正文失败时保留摘要，但必须标记 `contentStatus=summary`。

浏览器抓取统一加载固定版本 BPC。BPC 解决页面内付费墙逻辑，不解决网络层 401/403；代理选择、
Chromium 和 BPC 版本都记录到脱敏 manifest。归档器直接生成标准 WARC 1.1、CDXJ 和 WACZ 1.2，
可供 ReplayWeb.page 等兼容读取器重放；当前实现不依赖 Browsertrix 服务。

RSSHub 配置和代理是进程级状态，所以每家来源在独立 Node worker 中运行。父进程限制并发；单个 worker
崩溃、超时或代理失败不影响其他媒体。

## 4. 媒体目录

生产目录当前启用 23 家：AP、The Guardian、Bloomberg、The New York Times、Reuters、Financial
Times、Axios、NPR、Nikkei Asia、联合早报、Al Jazeera、SCMP、新华网、人民网、央视新闻、
中国新闻网、澎湃新闻、财联社、CNA、Deutsche Welle、Focus Taiwan、Africanews 和 Agência Brasil。

同一 route 的文章逐篇做正文质量判定，不能因为少量长稿就把整家媒体标成“全文”。NPR、联合早报、
SCMP 和多家中国媒体已有稳定 route 正文；AP 等公开原页可由浏览器正文回填；Reuters、Bloomberg、
NYT、FT 等限制页仍会真实显示为摘要、metadata 或不可用案例，不会伪装成全文。

## 5. HF 单仓库存储契约

### 5.1 Raw：按媒体、日期和运行分目录

```text
raw/news/{source}/
└─ YYYY/MM/DD/RUN_ID/
   ├─ manifest.json
   ├─ discovery.json.gz
   ├─ candidates.jsonl.gz
   └─ network/
      ├─ exchanges.jsonl.gz
      └─ bodies/{sha256}.bin.gz

raw/news/runs/YYYY/MM/DD/RUN_ID.json
raw/web-archives/times/state.json.gz
raw/web-archives/times/YYYY/MM/DD/RUN_ID/
├─ run.json
└─ times-RUN_ID.wacz
```

`discovery.json.gz` 保存 RSSHub Data、官方 XML 的解析结果或 sitemap 输出；发现阶段的原始 HTTP
交换写入 `network/`，浏览器页面及其资源写入共享 WACZ。`candidates.jsonl.gz` 是统一文章候选清单。
`manifest.json` 记录对象 SHA-256、
媒体、抓取方式、版本、计数、错误和完成状态，但不记录 Cookie、Authorization、代理 URI、订阅地址
或其他凭据。

共享 `raw/web-archives/times/state.json.gz` 以 `sourceId + canonicalUrl` 生成的稳定 article id 维护抓取状态：成功页面按刷新策略
跳过，失败页面到期后换节点重试，直播文章按配置刷新。Raw response digest 未变化时不重复解析。

### 5.2 Canonical：按媒体和发布日期分片

```text
canonical/news/{source}/
├─ dataset.json
└─ articles/YYYY/MM/YYYY-MM-DD.jsonl.gz
```

一行是一篇 `jojo-news-article/1`：

```json
{
  "formatVersion": "jojo-news-article/1",
  "articleId": "reuters:...",
  "canonicalUrl": "https://www.reuters.com/...",
  "title": "...",
  "authors": [],
  "publishedAt": "2026-08-23T11:52:00Z",
  "language": "en",
  "publisherCategories": ["World"],
  "categories": ["world", "politics"],
  "body": {
    "format": "html",
    "profile": "jojo-semantic-html/1",
    "value": "<p>...</p>"
  },
  "contentStatus": "full",
  "contentHash": "sha256:...",
  "provenance": {
    "rawRevision": "HF commit SHA",
    "rawObject": "raw/web-archives/times/.../times-RUN_ID.wacz",
    "parserVersion": "reuters"
  }
}
```

同一媒体每天一个 gzip JSONL，避免每篇一个 HF 文件。文件在最新 commit 中保存当天文章的最新版本，
历史版本由 HF commit 历史保留。翻译、ES 和 Delivery 都按 article id/content hash 增量处理。

HF 顶层不建立聚合 `canonical/newspapers/times` 正文副本；跨媒体排序是 Delivery 构建行为，避免同一
正文以媒体 Canonical 和 Times Canonical 两份形式漂移。

## 6. B2 Delivery 契约

```text
catalog.jox
content/newspapers/times/
├─ index.jox
└─ items/YYYY/MM/YYYY-MM-DD/
   ├─ manifest.jox
   ├─ articles/{opaque-content-id}.jox
   └─ assets/{opaque-content-id}.jox
```

`index.jox` 只列出可用日期和 manifest 地址。前端取第一个可用日期，并在滚动时读取前一天；文章正文
只在用户打开文章时按需加载。当前日期 manifest 可被每十分钟更新，过去日期使用完全相同的格式。

Article/Asset Jox 以内容派生的不透明 ID 命名，设置一年 immutable 缓存。日期 manifest、index 和
catalog 是可变提交标记，设置短缓存并按以下顺序发布：

1. Article/Asset；
2. 日期 manifest；
3. index；
4. 仅在 Dataset 注册项变化时更新 catalog。

不存在 `latest.jox`、Raw B2、Canonical B2 或七天删除任务。

## 7. 实时与历史

存储层没有实时/历史分界。文章首次捕获时就进入 Raw archive，解析后永久进入媒体 Canonical。Delivery
中今天、昨天和多年前都使用日期 Item：

- 当前日期 manifest：前端定时重新验证或在页面重新聚焦时刷新；
- 前一日期：允许迟到文章和修订；
- 稳定历史日期：按滚动按需读取，正式更正时仍可发布新 article 对象并推进 manifest revision。

“实时”是前端默认从最新日期开始和刷新当前 manifest 的行为；“历史”是用户继续读取更早日期的行为。

## 8. 去重、版本和可恢复性

```text
articleId       = SHA-256(sourceId + canonicalUrl)
rawDigest       = SHA-256(主文档原始响应)
parseKey        = SHA-256(rawDigest + parserVersion)
contentHash     = SHA-256(规范标题、正文、发布时间)
deliveryObject  = opaque(contentHash)
```

URL 归一化去掉追踪参数和 fragment，跟随重定向并采用 `rel=canonical`/`og:url`，同时维护移动版、AMP
和聚合跳转别名。解析逻辑升级时可从 Raw/WACZ 重跑而无需重新访问媒体；Canonical 未变化时不重复翻译、
索引或发布。

单源失败不删除旧 Canonical 或 Delivery。任何可变 B2 指针只在其引用的不可变对象成功上传后更新；
任务不通过删除整个远端前缀恢复失败运行。

## 9. 工作流与凭据

- `maintenance-times-capture.yml`：每十分钟，single-flight，只需要 HF 写权限和媒体抓取代理配置。
- `maintenance-times-process.yml`：错开五分钟，读取同一 HF repo 的 Raw，提交 Canonical，再使用 B2 凭据发布 Delivery。
- RSSHub package、Chromium、BPC 和 Python/Node 依赖都锁定版本。
- 代理订阅只存在于 GitHub Secret；运行时由固定版本 Mihomo 写入临时配置，日志和上传产物不记录
  订阅 URL、节点名、Cookie、Authorization 或控制密钥。
- 捕获任务设置软预算，停止领取新浏览器页面后仍预留时间完成 WACZ 和 HF commit。

## 10. 后续扩展

翻译和 ES 只消费媒体 Canonical，不读取 Delivery，也不重新访问出版方。翻译结果记录原文 content hash、
语言、模型和提示词版本；ES 使用稳定 article id 幂等写入。两者失败都不能阻断原文 Capture、Canonical
或 B2 发布。
