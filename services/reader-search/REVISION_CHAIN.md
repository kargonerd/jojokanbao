# Append-only revision chains

The default single-index search path supports repairs without Elasticsearch
update/delete operations.

A repair document stores the full active article and sets `supersedesId` to the
previous Elasticsearch `_id`. A logical deletion does the same and sets
`deleted: true`. Reader Search caches those revision edges, excludes every
superseded `_id` and tombstone inside the Elasticsearch query, and returns the
active hit's `_id` as `documentId`. Filtering before pagination keeps totals,
sorting, and pages correct.

Optional tuning:

```powershell
$env:SEARCH_REVISION_CACHE_SECONDS="30"
$env:SEARCH_REVISION_LIMIT="10000"
```

If the number of revision edges exceeds the configured limit, search fails
closed instead of exposing stale versions.
