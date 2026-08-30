# Bloomberg archive on GitHub Actions

The `Bloomberg 2020 archive` workflow downloads a bounded, resumable batch,
publishes content-addressed objects to Backblaze B2, uploads the SQLite
checkpoint last, and dispatches the next batch.

## Storage

The workflow writes to:

```text
B2_ARCHIVE_BUCKET/
  research-archives/bloomberg/2020/
    objects/
    state/archive.sqlite3.gz
    state/summary.json
```

The bucket must be `allPrivate`. The workflow verifies this through the B2
Native API before it restores or uploads any archive data.

It requires these repository secrets:

- `B2_ARCHIVE_KEY_ID`
- `B2_ARCHIVE_APPLICATION_KEY`
- `B2_ARCHIVE_BUCKET`

Use a dedicated B2 application key restricted to the archive bucket, with the
minimum read, write, list, and delete permissions needed by the checkpoint and
object uploader. The bucket itself must remain private.

## Execution

- A normal batch processes at most 1,000 articles.
- It stops submitting new work after 300 minutes and lets in-flight downloads
  finish before checkpointing.
- Only one workflow can write the checkpoint at a time.
- Successful incomplete batches dispatch their successor immediately.
- A six-hour schedule is a watchdog for failed or interrupted chains.
- Error and partial rows receive at most three article-level attempts.

To test without starting the chain, run the workflow manually with a small
`max_articles` value and disable `auto_continue`.

## Restore

Configure an rclone B2 remote with the same application key, then download the
state and objects:

```bash
rclone copyto \
  jojo-b2:BUCKET/research-archives/bloomberg/2020/state/archive.sqlite3.gz \
  archive.sqlite3.gz
gzip -d archive.sqlite3.gz
rclone copy \
  jojo-b2:BUCKET/research-archives/bloomberg/2020/objects \
  objects
```
