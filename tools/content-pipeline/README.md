# JOJO Content Pipeline

把微信读书 WRX JSON 导入统一 JOJO v1，并一次生成 Raw、Canonical、Delivery Jox、EPUB、
Hugging Face 镜像和 Elasticsearch JSONL。

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input "C:\Users\YOUR_NAME\Downloads" `
  --output "C:\path\to\build"
pnpm --filter @jojo/content-pipeline validate -- "C:\path\to\build"
```

输出根目录包含 `raw/`、`canonical/`、`delivery/`、`huggingface/`、`search/` 和
`report.json`。导入器按来源 Book ID 去重；只有章节标题能够证明全部卷次边界时才拆成多个
`book-volume` Item，否则保留单一 `main` 并输出诊断，避免按书名猜卷。

导入前会用章节 CID 对照微信读书 TOC，检查应有正文数、实际匹配数和缺失章节。默认模式下
缺少正文或章节解码失败都会拒绝该源文件；只有显式传入 `--allow-partial` 才会生成部分数据并
在 `report.json` 中保留 warning。多个导出具有同一 Book ID 时，优先选择章节覆盖率更高的
版本，再比较导出时间。

图片、音频和视频会下载为外部 Asset；正文只保留稳定 Asset ID。下载失败会产生 warning，
不会写入悬空引用。每个 Item 预生成整本 EPUB，浏览器下载时不依赖 ES、数据库或服务端拼装。
