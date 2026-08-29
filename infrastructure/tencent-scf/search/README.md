# Reader Search · Tencent SCF

This directory is the currently deployed JOJO Reader search runtime. It remains
independent from the new FastAPI backend so moving source code does not change
its Flask routes, CORS behavior, or Tencent SCF deployment contract.

## Default Search

Without overlay settings, `/search` keeps the existing single-index behavior:

```powershell
$env:ELASTICSEARCH_URL="http://your-es-host:80"
$env:ELASTICSEARCH_USERNAME="elastic"
$env:ELASTICSEARCH_PASSWORD="..."
$env:ELASTICSEARCH_INDEX="jojo-67f10bu8"
python app.py
```

## Unified content search

`POST /content/search` serves Reader and Agent queries over JOJO books,
newspapers and magazines. Configure a normal ES index with:

```powershell
$env:ELASTICSEARCH_CONTENT_INDEX="jojo-content-v1"
```

Tencent ES Serverless is append-only. The unified synchronizer writes stable
logical document IDs and does not use a release selector:

```powershell
$env:ELASTICSEARCH_CONTENT_INDEX="aitest-1tk2lxru"
```

`datasetId` and `itemId` are top-level keyword fields used for exact scope
filtering. The API still reads legacy chunk fields during migration, but the
book workbench no longer publishes those documents.

### Migration exclusions

Reader Search supports append-only repairs without Elasticsearch update/delete
operations. It reads reviewed migration JSON files from
`tools/jojo-admin/server/es_migrations/` and adds one `must_not.ids`
filter to each search request:

- a repair excludes the superseded document ID;
- a deletion excludes the superseded document ID and its new tombstone ID.

Only applied migrations for the current Elasticsearch index are used. This
keeps filtering before pagination without an extra ES revision scan. When this
service is deployed separately, point it at the deployed migration directory:

```powershell
$env:SEARCH_MIGRATIONS_DIR="C:\path\to\reviewed\migrations"
```

## Overlay Search Test

Create a small base/delta test index from the local RMRB source data:

```powershell
cd infrastructure/tencent-scf/search
$env:ELASTICSEARCH_URL="http://your-es-host:80"
$env:ELASTICSEARCH_USERNAME="elastic"
$env:ELASTICSEARCH_PASSWORD="..."
python rmrb_overlay_poc.py --limit 30 --query "黄河"
```

The script creates two timestamped indices:

```text
jojo-rmrb-overlay-test-base-YYYYMMDDHHMMSS
jojo-rmrb-overlay-test-delta-YYYYMMDDHHMMSS
```

It also writes a local patch-state file to `.runtime/patch-state-test.json`.

Run the Flask service against those indices:

```powershell
$env:SEARCH_OVERLAY="true"
$env:ELASTICSEARCH_BASE_INDEX="jojo-rmrb-overlay-test-base-YYYYMMDDHHMMSS"
$env:ELASTICSEARCH_DELTA_INDEX="jojo-rmrb-overlay-test-delta-YYYYMMDDHHMMSS"
$env:SEARCH_PATCH_STATE_FILE=".runtime/patch-state-test.json"
python app.py
```

Then query:

```powershell
Invoke-RestMethod "http://127.0.0.1:9000/search?keyword=黄河&size=10"
Invoke-RestMethod "http://127.0.0.1:9000/search?keyword=OverlayUniqueToken&size=10"
```

`OverlayUniqueToken` should only be returned from the delta index, proving that a patched document is searchable.
