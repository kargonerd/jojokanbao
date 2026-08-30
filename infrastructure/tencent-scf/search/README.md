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

### Search revision state

Reader Search supports append-only repairs without Elasticsearch update/delete
operations. The SCF runtime reads one plain JSON object from private COS and
adds one `must_not.ids` filter to each search request:

```json
{"excludedIds":{"jojo-content-v1":["superseded-document-id"]}}
```

- a repair excludes the superseded document ID;
- a deletion excludes the superseded document ID and its new tombstone ID.

The file is cached in each warm SCF instance. After 60 seconds the runtime uses
COS `HEAD Object` to compare ETags and downloads it only when changed. A refresh
failure keeps the last good state; a cold start without any readable state
fails closed with HTTP 503.

Configure the function with the bucket, region, and one fixed object key:

```powershell
$env:SEARCH_STATE_COS_BUCKET="private-bucket-1250000000"
$env:SEARCH_STATE_COS_REGION="ap-beijing"
$env:SEARCH_STATE_COS_KEY="runtime/search/search-state.json"
```

Bind an SCF execution role with `cos:HeadObject` and `cos:GetObject` restricted
to that object. SCF supplies temporary credentials through its built-in
`TENCENTCLOUD_*` environment variables, so permanent COS keys are not stored in
the function configuration. Package `cos-python-sdk-v5` with the function;
the Python 3.9 Web runtime does not expose it on `PYTHONPATH` consistently.

The local migration history remains auditable but is never deployed with SCF.
Publish the complete applied state atomically as one COS object with the logged
in TCCLI profile:

```powershell
python tools/jojo-admin/server/publish_search_state.py `
  --index jojo-content-v1 `
  --index jojo-67f10bu8 `
  --bucket private-bucket-1250000000 `
  --region ap-beijing
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
