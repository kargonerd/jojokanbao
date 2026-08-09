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

图片、音频和视频会下载为外部 Asset；正文只保留稳定 Asset ID。下载失败会产生 warning，
不会写入悬空引用。每个 Item 预生成整本 EPUB，浏览器下载时不依赖 ES、数据库或服务端拼装。
