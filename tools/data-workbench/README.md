# JOJO 管理台

Internal operations application for PDF intake, publication data generation,
and append-only Elasticsearch repairs.

The internal package and directory keep the historical `data-workbench` name for now.
The product UI is **JOJO 管理台**, covering content operations, search maintenance,
and runtime feature rules. `/content` is the JOJO v1 content importer and publisher. It accepts local
WeRead JSON paths or browser-selected files, shows background job progress and
diagnostics, then independently publishes B2, Elasticsearch and Hugging Face.
By default, a WeRead source is rejected when its declared TOC is truncated,
TOC chapter responses are missing, or any response cannot be decoded.

## Structure

- `web/` — React 19 client, registered in the pnpm workspace as
  `@jojo/data-workbench`.
- `server/` — Flask APIs, PDF processing pipeline, storage adapters, and local
  ES migration files.

## Run

From the repository root:

```bash
pnpm dev:jojo-pipe
```

功能开关页面位于 `http://127.0.0.1:4174/features`。它只通过同机 Flask
服务访问 Supabase：Flask 从仓库根目录 `.env` 读取现有的
`JOJO_OPERATOR_TOKEN`，浏览器不接收、不保存这个密钥，也不需要单独登录。

首次启用功能开关管理时，需要在目标 Supabase 项目中执行已评审的迁移，并按
`infrastructure/supabase/README.md` 将同一个 Operator Token 的摘要写入数据库。

Publication configuration is read from the repository `.env`:

```text
JOJO_RAW_REMOTE=jojo-b2:jojo-news-raw
JOJO_DELIVERY_REMOTE=jojo-b2-s3:jojo-newspaper
ES_CONTENT_INDEX=<existing Elasticsearch index>
HF_DATASET_REPO=<owner>/marxism
```

S3 兼容入口发布时会显式使用 `--s3-no-check-bucket`，避免 rclone 对既有 B2 Bucket
误发 `CreateBucket`；大于 50 MiB 的 Raw 文件使用 B2 分片并发上传。

Hugging Face 凭据默认复用本机 CLI 登录，不需要把 Token 写进 `.env`：

```powershell
huggingface-cli login
huggingface-cli whoami
```

无人值守环境仍可使用 `HF_TOKEN=<write token>`，它会优先于 CLI 凭据。

HF 发布结果显示为 **Marxism Dataset**。首页和 `collections/` 使用中文书名导航；每本书
提供人类可读的卷册页面、完整目录 JSON、Canonical Item 下载和按 Dataset 打包的媒体归档。

本地联调 Reader/Agent 的真实 ES 搜索时，可只启动轻量搜索入口：

```powershell
$env:ES_CONTENT_INDEX="<Workbench 发布返回的索引>"
$env:ES_CONTENT_RELEASE_ID="<Workbench 发布返回的 releaseId>"
python server/content_search_app.py
```

它通过 Workbench 已配置的 Kibana Console 代理提供与线上一致的
`POST /content/search`，不会启动旧报刊处理器。

Tencent ES Serverless indexes must be created in the Tencent console first;
they cannot be created with `PUT /index`. The publisher detects append-only
Serverless behavior, emits an immutable `releaseId`, and refuses to mix a
partial release with a retry.

For the production-style local launcher, run `server/start.bat`. It builds the
web client and serves it together with the API at `http://127.0.0.1:5000/`.
