# JOJO 管理台

Internal JOJO management application for PDF intake, publication data generation,
append-only Elasticsearch repairs, feature flags, and Agent operations.

The product UI and internal package are both named **JOJO 管理台**, covering content operations, search maintenance,
and runtime feature rules. `/content` is the JOJO v1 content importer and publisher. It accepts local
WeRead WRX JSON, EPUB, and DRM-free MOBI 6/7 (`.azw`, `.mobi`, `.prc`) through a
single-file picker. It runs the same [Content Pipeline](../content-pipeline/README.md),
shows background job progress and diagnostics, then publishes Canonical data to
Hugging Face and Delivery objects to B2, then indexes the published books from that exact HF revision with the unified ES synchronizer.
By default, a WeRead source is rejected when its declared TOC is truncated,
TOC chapter responses are missing, or any response cannot be decoded.
EPUB imports also reject missing spine content, invalid navigation,
and missing embedded resources when asset import is enabled. Corrupt ZIPs, invalid
spines, and encrypted content produce explicit errors. Unpaired plain-text note
markers remain in the text with warnings; rich notes remain linked content.

浏览器导入入口为 `http://127.0.0.1:4174/content`（`pnpm dev:admin`）或
`http://127.0.0.1:5000/content`（`server/start.bat`）。点击“选择电子书文件”，每次选择一本，
确认文件名及选项后点击“开始处理”。页面不提供目录选择、路径输入或多文件选择；取消选择不会报错。
上传会保留中文文件名供元数据回退，
同名文件分目录暂存。任务生成后先查看诊断，再点击“打开阅读预览”，检查目录、正文、图片和脚注；
支持分卷选择、章节跳转和上一章 / 下一章。预览读取本机生成的 Reader 文件，草稿及登录可读的书籍
也可直接检查，不依赖 HF / B2 配置。页面按“选择文件 → 处理与预览 → 设置发布 → 查看结果”四步操作，
每次只显示当前步骤。导入始终先生成本地草稿；预览页可直接进入同一本书的发布设置。
第三步选择草稿或发布到馆藏、阅读门槛及上传目标，确认后才上传。导入和预览都不会自动发布。
结果页分别显示每个目标的进度、成功时间或失败原因，以及 B2 最后一次确认同步的馆藏状态。
“上传完成”不等于书籍已公开：草稿会明确显示“不在馆藏展示”。
点击“修改发布设置”可在草稿和发布之间切换，再“保存设置并同步”，无需重新导入；
修改时需同时选择此前尝试上传的目标，避免副本状态不一致。设置不变时可只重试失败目标。
“最近导入”可恢复最近 20 个本机任务；刷新页面保留当前书籍与步骤。上传中禁止重复提交，
管理台重启中断的上传可重试。HF/B2 成功后自动同步本次书籍到 ES，结果页显示新增/已有章节数、失败原因并支持单独重试。草稿不新增索引，检索范围根据馆藏下架状态排除；存量 ES 内容冲突通过 ES repair 处理。
EPUB 自动归入“网友分享”书源，需登录并在资料库设置中开启该书源；其他格式默认 JOJO书库。
同一本书再次导入后，旧任务会标为“旧版本”并链接到新任务，不能再覆盖发布。
B2 上传后会刷新当前书籍的 manifest、书目索引和 `catalog.jox`，再从公开 CDN
读取并核对本次书籍的内容、发布状态和阅读门槛；缓存未更新时显示失败并允许重试。
这些可变元数据使用 `public, max-age=0, must-revalidate` 缓存策略。
EdgeOne 的现有可变元数据规则还需覆盖 `content/books/<dataset>/index.jox` 和
`content/books/<dataset>/items/<item>/manifest.jox`：浏览器缓存为 0 秒，边缘缓存为 60 秒，
发布时主动刷新。否则域名默认的十天浏览器缓存会掩盖已成功上传的书籍状态变化。
刷新复用仓库的 EdgeOne 工具、`EDGEONE_ZONE_ID` 和腾讯云环境凭证；未配置环境凭证时
使用已有 `tccli` 登录，避免另存密钥。首次使用须确保该登录具有对应站点的缓存刷新权限。
预览用于核对生成内容；正文和标题脚注复用正式阅读器的渲染逻辑，但管理台的页面布局、字号、
行距和注释区域样式独立，不能作为正式阅读器最终排版的完全一致预览。
管理台默认严格导入，不提供部分导入开关；确需恢复部分内容时使用 Content Pipeline 的
`--allow-partial` 并检查 `report.json`。关闭资源导入表示主动只取文字。
PDF 书籍先通过外部工具转换为 EPUB；Press 已移除，现有 `/pdf` 报刊 PDF 工作流继续独立使用。

## Structure

- `web/` — React 19 client, registered in the pnpm workspace as `@jojo/admin`.
- `server/` — Flask APIs, PDF processing pipeline, storage adapters, and local
  ES migration files.

## Run

From the repository root:

```bash
pnpm dev:admin
```

功能开关页面位于 `http://127.0.0.1:4174/features`。它只通过同机 Flask
服务访问 Supabase：Flask 从仓库根目录 `.env` 读取现有的
`JOJO_OPERATOR_TOKEN`，浏览器不接收、不保存这个密钥，也不需要单独登录。

限额、阈值、超时等运行参数也在这个页面管理，复用同一 flag 的 `config`、发布原因、
修改历史与回滚。`ai.usage_limits` 提供每分钟次数、每日次数和单次生成时限输入；
`reader.annotations` 提供公开划线阈值输入。后续同类参数优先扩展现有入口，
存储边界和接入步骤见 [运行配置复用](../../infrastructure/supabase/README.md#runtime-configuration-reuse)。

评论审核页面位于 `http://127.0.0.1:4174/moderation`。它复用同一个
`JOJO_OPERATOR_TOKEN`，读取读者举报并支持隐藏、恢复评论或驳回举报；每次操作
必须填写理由，数据库会保留审核事件。管理员 token 始终只由同机 Flask 代理读取。

首次启用功能开关管理时，需要在目标 Supabase 项目中执行已评审的迁移，并按
`infrastructure/supabase/README.md` 将同一个 Operator Token 的摘要写入数据库。

Agent 管理页面位于 `http://127.0.0.1:4174/agent`。设置
`JOJO_CODEX_AUTH_PATH` 或 `JOJO_AGENT_AUTH_PATH` 时，本机 Flask 只读取指定路径
（两者同时设置时前者优先）；均未设置时只读取仓库内的 `agent/auth.json`。管理台不会回退读取当前用户的 `~/.codex/auth.json`，避免与
Codex CLI 或其他本地会话共享 refresh token。可先运行
`pnpm --filter @jojo/agent auth:codex` 或 `pnpm --filter @jojo/agent auth:antigravity`
生成专用文件，再由管理台选择 provider，将其 OAuth 凭据直接发送到
`JOJO_CREDENTIAL_SERVICE_URL`。浏览器只接收
就绪状态、来源提示和有效期，不会收到 Operator Token、access token 或 refresh token。
管理台接受顶层为 `openai-codex` / `antigravity` 的 Agent OAuth 文件，
Antigravity 必须包含 `projectId`；不接受 Codex CLI 原生
`tokens` 格式。更新前必须确认部署端已配置同一个 `JOJO_OPERATOR_TOKEN`。Codex 更新成功会
把 rotating refresh token 的所有权交给部署端；该本地凭据不可重复上传，如需继续在
本地运行 Agent，必须重新执行登录生成新的专用凭据。
Antigravity 使用独立加密命名空间，更新时保留项目 ID，不替换 Codex 凭据。
上传允许 access token 过期的完整凭据，由部署端使用 refresh token 验证并刷新。
管理台的 provider 选择决定上传对象；实际运行时切换在 Agent 环境设置
`JOJO_AGENT_PROVIDER`，并清空 `JOJO_AGENT_MODEL` 使用该 provider 默认模型或指定兼容模型。

划线评论和审核依赖
`infrastructure/supabase/migrations/202608180001_unified_annotations.sql`。部署迁移后，
匿名角色没有表或用户 RPC 权限；登录读者通过 `reader.annotations` 功能开关访问，
Workbench 通过 operator RPC 审核。

人民日报缺失正文工作台位于 `http://127.0.0.1:4174/rmrb-review`。它读取由
Hugging Face Canonical 生成的 `indexes/missing-articles.jsonl.gz`，按日期升序展示
`status=missing` 的记录。启动时会按 HF commit 自动生成
`tmp/rmrb-review/hf-missing-workbench.sqlite3`；该 SQLite 只是可丢弃缓存，新电脑
无需复制旧目录或数据库。Accept/Reject 先写入本机草稿和
`manual-review-pending-publication.json`，本地操作本身不会等待网络；工作台分别显示
“待复核”和“待发布”，HF 与 B2 均成功后才从待发布数中移除。未发布草稿如需跨电脑
继续处理，需要先在原电脑发布。
正文编辑区支持直接粘贴 PNG、JPEG、WebP 和 GIF；图片先以校验和命名的本地附件暂存，
发布时写入 HF Canonical `assets/images/` 并生成对应的 B2 Delivery Jox 资产。只有图片、
没有文字的记录会自动以 `【图片】` 作为可检索正文标记。
右上角“发布 N 条修订”一次同时更新 Hugging Face 和 B2。人工决定不上传远端；
Hugging Face 会原子更新受影响日期的 Canonical Item、受影响年份的
Dataset Viewer 分片、缺失正文索引和必要的 availability；B2 会先发布
正文 fragment，再更新日期 manifest 和必要的总 index。Reject 仅用于确定为无效、
重复或非文章的目录项，发布后写入 HF 的正式 `rejected` 状态且不会生成正文 fragment。
此流程不修改 Elasticsearch。
生成合并队列和自动补全图片记录的命令见
[`tools/rmrb-repair/README.md`](../rmrb-repair/README.md)。

书籍、报刊和时事新闻的统一 ES 同步命令见
[`server/README.md`](server/README.md#unified-es-sync)。同步器直接读取 HF
Canonical：书籍按章节、报刊和时事按文章写入；重复执行只为新内容追加稳定逻辑 ID，正文变化则要求
通过 ES repair 的 migration 人工确认。

Publication configuration is read from the repository `.env`:

```text
JOJO_DELIVERY_REMOTE=jojo-b2-s3:jojo-newspaper
ES_CONTENT_INDEX=<existing Elasticsearch index>
HF_DATASET_REPO=luoxiaozhuang/marxism-dataset
HF_DATASET_PRIVATE=false
HF_HUB_DISABLE_XET=1  # 当前代理链路使用可可靠提交的 LFS；稳定直连环境可设为 0
HF_XET_HIGH_PERFORMANCE=0  # 64 GB+ RAM hosts may set this to 1
HF_XET_FIXED_UPLOAD_CONCURRENCY=2
HF_XET_CLIENT_RETRY_MAX_DURATION=1200s
HF_XET_CLIENT_READ_TIMEOUT=600s
HF_UPLOAD_WORKERS=4
RMRB_REVIEW_HF_REPO=luoxiaozhuang/marxism-dataset
RMRB_REVIEW_B2_REMOTE=jojo-b2-s3:jojo-newspaper
```

S3 兼容入口发布时会显式使用 `--s3-no-check-bucket`，避免 rclone 对既有 B2 Bucket
误发 `CreateBucket`。Raw 和 Canonical 不上传 B2；Hugging Face 是唯一 Canonical 真值，
B2 只保存 Reader 使用的 Delivery 对象。

Hugging Face 凭据默认复用本机 CLI 登录，不需要把 Token 写进 `.env`：

```powershell
huggingface-cli login
huggingface-cli whoami
```

无人值守环境仍可使用 `HF_TOKEN=<write token>`，它会优先于 CLI 凭据。

HF 发布结果显示为 **Marxism Dataset**。默认发布为公开 Dataset；书籍目录位于 `books/`，`books/collections/` 使用中文书名导航；每本书
提供人类可读的卷册页面、完整目录 JSON、Canonical Item 下载和按 Dataset 打包的媒体归档。

书籍发布只管理 `books/`：按 Dataset ID 合并书目和搜索数据，保留未发布的书籍；仅清理本次重新发布书目目录内的旧文件。
不会同步或删除仓库根目录、`raw/`、`newspapers/`、`canonical/`，也不会清理未登记的 `-r1` 等旁支目录。
根目录 README 和 Dataset Viewer 配置由仓库维护，书籍入口不覆盖它们（书籍检索路径为 `books/data/search-documents.jsonl.gz`）。
更新已有丛书必须导入整套卷册；缺卷、缺少 Item/媒体/搜索数据、路径冲突或跨 Dataset 合并均会拒绝发布，需先补齐构建或单独对账迁移。
上传、目录索引和精确旧文件删除通过同一次原子提交发布，并校验父提交；出现并发冲突时重新发起发布，不会沿用旧清理计划重试。

本地联调 Reader/Agent 的真实 ES 搜索时，可只启动轻量搜索入口：

```powershell
$env:ES_CONTENT_INDEX="<统一同步器写入的索引>"
python server/content_search_app.py
```

它通过管理台已配置的 Kibana Console 代理提供与线上一致的
`POST /content/search`，不会启动旧报刊处理器。

Tencent ES Serverless indexes must be created in the Tencent console first;
they cannot be created with `PUT /index`. The book workbench no longer writes
ES directly; publish Canonical to Hugging Face, then run the unified ES sync.

For the production-style local launcher, run `server/start.bat`. It builds the
web client and serves it together with the API at `http://127.0.0.1:5000/`.
