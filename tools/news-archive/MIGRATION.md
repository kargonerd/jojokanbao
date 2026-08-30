# Historical archive migration

The migration is deliberately split so repository movement cannot create two
writers for the same checkpoint.

## Target HF layout

```text
raw/archive/v1/{publisher}/{window}/{mode}/
  catalog/**
  raw/objects/html/**
  raw/objects/resources/**
  raw/records/**
  state/**
raw/archive/v2/validation-state/**
raw/archive/assets/{source}/{sha256}.{ext}
raw/archive/runs/YYYY/MM/DD/{runId}/manifest.json
canonical/{source}/dataset.json
canonical/{source}/articles/{contentHash}.json.gz
canonical/{source}/dates/YYYY/MM/YYYY-MM-DD.json.gz
canonical/runs/{runId}.json
```

The archive Raw namespace is separate from Times' live
`raw/{source}/state.json.gz`, while both systems share the same Canonical
contract and writer. Raw commits may cover disjoint prefixes and retry HF 409
conflicts. Canonical and date-index commits must use the existing
`times-hf-dataset-writer` concurrency group.

Historical Canonical publication is two-phase: prepare and upload selected
image bytes to HF Raw, then use that exact new Raw revision while merging and
uploading Canonical. The write phase aborts if HF has moved since the image
commit, preventing an unnoticed lost update.

Each local transfer batch uses `jojo-hf-file-set/1` and is published in four
commits: immutable Raw, catalog, checkpoint, then completion marker. Every
entry contains an output-root-relative path, exact HF object name, byte count,
SHA-256, and required flag. A v2-only batch must supply the previously verified
v1 file-set manifests that satisfy its SQLite Raw references.

## Cutover gates

1. Keep all migrated workflows inactive while HF upload/download and
   Canonical bridge tests are incomplete.
2. Copy every B2 `news-archive/v1` Raw object and every historical
   `news-archive/v2/validation-state` cohort to the HF archive namespace.
3. Verify object counts, byte counts, SHA-256 values, SQLite integrity, and
   the complete historical exclusion union.
4. Disable every self-continuing workflow in the temporary runner. Let
   in-flight jobs publish their final checkpoints and drain naturally.
5. Apply and verify the final delta produced after the bulk copy.
6. Run one unfinished cohort from the new repository with continuation off;
   its evaluated count must increase without resetting or overlapping an old
   cohort.
7. Enable the new watchdog, verify at least one complete resumed checkpoint,
   then remove the temporary GitHub repository.

The retired `research-archives/bloomberg/2020` experiment is not an input to
this cutover.
