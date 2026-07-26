# Append-only revision chains

The default single-index search path supports repairs without Elasticsearch
update/delete operations.

Each applied migration records the Elasticsearch index, the superseded
document ID, the operation, and the deterministic ID created by `_create`.
Reader Search loads reviewed migration JSON files from
`internal/data-workbench/server/es_migrations/` and adds one `must_not.ids`
filter to the normal search request:

- repair: exclude the superseded document ID;
- delete: exclude the superseded document ID and the new tombstone ID.

This keeps filtering before pagination without issuing a separate Elasticsearch
revision scan. Migration files are scoped by their `index` field, so test-index
repairs cannot affect production search.

Override the directory when Reader Search is deployed separately:

```powershell
$env:SEARCH_MIGRATIONS_DIR="C:\path\to\reviewed\migrations"
```

Reviewed, applied migrations must be deployed with Reader Search before their
new ES documents should become visible to users.
