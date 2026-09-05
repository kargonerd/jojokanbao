# JOJO 管理台

Internal JOJO management application for PDF intake, publication data generation,
append-only Elasticsearch repairs, feature flags, and Agent operations.

The product UI and internal package are both named **JOJO 管理台**, covering content operations, search maintenance,
and runtime feature rules. `/content` is the JOJO v1 content importer and publisher. It accepts local
WeRead JSON paths or browser-selected files, shows background job progress and
diagnostics, then publishes Canonical data to Hugging Face, Delivery objects to
B2, and rebuildable search documents to Elasticsearch.
By default, a WeRead source is rejected when its declared TOC is truncated,
TOC chapter responses are missing, or any response cannot be decoded.

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

评论审核页面位于 `http://127.0.0.1:4174/moderation`。它复用同一个
`JOJO_OPERATOR_TOKEN`，读取读者举报并支持隐藏、恢复评论或驳回举报；每次操作
必须填写理由，数据库会保留审核事件。管理员 token 始终只由同机 Flask 代理读取。

首次启用功能开关管理时，需要在目标 Supabase 项目中执行已评审的迁移，并按
`infrastructure/supabase/README.md` 将同一个 Operator Token 的摘要写入数据库。

Agent 管理页面位于 `http://127.0.0.1:4174/agent`。设置
`JOJO_CODEX_AUTH_PATH` 或 `JOJO_AGENT_AUTH_PATH` 时，本机 Flask 只读取指定路径
（两者同时设置时前者优先）；均未设置时只读取仓库内的 `agent/auth.json`。管理台不会回退读取当前用户的 `~/.codex/auth.json`，避免与
Codex CLI 或其他本地会话共享 refresh token。可先运行
`pnpm --filter @jojo/agent auth:codex` 生成专用文件，再由管理台把转换后的
`openai-codex` OAuth 凭据直接发送到 `JOJO_CREDENTIAL_SERVICE_URL`。浏览器只接收
就绪状态、来源提示和有效期，不会收到 Operator Token、access token 或 refresh token。
管理台只接受顶层为 `openai-codex` 的 Agent OAuth 文件，不接受 Codex CLI 原生
`tokens` 格式。更新前必须确认部署端已配置同一个 `JOJO_OPERATOR_TOKEN`。更新成功会
把 rotating refresh token 的所有权交给部署端；该本地凭据不可重复上传，如需继续在
本地运行 Agent，必须重新执行登录生成新的专用凭据。

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
“待复核”和“待发布”，完整发布成功后才从待发布数中移除。未发布草稿仍属于当前
操作电脑；HF 已提交而派生阶段失败时则可依据 HF commit 与远端搜索版本状态安全续跑。
四阶段收据另存为私有 COS 小对象
`runtime/publishing/newspaper-rmrb.json`，只含条目键、哈希、commit 和阶段状态，不含正文或图片；
新电脑会显示“继续发布”。
正文编辑区支持直接粘贴 PNG、JPEG、WebP 和 GIF；图片先以校验和命名的本地附件暂存，
发布时写入 HF Canonical `assets/images/` 并生成对应的 B2 Delivery Jox 资产。只有图片、
没有文字的记录会自动以 `【图片】` 作为可检索正文标记。
右上角“发布 N 条修订”执行固定的
`HF Canonical → B2 Delivery → ES Search → COS Activation`，不允许单独选择目标。人工决定不上传远端；
Hugging Face 会原子更新受影响日期的 Canonical Item、受影响年份的
Dataset Viewer 分片、缺失正文索引和必要的 availability；B2 会先发布
正文 fragment，再更新日期 manifest 和必要的总 index；ES 先追加新版本，COS 再排除旧版本。
Reject 仅用于确定为无效、
重复或非文章的目录项，发布后写入 HF 的正式 `rejected` 状态且不会生成正文 fragment。
生成合并队列和自动补全图片记录的命令见
[`tools/rmrb-repair/README.md`](../rmrb-repair/README.md)。

书籍、报刊和时事新闻的统一 ES 同步命令见
[`server/README.md`](server/README.md#unified-es-sync)。同步器直接读取 HF
Canonical：书籍按章节、报刊和时事按文章写入。正常 Canonical 修订由统一发布器自动追加 ES
版本并激活；ES repair 只用于无法先表达为 Canonical 变更的紧急例外。

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
ES_SYNC_INDEX=<production unified search index>
SEARCH_STATE_INDICES=<same production index>
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

HF 发布结果显示为 **Marxism Dataset**。默认发布为公开 Dataset；首页和 `collections/` 使用中文书名导航；每本书
提供人类可读的卷册页面、完整目录 JSON、Canonical Item 下载和按 Dataset 打包的媒体归档。

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
