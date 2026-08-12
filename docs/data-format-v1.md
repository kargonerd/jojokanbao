# JOJO 统一数据与交付格式 v1

> 状态：待合并。书籍导入器已实现；报纸和杂志按照本文约定接入。

JOJO 用同一套外壳保存书籍、报纸和杂志，但明确区分三类数据：

- Raw：不可替代的来源原文件。
- Canonical：清晰、规范、可以重建一切派生数据的唯一真值。
- Delivery：供 Reader 和 Agent 从 CDN 读取的拆分、压缩、Jox 混淆对象。

Elasticsearch、Hugging Face 和 EPUB 都是派生数据，不是真值。格式不包含 `rights`；将来确有权限管理需求时再单独升级版本。

## 1. 两个 B2 Bucket

### 1.1 `jojo-news-raw`

这是私有 Bucket，导入器、重建任务和管理员使用。Reader 与 Agent 不读取它。

```text
jojo-news-raw/
├─ raw/
│  ├─ weread/
│  │  ├─ 毛泽东自述--3300033212.json
│  │  └─ 毛泽东选集--3300025438.json
│  ├─ epub/
│  │  └─ 毛泽东自述--source-id.epub
│  ├─ kindle/
│  │  └─ 毛泽东选集（1-5卷）--DXCND7B72....azw
│  ├─ newspapers/
│  │  └─ rmrb/1990/09/1990-09-06/
│  │     ├─ source.json
│  │     ├─ original.pdf
│  │     └─ images/page-01.jpg
│  └─ magazines/
│     └─ qiushi/2026/15/
│        ├─ source.json
│        └─ original.pdf
└─ canonical/
   ├─ books/
   ├─ newspapers/
   └─ magazines/
```

Raw 书籍采用 `书名--来源ID.扩展名`，直接平铺在来源目录。来源 ID 防止同名文件覆盖。Raw 不生成 `catalog.json` 或 `index.json`；私有重建任务使用 B2/S3 `ListObjects` 枚举来源文件。

报纸和杂志数量较多，Raw 按来源、年份、月份、日期或期号分片。

Canonical 不保存根 `catalog.json`，也不保存 `search/` 副本。重建任务通过 `canonical/**/dataset.json` 发现 Dataset，并从 Canonical Item 临时生成 ES 文档。

### 1.2 `jojo-newspaper`

这是在线交付 Bucket。历史名称保留，但统一存放书籍、报纸和杂志。Reader 和 Agent 通过 CDN 读取。

```text
jojo-newspaper/
├─ catalog.jox
└─ content/
   ├─ books/
   ├─ newspapers/
   └─ magazines/
```

这里保留 `catalog.jox`，因为浏览器不能使用私有 B2 的 `ListObjects`。它是在线馆藏的入口和一次发布的最终提交标志。

## 2. 标识符与类型

### 2.1 Dataset ID

Dataset ID 必须稳定、可读，并仅使用小写字母、数字和连字符。中文书名默认转换成无声调拼音：

```text
毛泽东自述   → mao-ze-dong-zi-shu
毛泽东选集   → mao-ze-dong-xuan-ji
人民日报     → rmrb
求是         → qiushi
```

来源平台不是 Dataset。例如，微信读书不是一个 Dataset；它只记录在 Item 的 `provenance` 和 `extensions` 中。

### 2.2 Item ID

统一规则：

```text
itemId = datasetId:itemKey
```

示例：

```text
mao-ze-dong-zi-shu:full-book
mao-ze-dong-xuan-ji:volume-1
rmrb:1990-09-06
qiushi:2026-15
```

ID 不重复表达已有的 `type`，所以不使用 `rmrb:issue:...`。

### 2.3 类型

Dataset 类型：

```text
book
book-series
newspaper
magazine
```

Item 类型：

```text
book
book-volume
newspaper
magazine
```

不使用 `periodical-issue`、`newspaper-issue` 或 `magazine-issue`。

## 3. Canonical

Canonical 是长期保存的规范真值。它使用普通 JSON/Gzip，不使用 Jox；只有后台任务读取完整 Item。

### 3.1 目录

```text
canonical/
├─ books/
│  ├─ mao-ze-dong-zi-shu/
│  │  ├─ dataset.json
│  │  ├─ items/full-book/item.json.gz
│  │  └─ assets/<sha256>.jpg
│  └─ mao-ze-dong-xuan-ji/
│     ├─ dataset.json
│     ├─ items/volume-1/item.json.gz
│     ├─ items/volume-2/item.json.gz
│     └─ assets/<sha256>.mp3
├─ newspapers/
│  └─ rmrb/
│     ├─ dataset.json
│     ├─ items/1990/09/1990-09-06.json.gz
│     └─ assets/<sha256>.pdf
└─ magazines/
   └─ qiushi/
      ├─ dataset.json
      ├─ items/2026/2026-15.json.gz
      ├─ items/2026/2026-special-1.json.gz
      └─ assets/<sha256>.pdf
```

资源以 SHA-256 命名，避免同一 Dataset 内重复保存。

### 3.2 Dataset

单本书：

```json
{
  "formatVersion": "jojo-dataset/1",
  "datasetId": "mao-ze-dong-zi-shu",
  "type": "book",
  "title": "毛泽东自述",
  "language": "zh-CN",
  "itemPath": "items/{itemKey}/item.json.gz"
}
```

多卷书：

```json
{
  "formatVersion": "jojo-dataset/1",
  "datasetId": "mao-ze-dong-xuan-ji",
  "type": "book-series",
  "title": "毛泽东选集",
  "language": "zh-CN",
  "itemPath": "items/{itemKey}/item.json.gz"
}
```

报纸：

```json
{
  "formatVersion": "jojo-dataset/1",
  "datasetId": "rmrb",
  "type": "newspaper",
  "title": "人民日报",
  "language": "zh-CN",
  "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz"
}
```

杂志：

```json
{
  "formatVersion": "jojo-dataset/1",
  "datasetId": "qiushi",
  "type": "magazine",
  "title": "求是",
  "language": "zh-CN",
  "itemPath": "items/{YYYY}/{itemKey}.json.gz"
}
```

Canonical Dataset 不引用 `.jox`。`.jox` 只属于 Delivery。

### 3.3 Item 外壳

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "稳定ID",
  "datasetId": "所属Dataset",
  "type": "book",
  "title": "标题",
  "language": "zh-CN",
  "identifiers": {},
  "metadata": {},
  "content": {},
  "assets": [],
  "annotations": [],
  "provenance": {},
  "extensions": {}
}
```

`provenance` 保存所有来源通用的审计和重建信息：

```json
{
  "source": "weread",
  "sourceId": "3300033212",
  "sourceFormat": "weread-json",
  "sourceExportedAt": "2026-08-08T10:44:51.989Z",
  "sourceSha256": "4bf150...",
  "importedAt": "2026-08-10T14:02:27.278Z",
  "importer": "@jojo/content-pipeline/0.1.0"
}
```

`extensions` 只保存来源特有且标准字段无法表达的数据：

```json
{
  "weread": {
    "bid": "8e7323f0813ab706fg018321"
  }
}
```

### 3.4 书籍

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "mao-ze-dong-xuan-ji:volume-5",
  "datasetId": "mao-ze-dong-xuan-ji",
  "type": "book-volume",
  "title": "毛泽东选集 第五卷",
  "language": "zh-CN",
  "identifiers": { "isbn": null },
  "metadata": {
    "authors": ["毛泽东"],
    "publisher": "人民出版社",
    "publishedDate": null,
    "volumeNumber": 5,
    "totalVolumes": 5
  },
  "content": {
    "schema": "jojo-content/book/1",
    "toc": [
      {
        "id": "toc:0001",
        "order": 1,
        "title": "论十大关系",
        "targetId": "chapter:0001"
      }
    ],
    "chapters": [
      {
        "id": "chapter:0001",
        "order": 1,
        "title": "论十大关系",
        "body": {
          "format": "html",
          "profile": "jojo-semantic-html/1",
          "value": "<p id=\"anchor:p1\">正文……</p><figure data-asset-id=\"asset:image-001\"><figcaption>插图</figcaption></figure>"
        },
        "assetRefs": ["asset:image-001"]
      }
    ]
  },
  "assets": [
    {
      "id": "asset:image-001",
      "type": "image",
      "mediaType": "image/jpeg",
      "path": "assets/0123456789abcdef.jpg",
      "size": 123456,
      "sha256": "0123456789abcdef",
      "alt": "正文插图",
      "caption": "插图说明"
    },
    {
      "id": "asset:audio-001",
      "type": "audio",
      "mediaType": "audio/mpeg",
      "path": "assets/abcdef0123456789.mp3",
      "size": 2345678,
      "sha256": "abcdef0123456789",
      "title": "朗读音频"
    },
    {
      "id": "asset:video-001",
      "type": "video",
      "mediaType": "video/mp4",
      "path": "assets/fedcba9876543210.mp4",
      "size": 34567890,
      "sha256": "fedcba9876543210",
      "title": "相关影像",
      "posterAssetId": "asset:image-001"
    }
  ],
  "annotations": [
    {
      "id": "annotation:0001",
      "targetId": "chapter:0001",
      "anchorId": "anchor:p1",
      "kind": "footnote",
      "label": "1",
      "body": {
        "format": "text",
        "value": "脚注正文……"
      }
    }
  ],
  "provenance": {},
  "extensions": {}
}
```

`anchorId` 是正文内部的可选精确位置。没有它时，Annotation 针对整个章节；脚注不是图片 Asset。

### 3.5 报纸

报纸一天一个 Item，ID 和路径不添加 `issue` 或 `main`：

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "rmrb:1990-09-06",
  "datasetId": "rmrb",
  "type": "newspaper",
  "title": "人民日报 1990年9月6日",
  "language": "zh-CN",
  "identifiers": {},
  "metadata": {
    "publishedDate": "1990-09-06",
    "issueNumber": null
  },
  "content": {
    "schema": "jojo-content/newspaper/1",
    "pages": [
      {
        "id": "page:05",
        "order": 5,
        "number": 5,
        "label": "第5版",
        "title": null,
        "assetRefs": ["asset:page-05"]
      },
      {
        "id": "page:supplement-01",
        "order": 9,
        "number": null,
        "label": "增刊",
        "title": "国庆专刊",
        "assetRefs": []
      }
    ],
    "articles": [
      {
        "id": "article:0190a4c7",
        "order": 1,
        "title": "历史也得完整地“透明”",
        "authors": ["宋志坚"],
        "body": {
          "format": "html",
          "profile": "jojo-semantic-html/1",
          "value": "<p>正文……</p>"
        },
        "assetRefs": []
      }
    ],
    "placements": [
      {
        "id": "placement:0190b821",
        "pageId": "page:05",
        "articleId": "article:0190a4c7",
        "order": 1,
        "role": "complete"
      }
    ]
  },
  "assets": [],
  "annotations": [],
  "provenance": {},
  "extensions": {}
}
```

`placements` 是文章与版面的唯一权威关系。`pages` 和 `articles` 不重复保存双向引用。`role` v1 允许：

- `complete`：全文在该版。
- `start`：从该版开始。
- `continue`：在该版续接。

增刊作为特殊版面保存在同一天 Item 中。

### 3.6 杂志

杂志按年和期号命名；增刊使用可读的特殊期号，不引入版本代码：

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "qiushi:2026-15",
  "datasetId": "qiushi",
  "type": "magazine",
  "title": "求是 2026年第15期",
  "language": "zh-CN",
  "identifiers": {},
  "metadata": {
    "year": 2026,
    "issueNumber": 15,
    "issueLabel": "2026年第15期",
    "publishedDate": "2026-08-01"
  },
  "content": {
    "schema": "jojo-content/magazine/1",
    "pages": [],
    "articles": [],
    "placements": []
  },
  "assets": [],
  "annotations": [],
  "provenance": {},
  "extensions": {}
}
```

增刊示例：

```text
itemKey: 2026-special-1
itemId: qiushi:2026-special-1
path: items/2026/2026-special-1.json.gz
```

## 4. 语义 HTML

正文优先使用：

```json
{
  "format": "html",
  "profile": "jojo-semantic-html/1",
  "value": "<p>正文……</p>"
}
```

只有纯文本时允许：

```json
{
  "format": "text",
  "value": "正文……"
}
```

`jojo-semantic-html/1` v1 允许：

```text
p h1 h2 h3 h4 h5 h6 blockquote ol ul li
strong em sup sub a br hr figure figcaption
```

允许属性：

```text
id href data-asset-id data-annotation-id data-align
```

`data-align` 只允许 `left`、`center`、`right`，用于保留署期、署名、题记等具有语义的原书对齐方式。禁止脚本、iframe、style、class、事件属性、外部 CSS 和 `javascript:` URL。图片位置使用 `figure[data-asset-id]`，真实文件由 `assets` 描述。

## 5. Delivery

### 5.1 目录

```text
jojo-newspaper/
├─ catalog.jox
└─ content/
   ├─ books/
   │  └─ mao-ze-dong-xuan-ji/
   │     ├─ index.jox
   │     └─ items/
   │        ├─ volume-1/
   │        │  ├─ manifest.jox
   │        │  ├─ chapters/<opaque-id>.jox
   │        │  ├─ search/text.jox
   │        │  ├─ assets/<opaque-id>.jox
   │        │  └─ exports/<opaque-id>.jox
   │        └─ volume-5/
   ├─ newspapers/
   │  └─ rmrb/
   │     ├─ index.jox
   │     └─ items/1990/09/1990-09-06/
   │        ├─ manifest.jox
   │        ├─ articles/<opaque-id>.jox
   │        ├─ assets/<opaque-id>.jox
   │        └─ exports/<opaque-id>.jox
   └─ magazines/
      └─ qiushi/
         ├─ index.jox
         └─ items/2026/2026-15/
            ├─ manifest.jox
            ├─ articles/<opaque-id>.jox
            ├─ assets/<opaque-id>.jox
            └─ exports/<opaque-id>.jox
```

职责：

- `catalog.jox`：全部在线 Dataset。
- `index.jox`：一个 Dataset 下的 Item 摘要和 Manifest 地址。
- `manifest.jox`：一个 Item 的元数据、目录、规模和子对象描述。
- `chapters/*.jox`：单个书籍章节。
- `search/text.jox`：一个 Item 的轻量纯文本搜索块，只供浏览器书内搜索。
- `articles/*.jox`：单篇报刊文章。
- `assets/*.jox`：图片、音频、视频和 PDF 等媒体。
- `exports/*.jox`：可直接下载的整本或整期成品。

Delivery Index 使用独立格式，避免与 Canonical Dataset 混淆：

```json
{
  "formatVersion": "jojo-delivery-index/1",
  "revision": 1,
  "datasetId": "mao-ze-dong-xuan-ji",
  "type": "book-series",
  "title": "毛泽东选集",
  "language": "zh-CN",
  "items": [
    {
      "itemId": "mao-ze-dong-xuan-ji:volume-5",
      "itemKey": "volume-5",
      "type": "book-volume",
      "order": 5,
      "title": "毛泽东选集 第五卷",
      "manifestObject": "items/volume-5/manifest.jox"
    }
  ]
}
```

### 5.2 Manifest 与 Export

Manifest 不包含整章正文，只描述对象：

```json
{
  "formatVersion": "jojo-item-manifest/1",
  "revision": 1,
  "itemId": "mao-ze-dong-zi-shu:full-book",
  "datasetId": "mao-ze-dong-zi-shu",
  "type": "book",
  "title": "毛泽东自述",
  "language": "zh-CN",
  "metadata": {},
  "content": {
    "schema": "jojo-content/book/1",
    "toc": [],
    "chapters": [
      {
        "id": "chapter:0001",
        "order": 1,
        "title": "第一章",
        "characterCount": 4321,
        "object": "chapters/AbCdEf.jox",
        "size": 5678,
        "sha256": "..."
      }
    ]
  },
  "contentStats": {
    "chapterCount": 28,
    "characterCount": 105487
  },
  "search": {
    "format": "text",
    "profile": "jojo-book-search/1",
    "object": "search/text.jox",
    "size": 98642,
    "sha256": "..."
  },
  "assets": [],
  "exports": [
    {
      "id": "export:epub",
      "format": "epub",
      "mediaType": "application/epub+zip",
      "fileName": "毛泽东自述.epub",
      "object": "exports/Fp71c8x2.jox",
      "size": 826351,
      "sha256": "..."
    }
  ]
}
```

`exports/` 是可选目录：

- 书籍通常提供整本 EPUB，可选 PDF。
- 报纸通常提供整期原报 PDF。
- 杂志通常提供整期 PDF 或 EPUB。
- 没有成品下载时，`exports` 为 `[]`，目录不创建。

图片、音频和视频属于 `assets/`，不属于 `exports/`。

书籍导入时生成一个可选的 `search/text.jox`：

```json
{
  "formatVersion": "jojo-book-search/1",
  "itemId": "mao-ze-dong-zi-shu:full-book",
  "blocks": [
    {
      "targetId": "chapter:0001",
      "anchorId": "paragraph-03",
      "order": 18,
      "text": "这是去除 HTML 后的段落正文。"
    }
  ]
}
```

它不是分词倒排索引，也不依赖 ES。Reader 首次搜索时从 CDN 下载一次，在浏览器内做 NFKC 归一化后的精确子串匹配；`anchorId` 只在来源本来有稳定锚点时保存。旧 Manifest 没有 `search` 时，Reader 可以逐章读取并搜索，保证 v1 数据向后兼容。

Jox 是可逆混淆和压缩封装，用于降低直接抓取便利性，不是加密或权限系统。对象名使用内容派生的不透明 ID；Manifest 保存媒体类型、大小和 SHA-256。

## 6. Reader 与 Agent

Reader：

```text
catalog.jox
→ Dataset index.jox
→ Item manifest.jox
→ chapter/article/asset/export.jox
```

单本书搜索：

```text
Item manifest.jox
→ search/text.jox（一次下载并缓存）
→ 命中 targetId
→ 只读取对应 chapter.jox
```

Agent：

```text
Elasticsearch 搜索
→ 返回 manifestObject 和 fragmentObject
→ 从 Delivery CDN 读取 Manifest
→ 查看目录或读取命中章节
→ 确有必要且未超预算时扫描整个 Item
```

Agent 不读取 Raw 或 Canonical。Elasticsearch 只负责定位，正文和目录来自 Delivery CDN。完整扫描发生在工具侧，只把统计和少量证据送入模型上下文。

环境变量：

```text
JOJO_CONTENT_SEARCH_URL=https://<search-service>/content/search
JOJO_CONTENT_CDN_BASE=https://<delivery-cdn>/
```

## 7. ES 重建

Canonical Item 是 ES 的源数据。重建任务：

1. 使用私有 B2/S3 `ListObjects` 查找 `canonical/**/dataset.json`。
2. 按 Dataset 的 `itemPath` 和实际对象列表读取 `item.json.gz`。
3. 临时拆分搜索文档并批量写入新 ES 索引。
4. 验证后切换索引别名或配置。

B2 Canonical 不长期保存 `search/*.jsonl.gz`，避免重复保存正文和产生漂移。流水线本地构建目录仍可生成临时 `search/documents.jsonl.gz` 供一次发布任务使用，但发布 Raw/Canonical 时不上传它。Delivery 中每本书的 `search/text.jox` 是面向浏览器的派生数据，可以随 Canonical 重新生成，不作为 ES 重建真值。

## 8. 导入与完整性校验

书籍导入器支持：

- 微信读书 WRX JSON。
- EPUB。
- 无 DRM 的 MOBI 6/7：`.azw`、`.mobi`、`.prc`。

导入器必须校验：

- 元数据声明的目录数量与实际 TOC 是否一致。
- TOC 中应有正文的条目是否都有章节记录。
- 所有章节分片是否能够解码。
- TOC 的 `targetId` 是否指向真实章节。
- Annotation 的 `targetId` 和可选 `anchorId` 是否有效。
- Asset/Export 的大小和 SHA-256 是否匹配。
- Delivery Manifest、Fragment 和搜索指针是否可解析。
- `search/text.jox` 的 Item 身份、章节目标、大小和 SHA-256 是否正确。

默认发现缺章或解码失败时拒绝导入；只有显式 `--allow-partial` 才允许部分导入。同一来源 ID 存在多个导出时，优先保留目录与正文更完整的版本。

命令：

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input "C:\Users\YOUR_NAME\Downloads\book.json" `
  --input "C:\Users\YOUR_NAME\Downloads\book.epub" `
  --output "C:\temp\jojo-build"

pnpm --filter @jojo/content-pipeline validate -- "C:\temp\jojo-build"
```

## 9. 发布边界

发布到 B2：

```text
本地 raw/       → jojo-news-raw/raw/
本地 canonical/ → jojo-news-raw/canonical/
本地 delivery/  → jojo-newspaper/
```

发布顺序：

```text
Raw
→ Canonical
→ Delivery chapter/article/asset/export
→ Manifest
→ Dataset index
→ catalog.jox
```

`catalog.jox` 最后发布，表示本次 Delivery 元数据已经完整。旧的不透明内容对象可以延迟清理，不能在新 Catalog 生效前删除。
