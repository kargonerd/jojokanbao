# JOJO Content Pipeline

把微信读书 WRX JSON、EPUB，以及无 DRM 的 MOBI 6/7（`.azw`、`.mobi`、`.prc`）导入统一 JOJO v1，并一次生成 Raw、Canonical、Delivery Jox、EPUB、
Hugging Face 镜像和 Elasticsearch JSONL。

```powershell
pnpm --filter @jojo/content-pipeline cli -- `
  --input-dir "C:\Users\YOUR_NAME\Downloads" `
  --output "C:\path\to\build"
pnpm --filter @jojo/content-pipeline validate -- "C:\path\to\build"
```

单本 EPUB 也可使用 `--input "C:\path\to\book.epub"`，输出目录必须为空。
PDF 先由外部制作工具转成 EPUB，再通过同一入口导入；JOJO 不再提供 Press 制作工作台。
图形界面使用 [JOJO 管理台](../jojo-admin/README.md) 的 `/content` 页面，可选择本机路径或
上传 EPUB，查看任务诊断后再发布。管理台调用同一管线，上传时保留中文文件名并隔离同名文件；
输出目录、部分导入等高级选项使用命令行。

EPUB 导入支持 EPUB 2 NCX / EPUB 3 nav 多级目录、无链接的目录分组、中文和 URL 编码路径、
包文档命名空间前缀、封面与内嵌图片。目录和正文内链保留精确锚点，合并碎片正文时会给
各源文件的锚点加前缀，避免同名 ID 跳错位置。表格保留单元格与合并关系，基础 MathML
公式进入阅读器、搜索和导出的 EPUB；不复刻出版社的完整 CSS 或固定版式。

同页脚注、跨文件脚注以及 manifest 中的独立尾注文件都可转成 `annotations`。
注号保留原标记（包括圈号、星号）；未引用的注释保留正文。含图片、表格或公式的复杂注释
保持为可跳转的正文内容，因为 v1 注释弹窗使用纯文本，不能丢弃其中的结构或资源。

默认拒绝正文缺失、失效目录和缺失内嵌资源；错误详情写入 `report.json`。
正文内链的目标无法确认时，保留编号、文字、格式和返回锚点，取消点击跳转并记录 warning；
不会因另一章恰好存在同名 ID 就自动配对。拆卷后会再次核对目标范围，已有注释的稳定 ID
也可作为跳转目标。重复源 ID 会分配唯一名称，保留同一源文档中首个位置的链接关系。
`--allow-partial` 可显式导入能够恢复的部分并保留 warning；`--no-assets` 表示主动只取文字。
损坏的 ZIP、无效 spine 和加密正文会明确报错。无法可靠配对的纯文本注号保留原文并提示，
不会猜测注释对应关系。`validate` 会核对产物校验和、目录/内链锚点、注释归属和资源引用。

`--input-dir` 会递归扫描子目录，适合直接从 B2 Raw 的本地镜像重建完整馆藏。
迁移或灾备重建时可以使用 `--asset-cache <旧 canonical 目录>`，按原始 `sourceUrl` 复用本地
已下载媒体；缓存没有命中的资源仍会从来源地址获取。

输出根目录包含 `raw/`、`canonical/`、`delivery/`、`huggingface/`、`search/` 和
`report.json`。导入器按来源 Book ID 去重；只有章节标题能够证明全部卷次边界时才拆成多个
`book-volume` Item，否则保留单一 `full-book` 并输出诊断，避免按书名猜卷。Raw 书籍按
`书名--来源ID.扩展名` 平铺；Canonical 只保存 `dataset.json`、`items/` 和 `assets/`，不上传
目录或 ES 搜索副本；Delivery 按 `content/books/`、`content/newspapers/` 和
`content/magazines/` 分类。

Delivery `catalog.jox` 的 Dataset 条目使用 `aiEnabled` 声明是否能够进入 AI
检索范围。只有显式的 `true` 才表示支持；字段缺失或 `false` 都按不支持处理。
书籍流水线会在 catalog、Dataset index 和 Canonical Dataset 中写入
`aiEnabled: true`。合并 Delivery 时不会根据 Dataset 类型推断或改写该字段。

导入前会用章节 CID 对照微信读书 TOC，检查应有正文数、实际匹配数和缺失章节。默认模式下
缺少正文或章节解码失败都会拒绝该源文件；只有显式传入 `--allow-partial` 才会生成部分数据并
在 `report.json` 中保留 warning。多个导出具有同一 Book ID 时，优先选择章节覆盖率更高的
版本，再比较导出时间。

仅用于定位的页码锚点保留 ID 和正文，不作为可点击链接着色。叶子 `div` 段落及相邻注释
保留各自的段落边界；星号开头的编辑标记结合来源注释标识、链接和日期格式判断，避免将
普通正文误移入注释。章节响应中的上游错误和无效 UTF-8 会明确报错。

图片、音频和视频会下载为外部 Asset；正文只保留稳定 Asset ID。下载失败会产生 warning，
不会写入悬空引用。每个 Item 预生成整本 EPUB，浏览器下载时不依赖 ES、数据库或服务端拼装。
导出 EPUB 时按 DOM 结构替换图片占位符，保留旧数据容器内的正文、图注、嵌套图片和锚点；
自动注释保留附带文字，并生成有效的同章、跨章跳转，避免嵌套链接。
部分 EPUB 会把一章拆成大量很小的 spine 文件；当这种碎片特征足够明确时，导入器按 EPUB
目录边界合并为逻辑章节，同时为原目录目标保留正文锚点。OPF 作者等元数据明显无效时，才会
从规范的电子书文件名回退，原值保留在来源扩展信息中供审计。
EPUB 跨 XHTML 的纯文本脚注链接会转换为 Item 内的 `annotations`；只包含已转换注释的文件不再生成伪章节，
含未引用注释或复杂注释的正文继续保留。目录
章节等正文内链会解析为稳定的章节 ID 和正文锚点，并记录识别数、成功数及无法解析的具体目标。
Reader 不依赖 EPUB 文件名即可精确跨章节跳转。`Image` 等
无意义图片替代文字不会显示为图注。

来源 HTML 的 `class` 不会原样进入 JOJO。导入器会把可验证的通用语义归一化：粗体、斜体、
上下标、下划线和删除线使用标准 HTML；引文、诗歌、译文、编者注、无缩进、对齐和受控字体
使用 `jojo-semantic-html/1`；书信、署名、标注、显式分页以及封面、全幅图、表格图也会转换成
受控语义；图片说明并入 `figcaption`。`h-pic`、`s-pic` 等嵌在句子或公式里的小图片保持为
行内 Asset，不会被提升成独立大图。`fnContent-*` 等可可靠配对的来源尾注会和正文标记一起
转换成 `annotations`。未识别且没有独立语义的来源 class 和 CSS 仍会删除，避免把某个
出版社的样式系统变成格式依赖。

导入时在完成来源完整性检查后，排除标题为“版权信息”或“版权页”的独立章节及对应目录项，
兼容空白和繁体写法。其余章节的 ID、顺序、正文、书籍元数据和原始 Raw 文件保留。清洗发生
在生成 Canonical、阅读 Jox、EPUB 和搜索数据之前。既有馆藏应从已发布内容更新这些产物，
保留人工合并和分卷结果，避免重新导入旧 Raw 覆盖馆藏调整。

纯文本来源中的数字注号只有在正文标记与注释定义能够可靠配对时才会转换成
`annotations`；`*这是……` 一类篇名编者注会转换成 `editor-note`。无法可靠配对的
`*[1][2]` 等标记原样保留，并写入诊断，不会静默删改。Kindle 加密文件和 KF8/AZW3 会明确
拒绝；导入器不包含 DRM 绕过逻辑。
