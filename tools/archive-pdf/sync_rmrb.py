from dataclasses import dataclass
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
from pypdf import PdfWriter
from pypdf.generic import Fit
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


@dataclass(frozen=True)
class PageSource:
    """One printed page plus the article rectangles the publisher exposes."""

    url: str
    label: str
    image_width: int | None
    image_height: int | None
    # (title, (min_x, min_y, max_x, max_y)) in layout-image pixels, reading order.
    articles: tuple[tuple[str, tuple[float, float, float, float]], ...]


NEWS_LIST = re.compile(r'<ul class="news-list">(.*?)</ul>', re.S)
ARTICLE_LINK = re.compile(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.S)
CONTENT_ID = re.compile(r"content_\d+")
AREA_TAG = re.compile(r"<Area\b[^>]*>", re.I)


def plain_text(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", value)).strip()


def parse_page_source(html, url, page):
    label_match = re.search(r"第\s*0?\d+\s*版[：:]\s*([^<\r\n]+)", html)
    label = plain_text(label_match.group(1)) if label_match else ""
    image = re.search(r'<img[^>]*width="(\d+)"[^>]*height="(\d+)"', html)
    image_width, image_height = (int(image.group(1)), int(image.group(2))) if image else (None, None)

    titles = {}
    order = []
    block = NEWS_LIST.search(html)
    if block:
        for link in ARTICLE_LINK.finditer(block.group(1)):
            content = CONTENT_ID.search(link.group(1))
            title = plain_text(link.group(2))
            if content and title and content.group(0) not in titles:
                titles[content.group(0)] = title
                order.append(content.group(0))

    boxes = {}
    for tag in AREA_TAG.findall(html):
        coords = re.search(r'coords="([^"]+)"', tag, re.I)
        href = re.search(r'href="([^"]*)"', tag, re.I)
        if not coords or not href:
            continue
        content = CONTENT_ID.search(href.group(1))
        try:
            values = [float(value) for value in coords.group(1).split(",") if value.strip()]
        except ValueError:
            continue
        if content and len(values) >= 4:
            boxes.setdefault(content.group(0), []).append(values)

    articles = []
    for content in order:
        values = (boxes.get(content) or [None])[0]
        if values is None:
            continue
        xs = values[0::2]
        ys = values[1::2]
        if xs and ys:
            articles.append((titles[content], (min(xs), min(ys), max(xs), max(ys))))
    return PageSource(
        url=url, label=label or f"第{page:02d}版",
        image_width=image_width, image_height=image_height,
        articles=tuple(articles),
    )


def new_layout_pages(session, day):
    dated_path = day.strftime("%Y%m/%d")
    cover_url = f"http://paper.people.com.cn/rmrb/pc/layout/{dated_path}/node_01.html"
    print(f"[3/8] Fetching page list from {cover_url}...", flush=True)
    text = get_text(session, cover_url)
    page_count = len(re.findall("pageLink", text))
    print(f"[3/8] Found {page_count} pages.", flush=True)
    sources = []

    for page in range(1, page_count + 1):
        page_url = f"http://paper.people.com.cn/rmrb/pc/layout/{dated_path}/node_{page:02d}.html"
        page_text = get_text(session, page_url)
        matches = re.findall(r"attachement.*?\.pdf", page_text)
        if matches:
            pdf_url = "http://paper.people.com.cn/rmrb/pc/" + matches[0]
            sources.append(parse_page_source(page_text, pdf_url, page))
            print(f"[3/8] Page {page:02d}: {pdf_url} ({len(sources[-1].articles)} articles)", flush=True)
        else:
            raise RuntimeError(f"Page {page:02d} has no PDF; refusing to publish an incomplete issue")
    return sources


def get_page_sources(session, day):
    return new_layout_pages(session, day)


def get_page_urls(session, day):
    return [source.url for source in new_layout_pages(session, day)]


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


def bookmark_rect(bbox, image_width, image_height, page_width, page_height):
    """Convert an image-map box into the bottom-left PDF rectangle FitR expects."""
    min_x, min_y, max_x, max_y = bbox
    left = min_x / image_width * page_width
    right = max_x / image_width * page_width
    top = page_height - min_y / image_height * page_height
    bottom = page_height - max_y / image_height * page_height
    left, right = max(0.0, min(left, right)), min(page_width, max(left, right))
    bottom, top = max(0.0, min(bottom, top)), min(page_height, max(bottom, top))
    if right <= left or top <= bottom:
        return None
    return (left, bottom, right, top)


def merge_pdfs(parts, output):
    print(f"[5/8] Merging {len(parts)} PDFs...", flush=True)
    writer = PdfWriter()
    for part, source in parts:
        if part.stat().st_size < 10:
            print(f"[5/8] Skip unsupported page: {part.name}", flush=True)
            continue
        page_index = len(writer.pages)
        writer.append(str(part))
        page = writer.pages[page_index]
        page_width = float(page.mediabox.width)
        page_height = float(page.mediabox.height)
        parent = writer.add_outline_item(title=source.label, page_number=page_index, fit=Fit.fit())
        if source.image_width and source.image_height and page.rotation % 360 == 0:
            for title, bbox in source.articles:
                rect = bookmark_rect(bbox, source.image_width, source.image_height, page_width, page_height)
                if rect:
                    writer.add_outline_item(
                        title=title, page_number=page_index, parent=parent,
                        fit=Fit.fit_rectangle(*rect),
                    )
    with output.open("wb") as stream:
        writer.write(stream)
    print(f"[5/8] Merged to {output.name} ({output.stat().st_size} bytes)", flush=True)


def linearize_pdf(source, output):
    print(f"[6/8] Linearizing {source.name}...", flush=True)
    capture(["qpdf", "--linearize", str(source), str(output)], allow_warning=True)
    check = capture(["qpdf", "--check-linearization", str(output)], allow_warning=True)
    check_output = f"{check.stdout or ''}\n{check.stderr or ''}"
    if "no linearization errors" not in check_output:
        raise RuntimeError(f"qpdf linearization check failed for {output}")
    print(f"[6/8] Linearized to {output.name} ({output.stat().st_size} bytes)", flush=True)


def obtain_pdf(day, day_dir, canonical, delivery, *, reuse_legacy=False, refresh=False, source_dir=None):
    item_key, pdf_key, _ = issue_keys(day)
    existing = canonical.read(item_key)
    if existing and not refresh:
        asset = next((a for a in existing.get("assets", []) if a.get("type") == "pdf"), None)
        if asset:
            path = canonical.file("newspapers/rmrb/" + asset["path"])
            if path:
                return path
    if source_dir is not None:
        local = source_dir / f"{day:%Y%m%d}.pdf"
        if not local.is_file():
            raise FileNotFoundError(f"Missing local source PDF: {local}")
        with local.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise ValueError(f"Local source is not a PDF: {local}")
        print(f"[4/8] Using local source {local} ({local.stat().st_size} bytes)", flush=True)
        return local
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
        sources = get_page_sources(session, day)
        if not sources:
            raise RuntimeError(f"No RMRB pages found for {day}")
        parts = []
        for index, source in enumerate(sources, start=1):
            part = parts_dir / f"{index:02d}.pdf"
            download_pdf(session, source.url, part)
            parts.append((part, source))
    merged = day_dir / "merged.pdf"
    merged.unlink(missing_ok=True)
    merge_pdfs(parts, merged)
    return merged


def sync_day(day, force=False, *, dry_run=False, reuse_legacy=False, source_dir=None):
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
    source = obtain_pdf(day, day_dir, canonical, delivery, reuse_legacy=reuse_legacy and not force, refresh=force, source_dir=source_dir)
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
    parser.add_argument("--source-dir", type=Path, help="Use local YYYYMMDD.pdf files instead of downloading from paper.people.com.cn.")
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
        report = sync_day(day, force=args.force, dry_run=args.dry_run, reuse_legacy=args.reuse_legacy, source_dir=args.source_dir)
        if report:
            reports.append(report)
            report_path.write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")
        day += timedelta(days=1)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    (WORK_DIR / "publication.json").write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
