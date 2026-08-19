import gzip
import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "prepare_rmrb_publication.py"
SPEC = importlib.util.spec_from_file_location("prepare_rmrb_publication", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def test_prepare_keeps_missing_and_reuses_legacy_pdf_key(tmp_path: Path) -> None:
    review = tmp_path / "review"
    merged = review / "merged.jsonl"
    write_jsonl(merged, [
        {"date": "1950-01-01", "page": 1, "ordinal": 0, "title": "第一篇", "content": "第一篇\n\n正文。", "contentSource": "jsonl", "matchMethod": "exact_title", "href": "/one"},
        {"date": "1950-01-01", "page": 2, "ordinal": 1, "title": "缺失篇", "content": "", "contentSource": None, "matchMethod": None, "href": "/two"},
        {"date": "1950-01-02", "page": 1, "ordinal": 0, "title": "修复篇", "content": "", "contentSource": None, "matchMethod": None, "href": "/three"},
    ])
    write_jsonl(review / "manual-review-decisions-workbench.jsonl", [{
        "date": "1950-01-02", "page": 1, "peopleDataOrdinal": 0,
        "decision": "accept", "content": "修复正文。（人民数据库资料）",
    }])
    output = tmp_path / "output"
    args = MODULE.parser().parse_args([
        "--merged", str(merged), "--review-root", str(review),
        "--output", str(output), "--skip-audit",
    ])
    report = MODULE.prepare(args)
    assert report["itemCount"] == 2
    assert report["articleStatuses"] == {"available": 1, "missing": 1, "repaired": 1}
    with gzip.open(output / "canonical/newspapers/rmrb/items/1950/01/1950-01-01.json.gz", "rt", encoding="utf-8") as stream:
        item = json.load(stream)
    assert item["content"]["articles"][0]["body"]["value"] == "正文。"
    assert item["content"]["articles"][1]["body"]["value"] == ""
    assert item["title"] == "人民日报 1950年1月1日"
    assert item["extensions"]["rmrb"]["legacyPdfObject"] == "RMRB/1950/19500101.pdf"
    assert report["legacyPdfBytesCopied"] == 0
    assert (output / "huggingface/rmrb/items/1950/01/1950-01-01.json.gz").is_file()


def test_image_decision_creates_hashed_asset(tmp_path: Path) -> None:
    review = tmp_path / "review"
    image = tmp_path / "image.jpg"
    image.write_bytes(b"fake-jpeg")
    digest = MODULE.sha256_file(image)
    merged = review / "merged.jsonl"
    write_jsonl(merged, [{
        "date": "1951-01-01", "page": 1, "ordinal": 4, "title": "图片",
        "content": "", "contentSource": None, "matchMethod": None, "href": "/image",
    }])
    write_jsonl(review / "manual-review-decisions-peopledata-image-auto.jsonl", [{
        "date": "1951-01-01", "page": 1, "peopleDataOrdinal": 4,
        "decision": "accept", "content": "【图片】", "evidence": [str(image)],
        "imageSha256": digest,
    }])
    output = tmp_path / "output"
    args = MODULE.parser().parse_args([
        "--merged", str(merged), "--review-root", str(review),
        "--output", str(output), "--skip-audit",
    ])
    report = MODULE.prepare(args)
    assert report["articleStatuses"] == {"image": 1}
    assert (output / f"canonical/newspapers/rmrb/assets/{digest}.jpg").read_bytes() == b"fake-jpeg"


def test_date_range_flushes_last_selected_day(tmp_path: Path) -> None:
    review = tmp_path / "review"
    merged = review / "merged.jsonl"
    write_jsonl(merged, [
        {"date": "1950-01-01", "page": 1, "ordinal": 0, "title": "跳过", "content": "正文"},
        {"date": "1950-01-02", "page": 1, "ordinal": 0, "title": "保留", "content": "正文"},
        {"date": "1950-01-03", "page": 1, "ordinal": 0, "title": "停止", "content": "正文"},
    ])
    output = tmp_path / "output"
    args = MODULE.parser().parse_args([
        "--merged", str(merged), "--review-root", str(review), "--output", str(output),
        "--start-date", "1950-01-02", "--end-date", "1950-01-02", "--skip-audit",
    ])
    report = MODULE.prepare(args)
    assert report["dateRange"] == {"start": "1950-01-02", "end": "1950-01-02"}
    assert report["itemCount"] == 1
