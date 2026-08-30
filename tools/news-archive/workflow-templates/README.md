# Inactive workflow templates

These files preserve the temporary runner's orchestration and its contract
tests while the storage backend is migrated. GitHub ignores this nested
`.github` directory.

The templates still describe the legacy B2 Raw/checkpoint transport. They
must not be copied to the repository-level `.github/workflows` directory or
enabled until they have been converted to HF Raw, protected by the archive
runner enable gate, and exercised by the cutover dry run.

`bloomberg-archive.yml` and the standalone runner `ci.yml` are intentionally
not retained. The former is retired; the latter is merged into the monorepo
CI instead.
