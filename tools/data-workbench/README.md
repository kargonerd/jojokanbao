# JOJO Data Workbench

Internal operations application for PDF intake, publication data generation,
and append-only Elasticsearch repairs.

`/content` is the JOJO v1 content importer and publisher. It accepts local
WeRead JSON paths or browser-selected files, shows background job progress and
diagnostics, then independently publishes B2, Elasticsearch and Hugging Face.

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

Publication configuration is read from the repository `.env`:

```text
JOJO_RAW_REMOTE=jojo-b2:jojo-news-raw
JOJO_DELIVERY_REMOTE=jojo-b2-s3:jojo-newspaper
ES_CONTENT_INDEX=<existing Elasticsearch index>
HF_DATASET_REPO=<owner/private-dataset-repo>
```

Hugging Face 凭据默认复用本机 CLI 登录，不需要把 Token 写进 `.env`：

```powershell
huggingface-cli login
huggingface-cli whoami
```

无人值守环境仍可使用 `HF_TOKEN=<write token>`，它会优先于 CLI 凭据。

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
