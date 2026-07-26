# JOJO Data Workbench

Internal operations application for PDF intake, publication data generation,
and append-only Elasticsearch repairs.

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

For the production-style local launcher, run `server/start.bat`. It builds the
web client and serves it together with the API at `http://127.0.0.1:5000/`.
