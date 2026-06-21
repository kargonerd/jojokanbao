# CLAUDE.md

This project is the Vue 2 frontend and upload tooling for JOJO看报.

## Stack

- Vue 2.6 with Vue CLI 5.
- Vue Router in history mode.
- Element UI for UI widgets.
- `vue-pdf-embed` / PDF.js for PDF rendering.
- Upload tooling is Python + qpdf + rclone + Backblaze B2.

## Commands

Run these from `C:\Users\luoxixi\WebstormProjects\web`:

```powershell
npm run serve
npm run build
npm run lint
```

Upload full PDFs to Backblaze B2:

```powershell
python "C:\Users\luoxixi\WebstormProjects\web\upload\upload_to_r2.py"
```

Upload one collection/year:

```powershell
python "C:\Users\luoxixi\WebstormProjects\web\upload\upload_to_r2.py" --collection rmrb --year 2025
```

Use `--force` to force re-upload and `--qpdf-jobs N` to control qpdf concurrency.

## Frontend implementation

Routes are defined in `src/router/index.js`:

- `/rmrb/:id(\d{8})` 人民日报
- `/ckxx/:id(\d{8})` 参考消息
- `/hq/:id(\d{6})` 红旗
- `/sjzs/:id(\d{6})` 世界知识
- `/rmhb/:id(\d{6})` 人民画报
- `/support`, `/search`, and a 404 route

`src/main.js` installs Element UI, imports the custom Element theme CSS files from `theme/`, and mounts `App.vue`.

The core document viewer is `src/components/DocViewer.vue`:

- It builds full PDF URLs under `https://blacknews.jojokanbao.cn`.
- Newspaper PDFs use `/<COLLECTION>/<yyyyMMdd>.pdf`.
- Magazine PDFs use `/<COLLECTION>/<yyyy><seq padded to 2 digits>.pdf`.
- It creates one PDF.js document per selected issue/date with `VuePdfEmbed.getDocument()`.
- PDF range loading is enabled with `disableRange: false`; streaming is disabled with `disableStream: true`; chunk size is `262144`.
- Rendered pages are tracked in `renderedPages` and only requested/rendered as needed.
- `OnViewEnter` lazy-loads page placeholders when they enter the viewport.
- Hashes like `#page-12` are supported for page jumps.
- Firefox sets `disableFontFace = true`.

When editing `DocViewer.vue`, preserve these behaviors:

- Keep one PDF.js document per issue/date; do not recreate the document per page.
- Close Element UI loading overlays on render success, render failure, route leave, and destroy.
- Keep route/hash changes from forcing a full page refresh.
- Do not reintroduce old per-page PDF URL logic unless explicitly requested.

## Upload implementation

The upload script is `upload/upload_to_r2.py`. The name is historical; it now uploads to Backblaze B2.

Configuration is read from `upload/.env` when present:

```text
B2_KEY_ID=...
B2_APPLICATION_KEY=...
B2_BUCKET=jojo-newspaper
```

If credentials are not present, the script reuses the existing local rclone remote `jojo-b2` and defaults `B2_BUCKET` to `jojo-newspaper`.

Do not commit `upload/.env`; it is ignored by `.gitignore`.

The upload script knows these local source roots and remote prefixes:

- `rmrb`: `D:\Cloud\OneDrive\rmrb\RMRB` -> `RMRB`
- `rmhb`: `D:\Cloud\OneDrive\rmhb\RMHB_full` -> `RMHB`
- `ckxx`: `D:\Cloud\OneDrive\ckxx\CKXX` -> `CKXX`
- `hq`: `D:\Cloud\OneDrive\红旗\HQ` -> `HQ`
- `sjzs`: `D:\Cloud\OneDrive\世界知识\SJZS` -> `SJZS`

Upload flow:

1. Load B2 settings from `upload/.env` if present.
2. Create/update rclone remote `jojo-b2` when credentials are present, otherwise verify the existing remote.
3. For each collection/year directory, linearize every PDF into `upload/.work/<collection>/<year>/`.
4. Upload the linearized batch to `jojo-b2:<bucket>/<REMOTE_PREFIX>/<year>`.
5. Delete the local `.work` batch after successful upload.
6. Delete `.work` if it is empty.

qpdf details:

- qpdf binary is expected at `C:\Program Files\qpdf 12.3.2\bin\qpdf.exe`.
- `qpdf --linearize` is used to create Fast Web View PDFs.
- `qpdf --check-linearization` must report `no linearization errors`.
- qpdf exit code `3` means warnings; accept it only if the linearization check passes.
- qpdf exit code `2` is a real error; skip that PDF.

rclone upload details:

- Remote name: `jojo-b2`.
- Upload flags include `--transfers 8`, `--checkers 32`, `--fast-list`, `--timeout 30s`, `--contimeout 15s`, `--retries 5`, `--low-level-retries 10`.
- Uploaded objects use `Cache-Control: public, max-age=315360000, immutable`.

Known data cleanup:

- `*-ITCN000793-MAC.pdf` files were bad duplicate artifacts and should not be uploaded.
- `rmrb/1998/19980710.pdf` was confirmed as a genuinely broken PDF and was deleted locally.

## Progress dashboard

`upload/progress_server.py` serves a local upload progress page for long uploads. It parses an upload log and exposes a browser UI.

Typical usage:

```powershell
python "C:\Users\luoxixi\WebstormProjects\web\upload\progress_server.py" --log "C:\path\to\upload.log" --port 8765
```

Then open `http://127.0.0.1:8765/`. The parser supports UTF-8 logs and PowerShell UTF-16 redirected logs.

Fetch recent RMRB issues before archiving/uploading:

```powershell
python "C:\Users\luoxixi\WebstormProjects\web\upload\fetch_rmrb_new.py" --year 2026
python "C:\Users\luoxixi\WebstormProjects\web\upload\fetch_rmrb_new.py" --start 20260501 --end 20260514
```

The fetcher writes merged PDFs to `D:\Cloud\OneDrive\rmrb\newspaper` and temporary page PDFs to `D:\Cloud\OneDrive\rmrb\part`.

## Working conventions

- Prefer editing existing files over adding new ones.
- Keep the upload directory clean; one-off logs, manifests, and rerun scripts should be deleted after use.
- Do not store credentials outside `upload/.env`.
- For frontend changes, run `npm run build` and use the page in a browser before claiming success.
- For upload changes, run targeted collection/year tests before full uploads.
- Avoid adding comments unless they explain a non-obvious constraint.
