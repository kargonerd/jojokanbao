from datetime import date, timedelta
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

import requests
from PyPDF2 import PdfMerger


B2_BUCKET = os.environ.get("B2_BUCKET", "jojo-newspaper")
B2_REMOTE = os.environ.get("B2_REMOTE", "jojo-b2")
CACHE_CONTROL = "public, max-age=315360000, immutable"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36",
}
WORK_DIR = Path(os.environ.get("RMRB_SYNC_WORK_DIR", ".rmrb-sync-work"))
STATE_FILE = WORK_DIR / "state.json"
REPO_ROOT = Path(__file__).resolve().parent.parent
PROTECT_SCRIPT = REPO_ROOT / "tooling" / "protect-reader-pdf.mjs"
QPDF_BIN = os.environ.get("QPDF_BIN") or shutil.which("qpdf") or "qpdf"


def run(args):
    print("$ " + " ".join(str(arg) for arg in args), flush=True)
    subprocess.run(args, check=True)


def capture(args, allow_warning=False):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode == 0 or (allow_warning and result.returncode == 3):
        return result
    raise subprocess.CalledProcessError(result.returncode, args, output=result.stdout, stderr=result.stderr)


def configure_rclone():
    if os.environ.get("B2_KEY_ID") and os.environ.get("B2_APPLICATION_KEY"):
        print("[1/8] Configuring rclone from environment credentials...", flush=True)
        run(
            [
                "rclone",
                "config",
                "create",
                B2_REMOTE,
                "b2",
                "account",
                os.environ["B2_KEY_ID"],
                "key",
                os.environ["B2_APPLICATION_KEY"],
                "--non-interactive",
            ]
        )
        print("[1/8] rclone configured.", flush=True)
        return

    result = subprocess.run(
        ["rclone", "lsd", f"{B2_REMOTE}:{B2_BUCKET}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "B2 credentials are not in the environment and the existing rclone remote is unavailable: "
            + result.stderr.strip()
        )
    print(f"[1/8] Using existing rclone remote {B2_REMOTE}:{B2_BUCKET}.", flush=True)


def remote_path(day):
    compact = day.strftime("%Y%m%d")
    return f"{B2_REMOTE}:{B2_BUCKET}/RMRB/{day:%Y}/{compact}.pdf"


def remote_exists(day):
    path = remote_path(day)
    print(f"[2/8] Checking if {path} exists...", flush=True)
    result = subprocess.run(
        ["rclone", "lsjson", path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        print(f"[2/8] File does not exist (returncode={result.returncode}).", flush=True)
        return False
    stdout = result.stdout.strip().replace("\n", "").replace(" ", "")
    exists = stdout != "[]" and stdout != ""
    print(f"[2/8] File exists: {exists}", flush=True)
    return exists


def get_text(session, url):
    response = session.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response.text


def new_layout_urls(session, day):
    dated_path = day.strftime("%Y%m/%d")
    cover_url = f"http://paper.people.com.cn/rmrb/pc/layout/{dated_path}/node_01.html"
    print(f"[3/8] Fetching page list from {cover_url}...", flush=True)
    text = get_text(session, cover_url)
    page_count = len(re.findall("pageLink", text))
    print(f"[3/8] Found {page_count} pages.", flush=True)
    urls = []

    for page in range(1, page_count + 1):
        page_url = f"http://paper.people.com.cn/rmrb/pc/layout/{dated_path}/node_{page:02d}.html"
        page_text = get_text(session, page_url)
        matches = re.findall(r"attachement.*?\.pdf", page_text)
        if matches:
            pdf_url = "http://paper.people.com.cn/rmrb/pc/" + matches[0]
            urls.append(pdf_url)
            print(f"[3/8] Page {page:02d}: {pdf_url}", flush=True)
        else:
            print(f"[3/8] Page {page:02d}: no PDF found", flush=True)
    return urls


def get_page_urls(session, day):
    return new_layout_urls(session, day)


def download_pdf(session, url, output):
    for attempt in range(1, 6):
        try:
            response = session.get(url, headers=HEADERS, timeout=60)
            response.raise_for_status()
            if len(response.content) > 1000:
                output.write_bytes(response.content)
                print(f"[4/8] Downloaded {output.name} ({len(response.content)} bytes)", flush=True)
                return
            print(f"[4/8] {output.name} too small on attempt {attempt}: {len(response.content)} bytes", flush=True)
        except requests.RequestException as error:
            print(f"[4/8] {output.name} failed on attempt {attempt}: {error}", file=sys.stderr)
    raise RuntimeError(f"Failed to download {url}")


def merge_pdfs(parts, output):
    print(f"[5/8] Merging {len(parts)} PDFs...", flush=True)
    merger = PdfMerger(strict=False)
    try:
        for part in parts:
            if part.stat().st_size < 10:
                print(f"[5/8] Skip unsupported page: {part.name}", flush=True)
                continue
            merger.append(str(part))
        merger.write(str(output))
        print(f"[5/8] Merged to {output.name} ({output.stat().st_size} bytes)", flush=True)
    finally:
        merger.close()


def linearize_pdf(source, output):
    print(f"[6/8] Linearizing {source.name}...", flush=True)
    capture([QPDF_BIN, "--linearize", str(source), str(output)], allow_warning=True)
    check = capture([QPDF_BIN, "--check-linearization", str(output)], allow_warning=True)
    check_output = f"{check.stdout or ''}\n{check.stderr or ''}"
    if "no linearization errors" not in check_output:
        raise RuntimeError(f"qpdf linearization check failed for {output}")
    print(f"[6/8] Linearized to {output.name} ({output.stat().st_size} bytes)", flush=True)


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def protect_pdf(source, output):
    print(f"[7/8] Protecting {source.name}...", flush=True)
    decoded = output.with_suffix(".verified.pdf")
    try:
        run(["node", str(PROTECT_SCRIPT), "encode", str(source), str(output)])

        if output.stat().st_size != source.stat().st_size:
            raise RuntimeError("Protected PDF size changed, so byte ranges would no longer align")
        with output.open("rb") as file:
            if file.read(5) == b"%PDF-":
                raise RuntimeError("Protected PDF still exposes a plain PDF header")

        run(["node", str(PROTECT_SCRIPT), "decode", str(output), str(decoded)])
        if file_sha256(decoded) != file_sha256(source):
            raise RuntimeError("Protected PDF did not decode back to the linearized source")

        check = capture([QPDF_BIN, "--check-linearization", str(decoded)], allow_warning=True)
        check_output = f"{check.stdout or ''}\n{check.stderr or ''}"
        if "no linearization errors" not in check_output:
            raise RuntimeError(f"Decoded PDF failed qpdf linearization check: {output}")
    finally:
        decoded.unlink(missing_ok=True)

    print(f"[7/8] Protected and verified {output.name} ({output.stat().st_size} bytes)", flush=True)


def upload_pdf(day, protected_pdf):
    print(f"[8/8] Uploading to {remote_path(day)}...", flush=True)
    run(
        [
            "rclone",
            "copyto",
            str(protected_pdf),
            remote_path(day),
            "--header-upload",
            f"Cache-Control: {CACHE_CONTROL}",
            "--retries",
            "5",
            "--low-level-retries",
            "10",
        ]
    )
    local_size = protected_pdf.stat().st_size
    sample_size = min(32, local_size)
    offsets = sorted({0, max(0, (local_size - sample_size) // 2), local_size - sample_size})
    with protected_pdf.open("rb") as local_file:
        for offset in offsets:
            local_file.seek(offset)
            expected = local_file.read(sample_size)
            result = subprocess.run(
                [
                    "rclone",
                    "cat",
                    remote_path(day),
                    "--offset",
                    str(offset),
                    "--count",
                    str(len(expected)),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"Unable to read uploaded bytes at {offset}: {result.stderr.decode(errors='replace').strip()}"
                )
            if result.stdout != expected:
                raise RuntimeError(f"Uploaded bytes differ at offset {offset}")
    print("[8/8] Upload complete.", flush=True)


def archive_original(source, archive_root, day):
    if archive_root is None:
        return None
    destination = archive_root / f"{day:%Y}" / f"{day:%Y%m%d}.pdf"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".pdf.tmp")
    shutil.copy2(source, temporary)
    temporary.replace(destination)
    print(f"[5/8] Archived plain original to {destination}", flush=True)
    return destination


def sync_day(day, force=False, archive_root=None):
    exists = remote_exists(day)
    if exists and not force:
        print(f"{remote_path(day)} already exists, skip", flush=True)
        return
    if exists:
        print(f"Force enabled: overwriting {remote_path(day)}", flush=True)

    compact = day.strftime("%Y%m%d")
    day_dir = WORK_DIR / compact
    parts_dir = day_dir / "parts"
    merged_pdf = day_dir / f"{compact}.pdf"
    linearized_pdf = day_dir / f"{compact}.linearized.pdf"
    protected_pdf = day_dir / f"{compact}.protected.pdf"
    shutil.rmtree(day_dir, ignore_errors=True)
    parts_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    urls = get_page_urls(session, day)
    if not urls:
        raise RuntimeError(f"No RMRB pages found for {compact}")

    parts = []
    for index, url in enumerate(urls, start=1):
        part = parts_dir / f"rmrb{compact}{index:02d}.pdf"
        download_pdf(session, url, part)
        parts.append(part)

    merge_pdfs(parts, merged_pdf)
    archive_original(merged_pdf, archive_root, day)
    linearize_pdf(merged_pdf, linearized_pdf)
    protect_pdf(linearized_pdf, protected_pdf)
    upload_pdf(day, protected_pdf)
    shutil.rmtree(day_dir, ignore_errors=True)
    print(f"Done! {compact} synced successfully.", flush=True)


def parse_compact_date(value):
    if not re.fullmatch(r"\d{8}", value or ""):
        raise argparse.ArgumentTypeError("date must use YYYYMMDD")
    try:
        return date.fromisoformat(f"{value[:4]}-{value[4:6]}-{value[6:8]}")
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def load_state():
    if not STATE_FILE.exists():
        return {"version": 1, "completed": {}}
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    if state.get("version") != 1 or not isinstance(state.get("completed"), dict):
        raise RuntimeError(f"Invalid sync state: {STATE_FILE}")
    return state


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(STATE_FILE)


def date_range(start, end):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch, archive, linearize, protect, and upload RMRB daily PDFs to B2.")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--date", type=parse_compact_date, help="Date as YYYYMMDD. Default: today in runner timezone.")
    selection.add_argument("--from-date", type=parse_compact_date, help="First date in an inclusive date range.")
    parser.add_argument("--to-date", type=parse_compact_date, help="Last date in an inclusive date range.")
    parser.add_argument("--archive-root", type=Path, help="Save merged plain originals under <root>/<year>/<date>.pdf.")
    parser.add_argument("--continue-on-error", action="store_true", help="Continue a date range after a failed day.")
    parser.add_argument("--force", action="store_true", help="Overwrite the remote PDF if it already exists.")
    parser.add_argument("--resume", action="store_true", help="Skip dates already recorded as successfully uploaded.")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.to_date and not args.from_date:
        raise SystemExit("--to-date requires --from-date")
    start = args.from_date or args.date or date.today()
    end = args.to_date or start
    if start > end:
        raise SystemExit("--from-date must not be after --to-date")

    configure_rclone()
    state = load_state()
    failures = []
    completed = 0
    skipped = 0
    days = list(date_range(start, end))
    for index, target_day in enumerate(days, start=1):
        compact = target_day.strftime("%Y%m%d")
        if args.resume and compact in state["completed"]:
            skipped += 1
            print(f"[{index}/{len(days)}] SKIP {compact} (resume state)", flush=True)
            continue
        print(f"[{index}/{len(days)}] SYNC {compact}", flush=True)
        try:
            sync_day(target_day, force=args.force, archive_root=args.archive_root)
            state["completed"][compact] = {
                "completed_at": date.today().isoformat(),
                "remote": remote_path(target_day),
            }
            save_state(state)
            completed += 1
        except Exception as error:
            failures.append((compact, str(error)))
            print(f"[{index}/{len(days)}] FAILED {compact}: {error}", file=sys.stderr, flush=True)
            if not args.continue_on_error:
                raise

    print(f"Range complete: processed={completed} skipped={skipped} failed={len(failures)} state={STATE_FILE}", flush=True)
    if failures:
        raise RuntimeError(f"{len(failures)} date(s) failed; rerun with --resume after correcting them")


if __name__ == "__main__":
    main()
