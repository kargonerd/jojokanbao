import gzip
import importlib.util
import json
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "recover_rmrb_missing_from_jsonl.py"
SPEC = importlib.util.spec_from_file_location("recover_rmrb_missing_from_jsonl", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC.loader.exec_module(MODULE)


def test_recover_uses_current_missing_queue_and_jsonl_body(tmp_path: Path):
    source = tmp_path / "source.jsonl"
    source.write_text(
        json.dumps(
            {
                "date": "1988-09-09",
                "page": 4,
                "title": "失明以后\n毕国顺",
                "content": "完整正文",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    missing = tmp_path / "missing.jsonl.gz"
    with gzip.open(missing, "wt", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                {"date": "1988-09-09", "page": 4, "ordinal": 47, "title": "失明以后"},
                ensure_ascii=False,
            )
            + "\n"
        )
    output = tmp_path / "decisions.jsonl"
    report_path = tmp_path / "report.json"

    report = MODULE.recover(source, missing, output, report_path)

    decisions = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert decisions == [
        {
            "date": "1988-09-09",
            "page": 4,
            "peopleDataOrdinal": 47,
            "title": "失明以后",
            "decision": "accept",
            "content": "完整正文",
            "reason": "Recovered from trusted legacy JSONL without changing PeopleData catalog metadata",
            "recoverySource": "jsonl",
            "matchMethod": "exact_primary_title",
            "sourceTitle": "失明以后\n毕国顺",
        }
    ]
    assert report["counters"]["recoveredRows"] == 1


def test_recover_withholds_fuzzy_match_from_publishable_decisions(tmp_path: Path):
    source = tmp_path / "source.jsonl"
    source.write_text(
        json.dumps(
            {
                "date": "1988-09-09",
                "page": 4,
                "title": "这是一个足够长的旧标题版本",
                "content": "完整正文",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    missing = tmp_path / "missing.jsonl.gz"
    with gzip.open(missing, "wt", encoding="utf-8") as stream:
        stream.write(
            json.dumps(
                {
                    "date": "1988-09-09",
                    "page": 4,
                    "ordinal": 47,
                    "title": "这是一个足够长的标题版本",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    output = tmp_path / "decisions.jsonl"

    report = MODULE.recover(source, missing, output, tmp_path / "report.json")

    assert output.read_text(encoding="utf-8") == ""
    assert report["counters"]["withheld_fuzzy_title"] == 1


def test_recover_requires_reciprocal_uniqueness_for_title_segments(tmp_path: Path):
    source = tmp_path / "source.jsonl"
    source.write_text(
        json.dumps(
            {
                "date": "1946-01-01",
                "page": 1,
                "title": "主标题  子标题",
                "content": "完整正文",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    missing = tmp_path / "missing.jsonl.gz"
    with gzip.open(missing, "wt", encoding="utf-8") as stream:
        for ordinal, title in enumerate(("主标题", "子标题")):
            stream.write(
                json.dumps(
                    {
                        "date": "1946-01-01",
                        "page": 1,
                        "ordinal": ordinal,
                        "title": title,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    output = tmp_path / "decisions.jsonl"

    report = MODULE.recover(source, missing, output, tmp_path / "report.json")

    assert output.read_text(encoding="utf-8") == ""
    assert report["counters"]["withheld_nonreciprocal_exact_title_variant"] == 2
