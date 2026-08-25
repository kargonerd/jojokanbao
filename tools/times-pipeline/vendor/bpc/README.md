# Pinned Bypass Paywalls Clean archive

`bypass-paywalls-chrome-clean.zip` is the exact Chrome extension archive used by the Times capture
workflow. It is vendored because the upstream uploads repository rewrites its branch and no longer
serves older commits reliably.

- Upstream: `https://gitflic.ru/project/magnolia1234/bpc_uploads`
- Recorded upstream revision: `587dcfd3d3b18652607e37d3d401430e85f8c8ec`
- SHA-256: `1db1c0d424f2ca1f8b9c88b91789ea68b7732969023cb23f82b263c060a6ce59`
- Size: `314812` bytes
- License: MIT; the upstream `LICENSE` and `LICENSE.txt` are included inside the archive.

Both GitHub workflows verify the digest before extracting the extension. Updating this file requires
recording a new revision and digest here and in both workflow files.
