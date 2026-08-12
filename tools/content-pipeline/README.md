# JOJO Content Pipeline

把微信读书 WRX JSON、EPUB，以及无 DRM 的 MOBI 6/7（`.azw`、`.mobi`、`.prc`）导入统一 JOJO v1，并一次生成 Raw、Canonical、Delivery Jox、EPUB、
Hugging Face 镜像和 Elasticsearch JSONL。

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input-dir "C:\Users\YOUR_NAME\Downloads" `
  --output "C:\path\to\build"
pnpm --filter @jojo/content-pipeline validate -- "C:\path\to\build"
```

`--input-dir` 会递归扫描子目录，适合直接从 B2 Raw 的本地镜像重建完整馆藏。
迁移或灾备重建时可以使用 `--asset-cache <旧 canonical 目录>`，按原始 `sourceUrl` 复用本地
已下载媒体；缓存没有命中的资源仍会从来源地址获取。

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
部分 EPUB 会把一章拆成大量很小的 spine 文件；当这种碎片特征足够明确时，导入器按 EPUB
目录边界合并为逻辑章节，同时为原目录目标保留正文锚点。OPF 作者等元数据明显无效时，才会
从规范的电子书文件名回退，原值保留在来源扩展信息中供审计。
EPUB 跨 XHTML 的脚注链接会转换为 Item 内的 `annotations`，脚注文件不再生成伪章节；无法
转换的相对文件链接会去除跳转能力，避免 Reader 把 EPUB 文件名误当成 Item ID。`Image` 等
无意义图片替代文字不会显示为图注。

来源 HTML 的 `class` 不会原样进入 JOJO。导入器会把可验证的通用语义归一化：粗体、斜体、
上下标、下划线和删除线使用标准 HTML；引文、诗歌、译文、编者注、无缩进、对齐和受控字体
使用 `jojo-semantic-html/1`；图片说明并入 `figcaption`。`h-pic`、`s-pic` 等嵌在句子或
公式里的小图片保持为行内 Asset，不会被提升成独立大图。未识别的来源 class 和 CSS 仍会
删除，避免把某个出版社的样式系统变成格式依赖。

纯文本来源中的数字注号只有在正文标记与注释定义能够可靠配对时才会转换成
`annotations`；`*这是……` 一类篇名编者注会转换成 `editor-note`。无法可靠配对的
`*[1][2]` 等标记原样保留，并写入诊断，不会静默删改。Kindle 加密文件和 KF8/AZW3 会明确
拒绝；导入器不包含 DRM 绕过逻辑。
