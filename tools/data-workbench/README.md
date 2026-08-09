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
HF_TOKEN=<Hugging Face write token>
HF_DATASET_REPO=<owner/private-dataset-repo>
```

Tencent ES Serverless indexes must be created in the Tencent console first;
they cannot be created with `PUT /index`. The publisher detects append-only
Serverless behavior, emits an immutable `releaseId`, and refuses to mix a
partial release with a retry.

For the production-style local launcher, run `server/start.bat`. It builds the
web client and serves it together with the API at `http://127.0.0.1:5000/`.
