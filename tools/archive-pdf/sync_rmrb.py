from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys

import requests
from PyPDF2 import PdfMerger
from delivery import DATASET, INDEX, Delivery, HuggingFace, issue_keys, prepare_issue, publish_issue


B2_BUCKET = os.environ.get("B2_BUCKET", "jojo-newspaper")
B2_REMOTE = os.environ.get("B2_REMOTE", "jojo-b2")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36",
}
WORK_DIR = Path(os.environ.get("RMRB_SYNC_WORK_DIR", ".rmrb-sync-work"))
REPO_ROOT = Path(__file__).resolve().parents[2]
PROTECT_SCRIPT = REPO_ROOT / "tools" / "archive-pdf" / "protect.mjs"


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
        # Do not log the credential-bearing command.
        subprocess.run(["rclone", "config", "create", B2_REMOTE, "b2", "account",
                        os.environ["B2_KEY_ID"], "key", os.environ["B2_APPLICATION_KEY"],
                        "--non-interactive"], check=True, stdout=subprocess.DEVNULL)


def delivery_remote():
    return os.environ.get("JOJO_DELIVERY_REMOTE") or f"{B2_REMOTE}:{B2_BUCKET}"


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
            raise RuntimeError(f"Page {page:02d} has no PDF; refusing to publish an incomplete issue")
    return urls


def get_page_urls(session, day):
    return new_layout_urls(session, day)


def download_pdf(session, url, output):
    for attempt in range(1, 6):
        try:
            response = session.get(url, headers=HEADERS, timeout=60)
            response.raise_for_status()
            if len(response.content) > 1000 and response.content.startswith(b"%PDF-"):
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
    capture(["qpdf", "--linearize", str(source), str(output)], allow_warning=True)
    check = capture(["qpdf", "--check-linearization", str(output)], allow_warning=True)
    check_output = f"{check.stdout or ''}\n{check.stderr or ''}"
    if "no linearization errors" not in check_output:
        raise RuntimeError(f"qpdf linearization check failed for {output}")
    print(f"[6/8] Linearized to {output.name} ({output.stat().st_size} bytes)", flush=True)


def obtain_pdf(day, day_dir, canonical, delivery, *, reuse_legacy=False, refresh=False):
    item_key, pdf_key, _ = issue_keys(day)
    existing = canonical.read(item_key)
    if existing and not refresh:
        asset = next((a for a in existing.get("assets", []) if a.get("type") == "pdf"), None)
        if asset:
            path = canonical.file("newspapers/rmrb/" + asset["path"])
            if path:
                return path
    if reuse_legacy:
        # Migration input only; no reader or publisher writes this old prefix.
        compact = day.strftime("%Y%m%d")
        old_key = f"RMRB/{day:%Y}/{compact}.pdf"
        old_pdf = delivery.file(old_key)
        if old_pdf:
            decoded = day_dir / f"{compact}.source.pdf"
            if old_pdf.read_bytes()[:5] == b"%PDF-":
                return old_pdf
            run(["node", str(PROTECT_SCRIPT), "decode", str(old_pdf), str(decoded)])
            return decoded
    parts_dir = day_dir / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    with requests.Session() as session:
        urls = get_page_urls(session, day)
        if not urls:
            raise RuntimeError(f"No RMRB pages found for {day}")
        parts = []
        for index, url in enumerate(urls, start=1):
            part = parts_dir / f"{index:02d}.pdf"
            download_pdf(session, url, part)
            parts.append(part)
    merged = day_dir / "merged.pdf"
    merged.unlink(missing_ok=True)
    merge_pdfs(parts, merged)
    return merged


def sync_day(day, force=False, *, dry_run=False, reuse_legacy=False):
    day_dir = WORK_DIR / day.strftime("%Y%m%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    canonical = HuggingFace()
    delivery = Delivery(delivery_remote(), day_dir)
    _, _, manifest_key = issue_keys(day)
    manifest = delivery.read(manifest_key)
    index = delivery.read(INDEX)
    if manifest and not force:
        pdf = next((a for a in manifest.get("assets", []) if a.get("type") == "pdf"), None)
        canonical_item = canonical.read(issue_keys(day)[0])
        canonical_pdf = next((a for a in (canonical_item or {}).get("assets", []) if a.get("type") == "pdf"), None)
        if pdf and canonical_pdf and pdf.get("sha256") == canonical_pdf.get("sha256"):
            from jojo_format import _available_dates
            if day.isoformat() in _available_dates((index or {})["availability"]["pdf"]):
                # Verify the media exists as well; interrupted metadata-only copies aren't complete.
                key = manifest_key.removesuffix("manifest.jox") + pdf["object"]
                check = subprocess.run(["rclone", "lsjson", f"{delivery.remote}/{key}", "--stat"], capture_output=True)
                if check.returncode == 0 and json.loads(check.stdout).get("Size") == pdf["size"]:
                    print(f"{day}: already published in Delivery", flush=True)
                    return {"date": day.isoformat(), "asset": key, "manifest": manifest_key, "index": INDEX, "published": True}
                if check.returncode not in (0, 3, 4):
                    raise RuntimeError(f"Unable to check published PDF: {check.stderr.decode(errors='replace')[:500]}")
    source = obtain_pdf(day, day_dir, canonical, delivery, reuse_legacy=reuse_legacy and not force, refresh=force)
    linearized = day_dir / "linearized.pdf"
    linearized.unlink(missing_ok=True)
    linearize_pdf(source, linearized)
    plan = prepare_issue(day, linearized, canonical, delivery, day_dir)
    if not dry_run:
        publish_issue(day, plan, canonical, delivery)
    report = {"date": day.isoformat(), "asset": plan["asset"], "manifest": plan["manifest"], "index": INDEX,
              "canonicalFiles": list(plan["canonical"]), "deliveryFiles": list(plan["delivery"]), "published": not dry_run}
    (day_dir / "publication.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"{day}: {'staged' if dry_run else 'published'} Canonical and Delivery", flush=True)
    return report


def compact_date(value):
    if not re.fullmatch(r"\d{8}", value):
        raise argparse.ArgumentTypeError("Date must be YYYYMMDD")
    try:
        return date.fromisoformat(f"{value[:4]}-{value[4:6]}-{value[6:8]}")
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def parse_args():
    parser = argparse.ArgumentParser(description="Publish RMRB PDF to HF Canonical and B2 Jox Delivery.")
    parser.add_argument("--date", type=compact_date, default=datetime.now(ZoneInfo("Asia/Shanghai")).date())
    parser.add_argument("--start-date", type=compact_date, help="Backfill an inclusive date range ending at --date.")
    parser.add_argument("--catch-up", action="store_true", help="Resume from the Delivery PDF calendar's last date.")
    parser.add_argument("--reuse-legacy", action="store_true", help="Use old B2 PDFs as migration input when Canonical lacks them.")
    parser.add_argument("--force", action="store_true", help="Refresh the source PDF and publish a new immutable asset.")
    parser.add_argument("--dry-run", action="store_true", help="Stage exact publication files locally without uploading.")
    return parser.parse_args()


def main():
    args = parse_args()
    configure_rclone()
    first = args.start_date or args.date
    if args.catch_up:
        index = Delivery(delivery_remote(), WORK_DIR / "index").read(INDEX)
        if not index:
            raise RuntimeError("Published RMRB Delivery index is required")
        first = min(first, date.fromisoformat(index["availability"]["pdf"]["endDate"]) + timedelta(days=1))
    if first > args.date:
        raise ValueError("--start-date must not be after --date")
    reports = []
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    report_path = WORK_DIR / "publication.json"
    report_path.write_text("[]\n", encoding="utf-8")
    day = first
    while day <= args.date:
        report = sync_day(day, force=args.force, dry_run=args.dry_run, reuse_legacy=args.reuse_legacy)
        if report:
            reports.append(report)
            report_path.write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")
        day += timedelta(days=1)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    (WORK_DIR / "publication.json").write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
