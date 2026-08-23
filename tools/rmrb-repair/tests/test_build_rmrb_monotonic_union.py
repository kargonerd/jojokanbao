import importlib.util
import json
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "build_rmrb_monotonic_union.py"
SPEC = importlib.util.spec_from_file_location("build_rmrb_monotonic_union", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def test_monotonic_union_keeps_baseline_applies_recovery_and_preserves_orphan(tmp_path: Path):
    baseline = tmp_path / "baseline.jsonl"
    source = tmp_path / "source.jsonl"
    recoveries = tmp_path / "recoveries.jsonl"
    output = tmp_path / "union.jsonl"
    source_only = tmp_path / "source-only.jsonl"
    report = tmp_path / "report.json"
    write_jsonl(baseline, [
        {"date": "1988-09-09", "page": 4, "ordinal": 1, "title": "已有", "content": "已有正文"},
        {"date": "1988-09-09", "page": 4, "ordinal": 2, "title": "失明以后", "content": ""},
        {"date": "1988-09-09", "page": 5, "ordinal": 3, "title": "仍缺", "content": ""},
    ])
    write_jsonl(source, [
        {"date": "1988-09-09", "page": 4, "title": "已有\n甲", "content": "已有正文"},
        {"date": "1988-09-09", "page": 4, "title": "失明以后\n毕国顺", "content": "恢复正文"},
        {"date": "1988-09-09", "page": 6, "title": "无法对齐\n乙", "content": "不可丢正文"},
    ])
    write_jsonl(recoveries, [{
        "date": "1988-09-09",
        "page": 4,
        "peopleDataOrdinal": 2,
        "decision": "accept",
        "content": "恢复正文",
        "matchMethod": "exact_primary_title",
    }])

    result = MODULE.build(baseline, source, recoveries, output, report, source_only)
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

    assert result["safeToPublish"] is True
    assert result["counters"]["jsonlContentRows"] == 3
    assert result["counters"]["jsonlAlreadyRepresentedRows"] == 2
    assert result["counters"]["jsonlPreservedSourceOnlyRows"] == 1
    assert result["counters"]["jsonlOrphanedContentRows"] == 0
    assert rows[1]["content"] == "恢复正文"
    assert rows[2]["content"] == ""
    assert rows[3]["sourceOnly"] is True
    assert rows[3]["content"] == "不可丢正文"
    assert [json.loads(line) for line in source_only.read_text(encoding="utf-8").splitlines()] == [rows[3]]
