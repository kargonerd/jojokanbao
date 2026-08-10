# JOJO Content Pipeline

把微信读书 WRX JSON、EPUB，以及无 DRM 的 MOBI 6/7（`.azw`、`.mobi`、`.prc`）导入统一 JOJO v1，并一次生成 Raw、Canonical、Delivery Jox、EPUB、
Hugging Face 镜像和 Elasticsearch JSONL。

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input "C:\Users\YOUR_NAME\Downloads" `
  --output "C:\path\to\build"
pnpm --filter @jojo/content-pipeline validate -- "C:\path\to\build"
```

输出根目录包含 `raw/`、`canonical/`、`delivery/`、`huggingface/`、`search/` 和
`report.json`。导入器按来源 Book ID 去重；只有章节标题能够证明全部卷次边界时才拆成多个
`book-volume` Item，否则保留单一 `full-book` 并输出诊断，避免按书名猜卷。Raw 书籍按
`书名--来源ID.扩展名` 平铺；Canonical 只保存 `dataset.json`、`items/` 和 `assets/`，不上传
目录或 ES 搜索副本；Delivery 按 `content/books/`、`content/newspapers/` 和
`content/magazines/` 分类。

导入前会用章节 CID 对照微信读书 TOC，检查应有正文数、实际匹配数和缺失章节。默认模式下
缺少正文或章节解码失败都会拒绝该源文件；只有显式传入 `--allow-partial` 才会生成部分数据并
在 `report.json` 中保留 warning。多个导出具有同一 Book ID 时，优先选择章节覆盖率更高的
版本，再比较导出时间。

图片、音频和视频会下载为外部 Asset；正文只保留稳定 Asset ID。下载失败会产生 warning，
不会写入悬空引用。每个 Item 预生成整本 EPUB，浏览器下载时不依赖 ES、数据库或服务端拼装。

纯文本来源中的数字注号只有在正文标记与注释定义能够可靠配对时才会转换成
`annotations`；`*这是……` 一类篇名编者注会转换成 `editor-note`。无法可靠配对的
`*[1][2]` 等标记原样保留，并写入诊断，不会静默删改。Kindle 加密文件和 KF8/AZW3 会明确
拒绝；导入器不包含 DRM 绕过逻辑。
