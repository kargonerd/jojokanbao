# JOJO 统一数据与交付格式 v1

内容可选携带 `publicationStatus: "draft" | "published"` 和 `access: "public" | "authenticated"`。缺省值分别按 `published`、`public` 解释，以兼容旧数据。`draft` 不进入普通馆藏列表；`authenticated` 只表示 Reader 的登录软门槛，公开 CDN 对象本身并不因此获得访问控制或 DRM。

> 状态：待合并。书籍导入器已实现；报纸和杂志按照本文约定接入。

JOJO 用同一套外壳保存书籍、报纸和杂志，但明确区分三类数据：

- Raw：不可替代的来源原文件。
- Canonical：清晰、规范、可以重建一切派生数据的唯一真值。
- Delivery：供 Reader 和 Agent 从 CDN 读取的拆分、压缩、Jox 混淆对象。

Hugging Face Dataset 是书籍、报纸和杂志唯一的 Canonical 真值，保存 Canonical JSON、索引和可读媒体。B2 只保存 Reader 使用的 Delivery；Raw 不上传。Elasticsearch 和 EPUB 都是可由 Canonical 重建的派生数据。格式不包含 `rights`；将来确有权限管理需求时再单独升级版本。

## 1. 两个 B2 Bucket

### 1.1 `jojo-news-raw`

这是历史私有 Bucket。新发布任务不再写入它；Reader、Agent 和重建任务均不依赖它。

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

上述目录只描述已经上传的历史对象。Raw 来源文件只在本地导入期间使用，不再上传；需要长期恢复的数据必须进入 Hugging Face Canonical。

报纸和杂志数量较多，Raw 按来源、年份、月份、日期或期号分片。

`jojo-news-raw/canonical/` 只保留已经上传的历史对象。书籍和报刊 Canonical 均发布到 Hugging Face，B2 只保存应用交付所需的 Delivery 对象。

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
│     ├─ assets/pdfs/1990/09/1990-09-06.pdf
│     └─ assets/images/<sha256>.jpg
└─ magazines/
   └─ qiushi/
      ├─ dataset.json
      ├─ items/2026/2026-15.json.gz
      ├─ items/2026/2026-special-1.json.gz
      └─ assets/pdfs/2026/2026-15.pdf
```

期级 PDF 是面向展示的主资源，使用日期或期号命名；文章图片等无稳定业务名称的资源仍以
SHA-256 命名，避免同一 Dataset 内重复保存。

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
  "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz",
  "availability": {
    "formatVersion": "jojo-periodical-availability/1",
    "text": {
      "format": "adaptive-calendar/1",
      "startDate": "1946-05-15",
      "endDate": "2025-12-31",
      "default": "available",
      "years": {}
    },
    "pdf": {
      "format": "adaptive-calendar/1",
      "startDate": "1946-05-15",
      "endDate": "2025-12-31",
      "default": "available",
      "years": {}
    }
  }
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

报纸和杂志必须分别表达文本版与 PDF 版是否可用。日期型报刊把两套自适应日历直接放进
Dataset 和 Delivery Index，不再拆分年度 Availability 文件。顶层默认日期可用；整年可用时
不记录该年。某年大多数日期可用时使用 `exclude`，只有少数日期可用时使用 `include`。两者
都可以包含完整月份、连续日期范围和零散日期：

```json
{
  "1951": {
    "exclude": {
      "months": ["08"],
      "ranges": [["11-03", "11-07"]],
      "dates": ["02-14"]
    }
  },
  "1967": {
    "include": {
      "dates": ["01-06", "01-13"]
    }
  }
}
```

生成器根据该年范围内可用与缺失日期的数量选择较少的一侧：可用日期不超过一半时使用
`include`，否则使用 `exclude`。完整月份优先折叠为 `months`，三个及以上连续日期折叠为
`ranges`，其余放入 `dates`。`text` 表示该期
至少有一篇可阅读文章；`pdf` 表示整期 PDF 已通过校验并登记为 Asset。两者互不推断。

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
        "contentState": "available",
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

报刊文章的 `contentState` 只允许 `available`、`missing`。有正文、实际图片或明确的
`【图片】` 占位内容时为 `available`；没有可阅读正文时为 `missing`，但标题和目录位置仍须
保留。人工修复方式和无法确认的原因属于私有审计信息，不扩展公开状态枚举。

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
strong em sup sub u s q a br hr figure figcaption span
```

允许属性：

```text
id href data-target-id data-anchor-id data-asset-id data-annotation-id data-align
data-role data-indent data-font data-size data-width data-break-before
```

受控属性的取值如下：

- `data-align`：`left`、`center`、`right`，保留署期、署名、题记等对齐关系。
- `data-indent`：当前只允许 `none`，表示原书明确不做首行缩进。
- `data-font`：`kai`、`fang-song`，仅用于编辑注、诗歌等字体本身承担区分作用的内容。
- `data-size`：当前只允许 `small`，用于原书明确缩小的题内层级等内容。
- `data-role`：`annotation`、`aside`、`attribution`、`caption`、`cover`、`full-width`、`highlight`、`inline-image`、`letter`、`note`、`poem`、`salutation`、`signature`、`subheading`、`table-image`、`translation`。
- `data-width`：`10` 到 `100` 的整数，表示图片相对正文栏宽的百分比；Reader 可以根据屏幕空间进一步收窄。
- `data-break-before`：当前只允许 `page`，表示来源明确要求在此处另起一页；滚动 Reader 可以忽略，分页 Reader 和 EPUB 导出应遵守。
- `a[data-target-id]`：Item 内的稳定章节 ID；`data-anchor-id` 可选，表示该章节内的精确锚点。导入器应把 EPUB 路径或 Kindle filepos 转换成这两个字段，不把来源文件路径写入规范正文。

块级图片使用 `figure[data-asset-id]`，图片说明放在其 `figcaption` 中。嵌在文字或公式中的小图使用空的 `span[data-asset-id][data-role="inline-image"]`，不得提升为独立插图。真实文件统一由 Item 的 `assets` 描述。

导入器应把来源 class 转换为上述 HTML 元素和受控属性，不把来源 class、内联 CSS 或厂商命名写进规范数据。例如粗体转为 `strong`、上下标转为 `sup`/`sub`、块引文转为 `blockquote`、图片说明转为 `figcaption`，并把封面、全幅图、表格图、书信、署名和显式分页转换成对应的受控语义。脚注定义及其正文标记应转换为 Item 的 `annotations`，不得只保留来源内部链接。禁止脚本、iframe、style、class、事件属性、外部 CSS 和 `javascript:` URL。

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
   │        ├─ assets/newspaper.pdf.jox
   │        └─ assets/<opaque-id>.jox
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
- `exports/*.jox`：由 Canonical 内容生成的整本下载成品，例如 EPUB。

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

书籍和短期刊物可用 `items` 明列 Item。大型日期型报刊改用确定性的 `itemPath` 与内嵌
`availability.text`、`availability.pdf`，避免在一个 Index 中重复列出数万条 Item，也避免
前端额外下载逐年索引。Reader 先检查对应能力的日历，再用日期展开 Manifest 路径。

### 5.2 Manifest、Asset 与 Export

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
- 报纸和杂志的原始整期 PDF 属于 `assets/`，用于阅读器展示，也可以下载。
- 由规范内容额外生成的 EPUB/PDF 才属于 `exports/`。
- 没有成品下载时，`exports` 为 `[]`，目录不创建。

图片、音频、视频和原始期级 PDF 属于 `assets/`，不属于 `exports/`。

报刊 Item Manifest 还必须直接表达两种能力；空正文或 rejected/missing 文章不算文本可用：

```json
{
  "availability": {"text": "available", "pdf": "available"},
  "content": {
    "schema": "jojo-content/newspaper/1",
    "articles": [
      {"id": "article:1", "title": "示例", "status": "missing", "object": null}
    ]
  },
  "assets": [
    {
      "type": "pdf",
      "role": "issue-pdf",
      "mediaType": "application/pdf",
      "object": "assets/newspaper.pdf.jox"
    }
  ],
  "exports": []
}
```

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

1. 读取 Hugging Face Dataset 的 `catalog.json` 和各 Dataset 的 `dataset.json`。
2. 按 Dataset 的下载路径读取 Canonical Item `.json.gz`。
3. 临时拆分搜索文档并批量写入新 ES 索引。
4. 验证后切换索引别名或配置。

Hugging Face Canonical 可同时保存用于 Dataset Viewer 的 `data/search-documents.jsonl.gz`；它必须由同一批 Canonical Item 生成。Delivery 中每本书的 `search/text.jox` 是面向浏览器的派生数据，可以随 Canonical 重新生成，不作为 ES 重建真值。

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

书籍、报纸和杂志统一使用以下发布边界：

```text
本地 canonical/ → Hugging Face Dataset
本地 delivery/  → jojo-newspaper/
本地 raw/       → 不上传
```

已经存在的私有 B2 Raw / Canonical 历史对象不会在发布过程中自动删除；清理必须作为单独、显式确认的操作执行。

本地构建顺序：

```text
Raw
→ Canonical
→ Delivery chapter/article/asset/export
→ Manifest
→ Dataset index
→ catalog.jox
```

`catalog.jox` 最后发布，表示本次 Delivery 元数据已经完整。旧的不透明内容对象可以延迟清理，不能在新 Catalog 生效前删除。

远端发布顺序为 Hugging Face Canonical → B2 Delivery → Elasticsearch。后两者均可从 Hugging Face Canonical 重建。
