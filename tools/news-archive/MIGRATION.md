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
  audit/**
  state/**
raw/archive/v2/validation-state/**
raw/archive/assets/{source}/{sha256}.{ext}
raw/archive/runs/YYYY/MM/DD/{runId}/
  manifest.json
  file-sets/01-immutable.json
  file-sets/02-catalog.json
  file-sets/03-checkpoint.json
  file-sets/04-completion.json
canonical/{source}/dataset.json
canonical/{source}/articles/{contentHash}.json.gz
canonical/{source}/dates/YYYY/MM/YYYY-MM-DD.json.gz
canonical/archive-runs/{sha256(runId)[0:24]}.json
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
The resulting exact file set is uploaded only through the historical Canonical
action: its run report defines the complete allowlist, the report Raw revision
is the required HF parent, and all files share one CAS commit. Dataset/date
objects are replaceable merge results. Existing article and run-report objects
must have identical bytes or the upload fails; article `contentHash` is not
treated as a whole-file checksum.

Each local transfer batch uses `jojo-hf-file-set/1` and publishes legacy bytes
in four commits: immutable Raw, catalog, checkpoint, then completion marker. Every
entry contains an output-root-relative path, exact HF object name, byte count,
SHA-256, and required flag. A v2-only batch must supply the previously verified
v1 file-set manifests that satisfy its SQLite Raw references.

After the four legacy phases, a fifth commit publishes one run manifest and
copies of all four exact file sets below `raw/archive/runs/`. Canonical replay
pins the resulting revision and verifies the run object, phase hashes, and Raw
prefix before parsing any article. A replay file set maps the original staging
paths to final HF object names; without this explicit rewrite, legacy
`localPath` values are not a valid Canonical workspace layout.

The run's `migrationComplete` flag closes an exact, verified migration snapshot;
it is deliberately separate from any crawl/validation completion field inside
the copied source summary. The completion-summary file set itself must be
non-empty. Every exact-file upload is parent-revision locked, and Canonical
prepare separately binds all input rows to the fifth commit via
`--replay-revision` (not the fourth completion-phase commit).
The upload executor additionally requires one allowlisted archive batch prefix
and an explicit existing-object policy. Raw captures, run bundles, and archived
image assets are create-only: same-hash objects are skipped and hash conflicts
abort before the HF commit.

## Cutover gates

1. Keep all migrated workflows inactive while HF upload/download and
   Canonical bridge tests are incomplete.
2. Copy every B2 `news-archive/v1` Raw object and every historical
   `news-archive/v2/validation-state` cohort to the HF archive namespace.
3. Verify object counts, byte counts, SHA-256 values, SQLite integrity, and
   the complete historical exclusion union across every migrated cohort.
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
