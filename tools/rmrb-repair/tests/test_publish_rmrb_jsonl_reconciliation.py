import hashlib
import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "publish_rmrb_jsonl_reconciliation.py"
SPEC = importlib.util.spec_from_file_location("publish_rmrb_jsonl_reconciliation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC.loader.exec_module(MODULE)


def write_row(path: Path, row: dict):
    path.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")


def test_final_report_validation_and_remote_paths(tmp_path: Path):
    upserts = tmp_path / "upserts.jsonl"
    removals = tmp_path / "removals.jsonl"
    write_row(upserts, {
        "date": "1988-09-09", "page": 4, "ordinal": 47,
        "title": "失明以后", "content": "正文", "matchMethod": "human_review_merge_candidate",
    })
    write_row(removals, {
        "date": "1988-09-08", "page": 4, "ordinal": 93,
        "title": "失明以后", "content": "正文", "matchMethod": "jsonl_directory_omission",
    })
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps({
        "safe": True,
        "upsertsPath": str(upserts.resolve()),
        "upsertsSha256": hashlib.sha256(upserts.read_bytes()).hexdigest(),
        "upsertRows": 1,
        "removalsPath": str(removals.resolve()),
        "removalsSha256": hashlib.sha256(removals.read_bytes()).hexdigest(),
        "removeObsoleteRows": 1,
    }), encoding="utf-8")

    report = MODULE.validate_final_report(report_path, upserts, removals)
    loaded_upserts = MODULE.load_rows(upserts)
    loaded_removals = MODULE.load_rows(removals)

    assert report["safe"] is True
    assert "newspapers/rmrb/data/articles/1988.jsonl.gz" in MODULE.hf_patterns(
        loaded_upserts, loaded_removals,
    )
    assert any(path.endswith("1988-09-08/manifest.jox") for path in MODULE.delivery_paths(
        loaded_upserts, loaded_removals,
    ))


def test_seeded_file_selects_year_stage(tmp_path: Path):
    expected = (
        tmp_path / "1988" / "canonical" / "newspapers/rmrb/data/articles/1988.jsonl.gz"
    )
    expected.parent.mkdir(parents=True)
    expected.write_bytes(b"seed")

    assert MODULE.seeded_file(
        tmp_path, "canonical", "newspapers/rmrb/data/articles/1988.jsonl.gz",
    ) == expected

