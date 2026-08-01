# Archive PDF tooling

Repository-level tools for preparing, publishing, and verifying protected Archive
PDF files. They operate across the content pipeline, object storage, EdgeOne,
and the Archive Web module, so they are not owned by a single app or service.

Use the stable root commands rather than invoking files by path:

```bash
pnpm protect:archive-pdf
pnpm verify:archive-pdf
pnpm publish:archive-pdf
pnpm purge:archive-pdf
pnpm finalize:archive-pdf
pnpm sync:rmrb
```

## Files

- `protect.mjs` encodes or decodes the position-dependent byte mask.
- `verify.mjs` checks local files or public URLs, including HTTP Range support.
- `publish.mjs` linearizes, protects, verifies, and uploads selected issues.
- `purge-cache.mjs` submits EdgeOne URL or prefix purge tasks.
- `finalize.mjs` purges public URLs and polls verification until the protected
  objects are visible.
- `sync_rmrb.py` downloads one RMRB issue, merges and linearizes its pages,
  protects the result, and uploads it to B2.

`sync_rmrb.py` additionally requires Python with `requests` and `PyPDF2`, plus
the `qpdf` and `rclone` executables.
