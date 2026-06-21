# JOJO Press Import Package Spec

`jojo-rag` 通过 source 级导入包接收 `jojo-press` 产出的校对后文档。导入包是一个 zip 文件，根目录必须包含 `manifest.json`。

## 设计目标

- 以 source 为边界导入，不引入新的 book 实体。
- 同时支持结构化阅读和当前整本文档兼容链路。
- 便于未来扩展目录、注解、阅读偏好、问答索引元数据。

## 包结构

```text
book-package.zip
├── manifest.json
├── chapters/
│   ├── 01-preface.md
│   └── 02-main.md
├── annotations/
│   └── notes.json
└── assets/
    └── cover.png
```

## manifest.json

### 必填字段

- `schema_version`: 当前推荐值 `1.0`
- `title`: 书名/文档标题
- `chapters`: 章节数组，至少 1 项

### 推荐字段

- `description`: 文档摘要
- `toc`: 结构化目录
- `assets`: 资源列表
- `annotations`: 内联注解数组
- `annotation_files`: 外部注解 JSON 列表
- `reader_config`: 阅读默认配置
- `extensions`: 扩展字段

### 示例

```json
{
  "schema_version": "1.0",
  "title": "毛泽东文稿示例",
  "description": "用于验证 jojo-rag 导入链路的 mock 文档。",
  "chapters": [
    {
      "id": "preface",
      "title": "序章",
      "order": 1,
      "path": "chapters/01-preface.md",
      "summary": "交代文档背景。"
    },
    {
      "id": "chapter-1",
      "title": "第一章",
      "order": 2,
      "path": "chapters/02-main.md",
      "summary": "正文与资源引用示例。"
    }
  ],
  "toc": [
    { "id": "preface", "title": "序章", "chapter_id": "preface", "level": 1, "order": 1 },
    { "id": "chapter-1", "title": "第一章", "chapter_id": "chapter-1", "level": 1, "order": 2 }
  ],
  "assets": [
    {
      "path": "assets/cover.png",
      "name": "cover.png",
      "label": "封面图",
      "content_type": "image/png"
    }
  ],
  "annotation_files": [
    "annotations/notes.json"
  ],
  "reader_config": {
    "font_size": 18,
    "line_height": 1.8,
    "content_width": "760px",
    "theme": "paper"
  },
  "extensions": {
    "qa_index": {
      "enabled": false
    }
  }
}
```

## chapters[]

每个章节对象字段：

- `id`: 章节唯一标识
- `title`: 章节标题
- `order`: 排序号
- `path`: zip 内 markdown 相对路径
- `summary`: 可选摘要

Markdown 中引用资源时，推荐使用相对路径，例如：

```md
![封面](../assets/cover.png)
```

导入时 `jojo-rag` 会上传资源并将章节中的相对资源链接改写为可访问 URL。

## toc[]

如果提供，`jojo-rag` 优先使用 `toc` 作为阅读器目录。若未提供，则按 `chapters[]` 自动生成一级目录。

每项建议字段：

- `id`
- `title`
- `chapter_id`
- `level`
- `order`

## annotations

可以直接内联在 `manifest.json` 的 `annotations` 中，也可以通过 `annotation_files` 指向外部 JSON 文件。最终都应解析为数组。

每项建议字段：

- `id`
- `chapter_id`
- `anchor`
- `quote`
- `note`
- `tags`

## reader_config

`reader_config` 只描述默认阅读偏好，不强制覆盖用户本地设置。当前支持字段：

- `font_size`
- `line_height`
- `content_width`
- `theme`

## 导入后的消费方式

导入成功后，`jojo-rag` 会：

1. 解析 `manifest.json`
2. 上传 `assets/**`
3. 重写章节中的资源 URL
4. 生成结构化 `toc` / `chapters` / `annotations` / `reader_config`
5. 聚合所有章节为整本 Markdown，并继续绑定到现有 source 文档链路

因此：

- 阅读器可以按章节读取
- 现有整篇 markdown 与 analysis 接口仍可工作
- 老 source 仍可继续使用 Markdown 直传

## 校验规则

以下情况应视为导入失败：

- zip 内缺少 `manifest.json`
- `manifest.json` 不是合法 JSON
- `schema_version` 缺失
- `title` 缺失
- `chapters` 不是数组或为空
- 任一章节缺少 `path`
- `path` 指向不存在文件
- `assets[].path` 指向不存在文件

## 向后兼容

- 新字段应优先加到 `extensions` 或对象的可选字段中，不要破坏既有字段含义。
- `jojo-rag` 当前按 source 边界消费包，不支持一个包直接生成多个 source。
- 如果将来需要问答索引、段落锚点、分页信息，优先作为扩展字段加入，不改变 `chapters[]` 的基本结构。
