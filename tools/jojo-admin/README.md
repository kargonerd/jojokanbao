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

Agent 管理页面位于 `http://127.0.0.1:4174/agent`。本机 Flask 优先读取
`JOJO_CODEX_AUTH_PATH` 或 `agent/auth.json`；两者不存在时读取当前用户的
`~/.codex/auth.json`，只把转换后的 `openai-codex` OAuth 凭据直接发送到
`JOJO_CREDENTIAL_SERVICE_URL`。浏览器只接收就绪状态、来源提示和有效期，
不会收到 Operator Token、access token 或 refresh token。更新前必须确认部署端
已配置同一个 `JOJO_OPERATOR_TOKEN`。

划线评论和审核依赖
`infrastructure/supabase/migrations/202608180001_unified_annotations.sql`。部署迁移后，
匿名角色没有表或用户 RPC 权限；登录读者通过 `reader.annotations` 功能开关访问，
Workbench 通过 operator RPC 审核。

人民日报缺失正文工作台位于 `http://127.0.0.1:4174/rmrb-review`。它读取
`tmp/rmrb-peopledata-full-directory/merged-missing-workbench.sqlite3`，按日期升序
展示本地 JSONL 与年度 XLSX 合并后仍为空的目录记录。Accept/Reject 只写入
`manual-review-decisions-workbench.jsonl`，不会直接修改语料或 Elasticsearch。
生成合并队列和自动补全图片记录的命令见
[`tools/rmrb-repair/README.md`](../rmrb-repair/README.md)。

Publication configuration is read from the repository `.env`:

```text
JOJO_DELIVERY_REMOTE=jojo-b2-s3:jojo-newspaper
ES_CONTENT_INDEX=<existing Elasticsearch index>
HF_DATASET_REPO=luoxiaozhuang/marxism-dataset
HF_DATASET_PRIVATE=false
HF_XET_HIGH_PERFORMANCE=1
HF_UPLOAD_WORKERS=4
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
$env:ES_CONTENT_INDEX="<管理台发布返回的索引>"
$env:ES_CONTENT_RELEASE_ID="<管理台发布返回的 releaseId>"
python server/content_search_app.py
```

它通过管理台已配置的 Kibana Console 代理提供与线上一致的
`POST /content/search`，不会启动旧报刊处理器。

Tencent ES Serverless indexes must be created in the Tencent console first;
they cannot be created with `PUT /index`. The publisher detects append-only
Serverless behavior, emits an immutable `releaseId`, and refuses to mix a
partial release with a retry.

For the production-style local launcher, run `server/start.bat`. It builds the
web client and serves it together with the API at `http://127.0.0.1:5000/`.
