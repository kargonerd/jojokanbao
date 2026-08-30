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
newspapers and magazines. It deliberately uses a separate client so the
existing `/search` cluster and account are unaffected. Configure the new
content cluster with:

```powershell
$env:CONTENT_ELASTICSEARCH_URL="https://your-new-content-es-endpoint"
$env:CONTENT_ELASTICSEARCH_USERNAME="elastic"
$env:CONTENT_ELASTICSEARCH_PASSWORD="..."
$env:CONTENT_ELASTICSEARCH_INDEX="jojo-content-v1"
```

Tencent ES Serverless is append-only. The unified synchronizer writes stable
logical document IDs and does not use a release selector. Until all four
`CONTENT_ELASTICSEARCH_*` values are configured, `/content/search` fails closed
with HTTP 503 while the existing `/search` route remains available.

`datasetId` and `itemId` are top-level keyword fields used for exact scope
filtering. The unified endpoint reads only the nine fields in the strict JOJO
Search mapping; it does not query the old chunk, repair, vector, or release
fields.

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
The repair workbench publishes automatically after each successful repair. The
CLI below is the recovery/manual path. It downloads the current object first
and unions old exclusions with local applied migrations, so another workstation
cannot erase earlier repair state:

```powershell
python tools/jojo-admin/server/publish_search_state.py `
  --index jojo-content-v1 `
  --index jojo-67f10bu8 `
  --bucket private-bucket-1250000000 `
  --region ap-beijing
```

## Deploying search code

`deploy.py` is the only supported SCF code-release path. It builds a clean zip
with pinned dependencies, normalizes `scf_bootstrap` to Linux line endings,
uploads the package temporarily to the private `jojo-search` COS bucket,
updates one function, waits for it to become Active, verifies `/health`, and
then removes the temporary COS object. The health response exposes the Git
commit and source fingerprint that are actually running.

Build locally without changing cloud state:

```powershell
python infrastructure/tencent-scf/search/deploy.py --build-only
```

Deploy and verify staging:

```powershell
python infrastructure/tencent-scf/search/deploy.py --target staging
```

Production refuses to deploy unless staging is healthy and is running the same
source fingerprint. The production flag must also be explicit:

```powershell
python infrastructure/tencent-scf/search/deploy.py `
  --target production `
  --confirm-production
```

The command calls the authenticated local `tccli`; it never stores Tencent
credentials in the repository. `UpdateFunctionCode` preserves the function's
environment and network configuration.

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
