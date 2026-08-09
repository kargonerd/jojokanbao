# JOJO 数据格式 v1

> 状态：v1 已按本文实现。`@jojo/content`、内容导入/发布流水线、Workbench、Reader、
> ES 搜索路由和 Agent 工具共同使用本格式；后续不兼容修改必须升级格式版本。

JOJO 使用一套模型表达书籍、报纸和杂志，同时把长期保存的规范数据与浏览器直接读取的
交付数据分开。基本阅读、目录浏览和整本下载只依赖对象存储与 CDN，不依赖数据库或
Elasticsearch。

## 1. 设计原则

1. `Dataset` 按作品或出版物划分，不按导入来源划分。
2. `Item` 是一次可以独立阅读或下载的单册、单卷或单期。
3. 微信读书、EPUB、HTML、PDF、PeopleData 等只是来源，记录在 `provenance` 和
   `extensions` 中。
4. 原始数据、规范数据和浏览器交付数据分层保存；规范数据是唯一真值。
5. 大内容按章节或文章拆分交付，浏览器不需要加载整本书或整期刊物。
6. 图片、音频、视频、PDF 和 EPUB 都作为外部对象保存，正文只通过稳定 Asset ID 引用。
7. Jox 只用于提高批量抓取成本，不被视为加密或访问控制。
8. v1 不包含 `rights` 字段。是否允许访问和下载由产品与发布流程决定，后续确有需要时再扩展。

## 2. 核心概念

### 2.1 Catalog

Catalog 是平台的总目录，只负责发现 Dataset，不保存书籍正文或报刊文章。

### 2.2 Dataset

Dataset 是用户认知中的一套作品或一种连续出版物，也是独立维护和发布的边界。

| 内容 | Dataset | Item |
| --- | --- | --- |
| 《毛泽东选集》 | `maozedong-xuanji` | 第一卷至第四卷 |
| 《马克思恩格斯全集》 | `maen-quanji` | 每一卷 |
| 《毛泽东自述》 | `maozedong-zishu` | `main`，只有一册 |
| 《人民日报》 | `rmrb` | 每天的每个版本 |
| 《读书》杂志 | `dushu-magazine` | 每一期 |

`weread` 不能作为 Dataset ID。它只说明内容从微信读书导入，同一 Dataset 的不同 Item
也可以来自不同渠道。

### 2.3 Item

Item 是最小的独立出版单元：

- 单本书：一个 Dataset 中有一个 `book` Item。
- 多卷书：一个 Dataset 中有多个 `book-volume` Item。
- 报纸或杂志：每个日期、期号和版本组合是一个 `periodical-issue` Item。

章节和文章不是 Item。它们属于 Item，并在浏览器交付层拆成独立对象。

### 2.4 Asset、Annotation 与 Export

- Asset：图片、音频、视频、PDF 等内容资源。
- Annotation：脚注、尾注、编者注等结构化注释。
- Export：为用户预先生成的 EPUB、PDF 等整册下载文件。

## 3. 版本和 ID

每种 JSON 对象都在内容中携带格式版本，例如：

```json
{
  "formatVersion": "jojo-item/1"
}
```

v1 路径不额外增加 `/v1/`。如果未来出现不兼容格式，再增加新的格式版本和迁移逻辑。

ID 约定：

- `datasetId` 在 Catalog 内唯一，使用小写字母、数字和连字符。
- `itemId` 在 Dataset 内唯一。
- Item 内部所有 `id` 必须在该 Item 内唯一，不能让章节、文章、Asset 或 Annotation 重名。
- ID 一经发布便保持稳定；修改标题、页码和顺序不能改变 ID。
- 随机交付文件名不是业务 ID，替换交付对象时不必改变业务 ID。

推荐形式：

```text
maozedong-xuanji
maozedong-xuanji:volume-1
rmrb:issue:1990-09-06:main
chapter:001
article:0190a4c7
asset:image-001
annotation:001
placement:0190b821
```

报刊的 `editionCode` 必填，只能包含小写字母、数字和连字符。无法证明具体版本时使用
没有附加语义的 `main`，不要擅自标记成 `national`。

## 4. 三层存储

JOJO 已有两个 B2 Bucket，v1 直接复用，不要求增加数据库或第三个 Bucket。Bucket 名称是
历史名称，不限制其中保存的内容类型。

```text
jojo-news-raw/                         # Private：原始数据与规范真值
├─ raw/
│  ├─ weread/{sourceBookId}/...
│  ├─ epub/{importId}/...
│  ├─ html/{importId}/...
│  └─ peopledata/...
└─ canonical/
   └─ {datasetId}/
      ├─ dataset.json
      ├─ items/{itemKey}/item.json.gz
      ├─ assets/{assetObject}
      ├─ changes.jsonl
      └─ search/*.jsonl.gz              # 可选的派生索引输入分片

jojo-newspaper/                         # Private origin + CDN：浏览器交付对象
├─ catalog.jox
└─ content/
   └─ {datasetId}/
      ├─ index.jox
      ├─ availability/{YYYY}.jox        # 大型报刊按年拆分
      └─ items/{itemKey}/
         ├─ manifest.jox
         ├─ chapters/{random}.jox
         ├─ articles/{random}.jox
         ├─ assets/{random}.jox
         └─ exports/{random}.jox
```

Canonical 的 `path` 相对于该 Dataset 的 `canonical/{datasetId}/` 目录。Delivery 中的
`indexObject`、`manifestObject` 和 `object` 使用 POSIX 相对路径，并相对于包含该字段的
Jox 对象解析；解析后的地址不得逃出所属 Dataset 目录。唯一例外是根 `catalog.jox` 中的
`indexObject`，它相对于 Delivery Bucket 根目录。Reader 只需内置 CDN 根地址和
`jojo-jox/1` 解码 Profile，不内置任何书目数据。

三层职责如下：

| 层 | 内容 | 是否真值 | 主要用途 |
| --- | --- | --- | --- |
| Raw | 来源原文件 | 否 | 重新解析、排错和来源核验 |
| Canonical | 清晰、规范化的 `jojo-item/1` | 是 | 重建交付对象、ES 和其他派生数据 |
| Delivery | Jox manifest、内容片段和媒体 | 否 | 浏览器通过 B2/CDN 直接读取 |

不可替代的 Raw 建议长期保存。Canonical 必须长期保存；即使 ES 整库丢失，也能够只用
Canonical 重建。现有原报 PDF 可以由 Canonical Asset 引用原位置，无须为迁移重复存一份。

## 5. Catalog

`catalog.jox` 解码后是 `jojo-catalog/1`。一个条目对应一个 Dataset，而不是一本书。

```json
{
  "formatVersion": "jojo-catalog/1",
  "revision": 12,
  "updatedAt": "2026-08-09T16:00:00+08:00",
  "datasets": [
    {
      "datasetId": "maozedong-xuanji",
      "type": "book-series",
      "title": "毛泽东选集",
      "language": "zh-CN",
      "itemCount": 4,
      "indexObject": "content/maozedong-xuanji/index.jox"
    },
    {
      "datasetId": "maozedong-zishu",
      "type": "book",
      "title": "毛泽东自述",
      "language": "zh-CN",
      "itemCount": 1,
      "indexObject": "content/maozedong-zishu/index.jox"
    },
    {
      "datasetId": "rmrb",
      "type": "newspaper",
      "title": "人民日报",
      "language": "zh-CN",
      "indexObject": "content/rmrb/index.jox"
    },
    {
      "datasetId": "dushu-magazine",
      "type": "magazine",
      "title": "读书",
      "language": "zh-CN",
      "indexObject": "content/dushu-magazine/index.jox"
    }
  ]
}
```

Catalog 只用于发现 Dataset。客户端拿到 `indexObject` 后直接请求对应的 Dataset 索引。

## 6. Dataset 索引

Dataset 的规范文件和交付层 `index.jox` 解码后都使用 `jojo-dataset/1`。交付索引只保存
展示和导航所需的摘要，不保存正文。

### 6.1 多卷书

```json
{
  "formatVersion": "jojo-dataset/1",
  "revision": 3,
  "datasetId": "maozedong-xuanji",
  "type": "book-series",
  "title": "毛泽东选集",
  "language": "zh-CN",
  "description": "《毛泽东选集》全四卷",
  "items": [
    {
      "itemId": "maozedong-xuanji:volume-1",
      "itemKey": "volume-1",
      "type": "book-volume",
      "order": 1,
      "title": "毛泽东选集 第一卷",
      "manifestObject": "items/volume-1/manifest.jox"
    },
    {
      "itemId": "maozedong-xuanji:volume-2",
      "itemKey": "volume-2",
      "type": "book-volume",
      "order": 2,
      "title": "毛泽东选集 第二卷",
      "manifestObject": "items/volume-2/manifest.jox"
    },
    {
      "itemId": "maozedong-xuanji:volume-3",
      "itemKey": "volume-3",
      "type": "book-volume",
      "order": 3,
      "title": "毛泽东选集 第三卷",
      "manifestObject": "items/volume-3/manifest.jox"
    },
    {
      "itemId": "maozedong-xuanji:volume-4",
      "itemKey": "volume-4",
      "type": "book-volume",
      "order": 4,
      "title": "毛泽东选集 第四卷",
      "manifestObject": "items/volume-4/manifest.jox"
    }
  ]
}
```

单本书使用相同结构，只是 `items` 只有一个 `main`。因此《毛泽东自述》是 Dataset
`maozedong-zishu`，其中只有 Item `maozedong-zishu:main`。

### 6.2 大型报刊

报纸和长期杂志不在 `index.jox` 中列出所有期次，而是按年分片：

```json
{
  "formatVersion": "jojo-dataset/1",
  "revision": 27,
  "datasetId": "rmrb",
  "type": "newspaper",
  "title": "人民日报",
  "language": "zh-CN",
  "startDate": "1946-05-15",
  "endDate": "2025-12-31",
  "availability": [
    {
      "year": 1990,
      "object": "availability/1990.jox"
    },
    {
      "year": 1991,
      "object": "availability/1991.jox"
    }
  ]
}
```

`availability/1990.jox` 解码示例：

```json
{
  "formatVersion": "jojo-availability/1",
  "datasetId": "rmrb",
  "year": 1990,
  "items": [
    {
      "itemId": "rmrb:issue:1990-09-06:main",
      "itemKey": "1990-09-06.main",
      "publishedDate": "1990-09-06",
      "editionCode": "main",
      "title": "人民日报 1990年9月6日",
      "manifestObject": "../items/1990-09-06.main/manifest.jox"
    }
  ]
}
```

## 7. Canonical Item 统一外壳

所有规范 Item 都有相同外层，类型差异只放在 `metadata` 和 `content` 中：

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "稳定且不会因排序变化的 ID",
  "datasetId": "所属 Dataset",
  "type": "book | book-volume | periodical-issue",
  "title": "显示标题",
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

`revision` 属于整个 Item。修改其中任意章节、文章、版面、Placement、Asset 或 Annotation，
都必须增加 Item revision。

## 8. 书籍完整示例

以下是一个包含目录层级、图片、音频、视频、原书 PDF 和脚注的 Canonical Item。哈希值为
示例占位值，实际发布时必须填真实 SHA-256。

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "maozedong-xuanji:volume-1",
  "datasetId": "maozedong-xuanji",
  "type": "book-volume",
  "title": "毛泽东选集 第一卷",
  "language": "zh-CN",
  "identifiers": {
    "isbn": null
  },
  "metadata": {
    "authors": ["毛泽东"],
    "editors": [],
    "publisher": "人民出版社",
    "publishedDate": "1991-06",
    "edition": "第二版",
    "volumeNumber": 1,
    "totalVolumes": 4,
    "description": "《毛泽东选集》第一卷示例数据"
  },
  "content": {
    "schema": "jojo-content/book/1",
    "toc": [
      {
        "id": "toc:part-01",
        "order": 1,
        "title": "第一次国内革命战争时期",
        "children": [
          {
            "id": "toc:chapter-001",
            "order": 1,
            "title": "中国社会各阶级的分析",
            "targetId": "chapter:001"
          },
          {
            "id": "toc:chapter-001-background",
            "order": 2,
            "title": "写作背景",
            "targetId": "chapter:001",
            "anchorId": "anchor:background"
          }
        ]
      }
    ],
    "chapters": [
      {
        "id": "chapter:001",
        "order": 1,
        "title": "中国社会各阶级的分析",
        "body": {
          "format": "html",
          "profile": "jojo-semantic-html/1",
          "value": "<p>谁是我们的敌人？谁是我们的朋友？这个问题是革命的首要问题。<sup data-annotation-id=\"annotation:001\"></sup></p><h2 id=\"anchor:background\">写作背景</h2><p>正文示例……</p><figure data-asset-id=\"asset:image-001\"><figcaption>历史照片</figcaption></figure><figure data-asset-id=\"asset:audio-001\"><figcaption>文章朗读</figcaption></figure><figure data-asset-id=\"asset:video-001\"><figcaption>相关影像</figcaption></figure>"
        },
        "assetRefs": [
          "asset:image-001",
          "asset:audio-001",
          "asset:video-001"
        ]
      }
    ]
  },
  "assets": [
    {
      "id": "asset:cover",
      "type": "image",
      "role": "cover",
      "mediaType": "image/jpeg",
      "path": "assets/cover.jpg",
      "size": 428913,
      "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "width": 1200,
      "height": 1680,
      "alt": "毛泽东选集第一卷封面",
      "caption": null
    },
    {
      "id": "asset:image-001",
      "type": "image",
      "role": "content",
      "mediaType": "image/jpeg",
      "path": "assets/historical-photo.jpg",
      "size": 812430,
      "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "width": 1600,
      "height": 1067,
      "alt": "历史照片中的会议现场",
      "caption": "历史照片"
    },
    {
      "id": "asset:audio-001",
      "type": "audio",
      "role": "content",
      "mediaType": "audio/mpeg",
      "path": "assets/chapter-001-reading.mp3",
      "size": 6342881,
      "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "durationSeconds": 382.4,
      "title": "中国社会各阶级的分析朗读",
      "transcript": "朗读文本示例……"
    },
    {
      "id": "asset:video-001",
      "type": "video",
      "role": "content",
      "mediaType": "video/mp4",
      "path": "assets/context-video.mp4",
      "size": 18429382,
      "sha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "width": 1280,
      "height": 720,
      "durationSeconds": 96.2,
      "title": "历史背景影像",
      "posterAssetId": "asset:image-001",
      "transcript": "视频字幕示例……"
    },
    {
      "id": "asset:original-pdf",
      "type": "pdf",
      "role": "source",
      "mediaType": "application/pdf",
      "path": "assets/maozedong-xuanji-volume-1.pdf",
      "size": 86429103,
      "sha256": "5555555555555555555555555555555555555555555555555555555555555555",
      "pageCount": 352,
      "title": "原书 PDF"
    }
  ],
  "annotations": [
    {
      "id": "annotation:001",
      "targetId": "chapter:001",
      "kind": "footnote",
      "label": "1",
      "body": {
        "format": "text",
        "value": "本文写于一九二五年十二月一日。"
      }
    }
  ],
  "provenance": {
    "source": "weread",
    "sourceItemId": "3300024284",
    "importedAt": "2026-08-09T15:30:00+08:00",
    "importer": "jojo-weread-importer/0.1.0"
  },
  "extensions": {
    "weread": {
      "bookId": "3300024284",
      "sourceFormat": "weread-json"
    }
  }
}
```

`toc` 与 `chapters` 不重复：`toc` 只表达可嵌套的导航结构，`chapters` 保存实际内容。
一个章节可以被多个目录节点指向。`anchorId` 表示进入章节内部某个 HTML `id`；跳到章节开头时
省略它，不写 `"anchorId": null`。

### 8.1 浏览器交付 Manifest

Canonical Item 可以是完整文件，因为只有后台批处理会读取它。浏览器使用拆分后的
`manifest.jox`，其中章节只有摘要和对象地址：

```json
{
  "formatVersion": "jojo-item-manifest/1",
  "revision": 1,
  "itemId": "maozedong-xuanji:volume-1",
  "datasetId": "maozedong-xuanji",
  "type": "book-volume",
  "title": "毛泽东选集 第一卷",
  "language": "zh-CN",
  "metadata": {
    "authors": ["毛泽东"],
    "publisher": "人民出版社",
    "volumeNumber": 1,
    "totalVolumes": 4
  },
  "content": {
    "schema": "jojo-content/book/1",
    "toc": [
      {
        "id": "toc:chapter-001",
        "order": 1,
        "title": "中国社会各阶级的分析",
        "targetId": "chapter:001"
      }
    ],
    "chapters": [
      {
        "id": "chapter:001",
        "order": 1,
        "title": "中国社会各阶级的分析",
        "object": "chapters/n4D8sP2q.jox",
        "size": 18432,
        "sha256": "6666666666666666666666666666666666666666666666666666666666666666"
      }
    ]
  },
  "assets": [
    {
      "id": "asset:image-001",
      "type": "image",
      "mediaType": "image/jpeg",
      "object": "assets/v7K2mQ9x.jox",
      "size": 812430,
      "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "width": 1600,
      "height": 1067,
      "alt": "历史照片中的会议现场"
    },
    {
      "id": "asset:audio-001",
      "type": "audio",
      "mediaType": "audio/mpeg",
      "object": "assets/b3T8wR1c.jox",
      "size": 6342881,
      "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "durationSeconds": 382.4
    },
    {
      "id": "asset:video-001",
      "type": "video",
      "mediaType": "video/mp4",
      "object": "assets/y6H1pL4a.jox",
      "size": 18429382,
      "sha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "durationSeconds": 96.2,
      "posterAssetId": "asset:image-001"
    }
  ],
  "exports": [
    {
      "id": "export:epub",
      "format": "epub",
      "mediaType": "application/epub+zip",
      "fileName": "毛泽东选集 第一卷.epub",
      "object": "exports/r8V3kN6f.jox",
      "size": 12481293,
      "sha256": "7777777777777777777777777777777777777777777777777777777777777777"
    }
  ]
}
```

章节对象解码后是独立 Fragment：

```json
{
  "formatVersion": "jojo-fragment/1",
  "itemId": "maozedong-xuanji:volume-1",
  "fragmentId": "chapter:001",
  "type": "chapter",
  "order": 1,
  "title": "中国社会各阶级的分析",
  "body": {
    "format": "html",
    "profile": "jojo-semantic-html/1",
    "value": "<p>正文……<sup data-annotation-id=\"annotation:001\"></sup></p>"
  },
  "assetRefs": [],
  "annotations": [
    {
      "id": "annotation:001",
      "targetId": "chapter:001",
      "kind": "footnote",
      "label": "1",
      "body": {
        "format": "text",
        "value": "脚注正文……"
      }
    }
  ]
}
```

客户端下载整本 EPUB 时，不在浏览器中重新拼装章节。它直接请求 `exports` 中的 Jox，
解码成 EPUB bytes，创建 `Blob`，并以 `fileName` 下载。是否显示下载按钮只取决于 Manifest
是否存在相应 Export，不需要查询 ES。

## 9. 报纸完整示例

页面和文章分别保存，`placements` 是两者关系的唯一权威来源。Pages 和 Articles 不保存
反向引用。

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 2,
  "itemId": "rmrb:issue:1990-09-06:main",
  "datasetId": "rmrb",
  "type": "periodical-issue",
  "title": "人民日报 1990年9月6日",
  "language": "zh-CN",
  "identifiers": {
    "issn": "1672-8386"
  },
  "metadata": {
    "publicationType": "newspaper",
    "publishedDate": "1990-09-06",
    "editionCode": "main",
    "editionName": null,
    "issueNumber": null
  },
  "content": {
    "schema": "jojo-content/periodical-issue/1",
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
        "id": "page:06",
        "order": 6,
        "number": 6,
        "label": "第6版",
        "title": null,
        "assetRefs": ["asset:page-06"]
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
          "value": "<p>正文……</p><figure data-asset-id=\"asset:article-photo-001\"><figcaption>文章配图</figcaption></figure>"
        },
        "assetRefs": ["asset:article-photo-001"]
      }
    ],
    "placements": [
      {
        "id": "placement:0190b821",
        "pageId": "page:05",
        "articleId": "article:0190a4c7",
        "order": 1,
        "role": "start"
      },
      {
        "id": "placement:0190b822",
        "pageId": "page:06",
        "articleId": "article:0190a4c7",
        "order": 1,
        "role": "continue"
      }
    ]
  },
  "assets": [
    {
      "id": "asset:original-pdf",
      "type": "pdf",
      "role": "source",
      "mediaType": "application/pdf",
      "path": "assets/1990-09-06.main.pdf",
      "size": 18642913,
      "sha256": "8888888888888888888888888888888888888888888888888888888888888888",
      "pageCount": 8,
      "title": "人民日报原报 PDF"
    },
    {
      "id": "asset:page-05",
      "type": "image",
      "role": "page-facsimile",
      "mediaType": "image/jpeg",
      "path": "assets/page-05.jpg",
      "size": 2248913,
      "sha256": "9999999999999999999999999999999999999999999999999999999999999999",
      "width": 2480,
      "height": 3508,
      "alt": "人民日报1990年9月6日第5版版面"
    },
    {
      "id": "asset:page-06",
      "type": "image",
      "role": "page-facsimile",
      "mediaType": "image/jpeg",
      "path": "assets/page-06.jpg",
      "size": 2293011,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "width": 2480,
      "height": 3508,
      "alt": "人民日报1990年9月6日第6版版面"
    },
    {
      "id": "asset:article-photo-001",
      "type": "image",
      "role": "content",
      "mediaType": "image/jpeg",
      "path": "assets/article-photo-001.jpg",
      "size": 384291,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "width": 1200,
      "height": 800,
      "alt": "文章配图",
      "caption": "文章配图"
    }
  ],
  "annotations": [],
  "provenance": {
    "source": "peopledata",
    "sourceItemId": "rmrb-1990-09-06",
    "importedAt": "2026-08-09T12:00:00+08:00",
    "importer": "jojo-rmrb-importer/1.0.0"
  },
  "extensions": {
    "peopledata": {
      "originalDirectory": "1990-09-06"
    }
  }
}
```

Placement `role` v1 只允许：

- `complete`：全文都在该版。
- `start`：文章从该版开始。
- `continue`：文章在该版续接。

Placement ID 不得包含页码或顺序。修正页码、版次或排序时，Placement ID 保持不变。
运行时可以生成 page → articles 或 article → pages 索引，但不能把派生的双向引用写回标准文件。

报刊的交付 Manifest 保留 `pages` 和 `placements`，把每篇文章正文拆到
`articles/{random}.jox`。文章 Fragment 与书籍章节 Fragment 使用相同的
`jojo-fragment/1` 外壳，`type` 改为 `article`。

## 10. 杂志完整示例

杂志与报纸共用 `jojo-content/periodical-issue/1`，通过元数据、版面和 Asset 表达杂志特性。

```json
{
  "formatVersion": "jojo-item/1",
  "revision": 1,
  "itemId": "future-science:issue:2026-08:main",
  "datasetId": "future-science",
  "type": "periodical-issue",
  "title": "未来科学 2026年第8期",
  "language": "zh-CN",
  "identifiers": {
    "issn": "1234-5678"
  },
  "metadata": {
    "publicationType": "magazine",
    "publishedDate": "2026-08-01",
    "editionCode": "main",
    "editionName": "中文版",
    "volume": 12,
    "issueNumber": 8
  },
  "content": {
    "schema": "jojo-content/periodical-issue/1",
    "pages": [
      {
        "id": "page:cover",
        "order": 1,
        "number": null,
        "label": "封面",
        "title": null,
        "assetRefs": ["asset:cover"]
      },
      {
        "id": "page:012",
        "order": 12,
        "number": 12,
        "label": "12",
        "title": "专题",
        "assetRefs": ["asset:page-012"]
      }
    ],
    "articles": [
      {
        "id": "article:quantum-city",
        "order": 1,
        "title": "量子城市的一天",
        "subtitle": "从实验室到公共网络",
        "authors": ["李明", "王雪"],
        "body": {
          "format": "html",
          "profile": "jojo-semantic-html/1",
          "value": "<p>正文……</p><figure data-asset-id=\"asset:diagram-001\"><figcaption>量子网络示意图</figcaption></figure><figure data-asset-id=\"asset:interview-audio\"><figcaption>作者访谈音频</figcaption></figure><figure data-asset-id=\"asset:lab-video\"><figcaption>实验室演示视频</figcaption></figure>"
        },
        "assetRefs": [
          "asset:diagram-001",
          "asset:interview-audio",
          "asset:lab-video"
        ]
      }
    ],
    "placements": [
      {
        "id": "placement:quantum-city-01",
        "pageId": "page:012",
        "articleId": "article:quantum-city",
        "order": 1,
        "role": "complete"
      }
    ]
  },
  "assets": [
    {
      "id": "asset:cover",
      "type": "image",
      "role": "cover",
      "mediaType": "image/webp",
      "path": "assets/cover.webp",
      "size": 514203,
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "width": 1400,
      "height": 1900,
      "alt": "未来科学2026年第8期封面"
    },
    {
      "id": "asset:page-012",
      "type": "image",
      "role": "page-facsimile",
      "mediaType": "image/webp",
      "path": "assets/page-012.webp",
      "size": 821940,
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "width": 1800,
      "height": 2400,
      "alt": "未来科学2026年第8期第12页"
    },
    {
      "id": "asset:diagram-001",
      "type": "image",
      "role": "content",
      "mediaType": "image/svg+xml",
      "path": "assets/quantum-network.svg",
      "size": 18203,
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "width": 1200,
      "height": 720,
      "alt": "量子网络示意图",
      "caption": "量子网络示意图"
    },
    {
      "id": "asset:interview-audio",
      "type": "audio",
      "role": "content",
      "mediaType": "audio/mpeg",
      "path": "assets/interview.mp3",
      "size": 12491203,
      "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "durationSeconds": 745.8,
      "title": "作者访谈",
      "transcript": "访谈文字稿……"
    },
    {
      "id": "asset:lab-video",
      "type": "video",
      "role": "content",
      "mediaType": "video/mp4",
      "path": "assets/lab-demo.mp4",
      "size": 52491203,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "width": 1920,
      "height": 1080,
      "durationSeconds": 183.5,
      "title": "实验室演示",
      "posterAssetId": "asset:cover",
      "transcript": "演示视频字幕……"
    }
  ],
  "annotations": [],
  "provenance": {
    "source": "epub",
    "sourceItemId": "future-science-2026-08",
    "importedAt": "2026-08-09T14:00:00+08:00",
    "importer": "jojo-epub-importer/1.0.0"
  },
  "extensions": {
    "epub": {
      "packageVersion": "3.3",
      "originalFileName": "未来科学-2026-08.epub"
    }
  }
}
```

v1 可以把尺寸可控的视频作为一个 Jox 对象下载后用 Blob 播放。大型长视频不应强行整段加载；
后续可以在不改变 Asset ID 的前提下增加分片媒体交付 Profile。

## 11. 正文和注释

正文允许纯文本：

```json
{
  "format": "text",
  "value": "正文……"
}
```

也允许语义 HTML：

```json
{
  "format": "html",
  "profile": "jojo-semantic-html/1",
  "value": "<p>正文……</p>"
}
```

`jojo-semantic-html/1` v1 允许的元素：

```text
p h1 h2 h3 h4 h5 h6
blockquote ol ul li
strong em sup sub
a br hr
figure figcaption
```

允许的属性：

```text
id href data-asset-id data-annotation-id
```

必须禁止：

- `script`、`iframe`、`style`。
- `class`、内联 `style`、`on*` 事件属性。
- 外部 CSS 和 `javascript:` URL。
- 未经清洗的 SVG 脚本或其他主动内容。

JSON Schema 只能检查 Profile 名称，不能可靠验证 HTML 安全性。发布工具必须另行维护
语义 HTML 清洗和校验器。

正文中的图片、音频和视频位置统一使用：

```html
<figure data-asset-id="asset:image-001">
  <figcaption>图片说明</figcaption>
</figure>
```

Reader 根据 Asset 的 `type` 和 `mediaType` 渲染对应组件。微信读书导出的脚注小图标、
HTML 导出器的 CSS 和弹窗脚本属于来源 UI，不作为书籍 Asset；导入时应转换成 Annotation，
由 Reader 自己渲染脚注标记和弹层。

脚注的 `label` 必须恢复来源实际显示规则，不能简单使用“本章提取到的第几个 Annotation”。
例如篇名后的编者注通常显示为 `*`，不占正文注〔1〕的数字序号；同一个源文件包含多篇文章时，
数字序号在每篇文章重新开始。跨卷引用（如“见第一卷《某文》注〔3〕”）应先用目录标题确定
目标文章，再在该文章范围内按正文脚注落点解析第 3 个数字注，不能依赖整个章节数组位置。

Annotation 可选 `anchorId`，用于只有段落级定位但没有内联标记的来源：

```json
{
  "id": "annotation:002",
  "targetId": "chapter:001",
  "anchorId": "anchor:paragraph-03",
  "kind": "editor-note",
  "body": {
    "format": "text",
    "value": "编者注……"
  }
}
```

没有精确锚点时省略 `anchorId`，表示 Annotation 针对整个 `targetId`。

## 12. Assets 和可搜索文本

Asset 描述符至少包含：

- 稳定 `id`。
- `type`：`image`、`audio`、`video` 或 `pdf`。
- 原始 `mediaType`、字节数 `size` 和原始字节的 `sha256`。
- Canonical 中的 `path`，或 Delivery Manifest 中的 `object`。
- 该媒体适用的尺寸、时长、替代文本、说明和文字稿。

ES 只索引可搜索文本：图片的 `alt`、`caption`、OCR，音频和视频的 transcript，PDF 的
OCR 或文本层。媒体二进制始终保留在对象存储，不写入 JSON 或 ES。

## 13. Jox 交付对象

Jox 是交付容器，不是新的业务数据模型。`.jox` 解码后可能是 JSON、JPEG、MP3、MP4、
PDF 或 EPUB。

v1 交付约定：

1. JSON 先以 UTF-8 编码并 gzip，再应用 Jox 字节变换。
2. 媒体和 Export 对原始 bytes 应用与对象相关的可逆字节变换。
3. PDF 使用保持字节长度和 Range offset 的 Profile，以继续支持按需 Range 请求。
4. 子对象使用随机文件名，业务关系通过 Manifest 中的稳定 ID 建立。
5. Manifest 记录解码后 payload 的 `mediaType`、`size` 和 `sha256`。
6. 客户端不得把通过扩展名猜测媒体类型作为唯一判断依据。

Jox 的目标是阻止直接打开 B2 URL、顺序枚举和最简单的批量下载。因为浏览器最终必须能够
解码，它不能阻止有能力分析客户端的抓取者。真正的访问保护仍依赖 Private origin、CDN
源站鉴权、限速、签名、WAF 和异常流量检测。

具体字节算法应作为独立 `jojo-jox/1` Profile 实现，并提供固定测试向量。不要把当前 PDF
固定 seed 不加区分地复制给所有对象；新实现至少应让不同对象产生不同的字节流。

## 14. 发布和缓存

发布一次更新时按以下顺序执行：

1. 从 Canonical 生成新的章节、文章、Asset 和 Export Jox 对象。
2. 上传随机命名且不可变的子对象。
3. 上传引用这些子对象的新 Item `manifest.jox`。
4. 最后更新 Dataset `index.jox`；新增 Dataset 时再更新 `catalog.jox`。
5. 验证 CDN 解码、SHA-256、引用完整性和 Range 行为。
6. 经过安全保留期后清理不再引用的旧对象。

随机子对象可以设置长缓存。`catalog.jox`、`index.jox`、Availability 和 Manifest 使用短缓存，
或在发布后精确 purge。v1 不使用 `latest.json` 和 `releases/{version}/` 多层目录。

## 15. 修改记录

Canonical Dataset 可以维护 `changes.jsonl` 作为审计账本。当前 Canonical Item 始终是真值，
Change 不是完整事件数据库。

```json
{"changeId":"chg-000001","sequence":1,"transactionId":"tx-000001","changedAt":"2026-08-09T12:00:00+08:00","itemId":"rmrb:issue:1990-09-06:main","targetId":"article:0190a4c7","fromRevision":1,"toRevision":2,"operation":"replace","path":"/title","before":"旧标题","after":"正确标题","evidence":[{"assetId":"asset:original-pdf","page":5}],"method":"manual-verified"}
```

应用规则：

- Change 应用器先根据 `itemId` 加载 Item。
- `targetId === itemId` 时修改 Item 本身；否则必须在 Item 内恰好匹配一个对象。
- `path` 是相对于 Target 的 JSON Pointer，不能使用易受数组排序影响的全局位置。
- `sequence` 在发布 Dataset 版本时统一分配，并在整个 Dataset 内单调递增；并行导入器不永久分配它。
- 跨 Item 修复写多条 Change，并用同一 `transactionId` 关联。
- 大段正文修改只记录修改前后 SHA-256、字符数和摘要，不在日志中复制两份全文。
- 待执行修改使用单独 Patch 文件；完整回滚依赖 Canonical/B2 历史版本。

## 16. ES 和数据库边界

阅读链路不查询 ES 或数据库：

```text
catalog.jox
  → Dataset index.jox
  → Item manifest.jox
  → 当前 chapter/article/asset Jox
```

ES 只提供全文搜索、聚合和 RAG 检索。ES 是可丢弃的派生数据：重建程序读取从 Canonical
生成的 `search/documents.jsonl.gz`，写入新索引并在验证后切换搜索配置。普通 ES 可以按稳定
`documentId` 覆盖并按 `datasetId` 清理旧文档。腾讯云 ES Serverless 只允许 `create`，因此
每次构建写成不可变 `releaseId`，并额外保存 `datasetFilterKey`、`itemFilterKey` 两个
SHA-256 精确过滤键；SCF 必须配置当前 `ELASTICSEARCH_CONTENT_RELEASE_ID`。半成品 release
不得续写，应更换空索引重新发布。搜索不可用时，目录浏览、阅读和下载仍然可用。

## 17. 验证要求

正式发布器至少执行三层验证：

1. JSON Schema：检查 Catalog、Dataset、Item、Manifest、Fragment、Availability 和 Change。
2. 语义 HTML：清洗标签、属性、URL 和 SVG，验证所有 Anchor、Asset、Annotation 引用。
3. 关系完整性：验证 ID 唯一、TOC target、Placement、Asset ref、revision、editionCode 和哈希。

建议的 Schema 文件：

```text
schemas/
├─ catalog-v1.schema.json
├─ dataset-v1.schema.json
├─ availability-v1.schema.json
├─ item-v1.schema.json
├─ item-manifest-v1.schema.json
├─ fragment-v1.schema.json
└─ change-v1.schema.json
```

Schema 与数据分离。来源私有字段只放进来源命名空间，例如：

```json
{
  "extensions": {
    "weread": {},
    "epub": {},
    "peopledata": {}
  }
}
```

标准 Reader、搜索和 RAG 不依赖 `extensions`；只有对应导入器理解它们。

## 18. 已实现的操作流程

本地导入和验证：

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input "C:\Users\YOUR_NAME\Downloads" `
  --output "C:\path\to\build"
pnpm --filter @jojo/content-pipeline validate -- "C:\path\to\build"
```

也可以启动 Data Workbench，在 `/content` 选择本地 JSON/目录，观察解析诊断和统计后分别发布
B2、Elasticsearch、Hugging Face。B2 发布顺序固定为 Raw → Canonical → 内容/Asset →
Manifest → Dataset index → Catalog，`catalog.jox` 是最终提交标志。

Hugging Face 保存私有 Canonical 镜像，Dataset/Item JSON 保持可直接浏览和按书下载。为避免
数千张小图逐文件上传触发 Hub API 限流，每个 Dataset 的媒体合并为一个 `assets.tar`；归档内
仍使用 Item 所引用的 `assets/<sha256>.<ext>` 路径。B2/CDN 继续保存浏览器直接读取的独立媒体
对象，HF 不参与 Reader 在线加载。

Reader 只设置 `VITE_CONTENT_CDN_BASE`，直接从 CDN 读取目录、正文、媒体和 EPUB。Agent 设置：

```text
JOJO_CONTENT_SEARCH_URL=https://<search-service>/content/search
JOJO_CONTENT_CDN_BASE=https://<delivery-cdn>/
```

Agent 的 `search_content` 先定位 ES 片段，`read_fragment` 读取一个完整章节；考虑全本时先用
`inspect_item` 从小型 Manifest 获取章节数、字符数、预计处理量和预算。只有跨章归纳、全书
统计或证据不足且未超预算时才调用 `scan_full_item`。全书扫描发生在工具侧，只向模型返回计数
和少量证据，不把整本正文塞进上下文；结果另行报告实际 CDN 下载字节数。可用以下命令做不
依赖模型的联通测试：

```powershell
$env:JOJO_CONTENT_SEARCH_URL="http://127.0.0.1:9000/content/search"
$env:JOJO_CONTENT_CDN_BASE="https://blacknews.jojokanbao.cn/"
$env:JOJO_CONTENT_DATASET_ID="book-9d0833b0a40c"
$env:JOJO_CONTENT_ITEM_ID="book-9d0833b0a40c:main"
$env:JOJO_CONTENT_SMOKE_FULL_SCAN="true"
pnpm --filter @jojo/agent content:smoke -- "童年时代"
```

完成 Codex OAuth 后，可把真实模型、ES 和 B2/CDN 一起验证：

```powershell
pnpm --filter @jojo/agent rag:smoke -- "《毛泽东自述》的童年时代主要讲了什么？"
```

2026-08-09 的全量微信读书样本验收覆盖 76 个受支持文件（按 Book ID 去重为 74 本）、
55 个 Dataset、113 个 Item、7,013 个章节、9,704 个 Asset 引用、13,077 个 Annotation 和
32,281 个 ES 检索片段。4 个非微信读书 JSON 被明确跳过，2 个来源记录因缺失加密片段而保留诊断；
其余内容、媒体引用、EPUB ZIP、Jox 哈希和对象引用验证均通过。
