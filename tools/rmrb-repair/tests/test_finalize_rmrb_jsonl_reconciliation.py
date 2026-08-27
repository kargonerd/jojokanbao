import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "finalize_rmrb_jsonl_reconciliation.py"
SPEC = importlib.util.spec_from_file_location("finalize_rmrb_jsonl_reconciliation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def source(day: str, page: int, ordinal: int, title: str, content: str):
    return {
        "date": day,
        "page": page,
        "preservedOrdinal": ordinal,
        "title": title,
        "content": content,
    }


def test_finalize_accounts_for_every_source_and_builds_minimal_migration():
    old_moved = source("1950-01-02", 3, 10, "旧日期题", "正文甲")
    new_omission = source("1950-01-02", 2, 20, "目录漏收", "正文乙")
    human_merge = source("1950-01-03", 3, 30, "人工判断", "正文丙")
    original = [old_moved, new_omission, human_merge]
    accepted = [
        {
            "date": "1950-01-02",
            "page": 1,
            "ordinal": 5,
            "title": "正确目录题",
            "content": "正文甲",
            "contentSource": "jsonl",
            "matchMethod": "exact_title_whitespace_same_date",
            "sourceOrdinal": 10,
            "sourceTitle": "旧日期题",
        },
        {
            "date": "1950-01-02",
            "page": 2,
            "ordinal": 20,
            "title": "目录漏收",
            "content": "正文乙",
            "contentSource": "jsonl",
            "matchMethod": "jsonl_directory_omission",
        },
    ]
    review = [{
        **human_merge,
        "nearbyExactMatches": [{
            "date": "1950-01-04",
            "page": 3,
            "ordinal": 7,
            "title": "人工判断",
        }],
    }]
    decisions = [{
        "date": "1950-01-03",
        "page": 3,
        "preservedOrdinal": 30,
        "sourceFingerprint": MODULE.source_fingerprint(review[0]),
        "resolution": "merge_candidate",
        "candidate": {
            "candidateKey": "1950-01-04|3|7",
            "date": "1950-01-04",
            "page": 3,
            "ordinal": 7,
            "title": "人工判断",
        },
    }]
    previous = [{
        "date": "1950-01-02",
        "page": 3,
        "ordinal": 10,
        "title": "旧日期题",
        "content": "正文甲",
        "contentSource": "jsonl",
        "matchMethod": "jsonl_directory_omission",
    }]

    final, upserts, removals, report = MODULE.finalize(
        original, accepted, review, decisions, previous,
    )

    assert len(final) == 3
    assert set(upserts) == {
        ("1950-01-02", 1, 5),
        ("1950-01-02", 2, 20),
        ("1950-01-04", 3, 7),
    }
    assert set(removals) == {("1950-01-02", 3, 10)}
    assert report["safe"] is True
    assert report["finalDirectoryOmissionRows"] == 1
    assert report["finalPeopleDataAlignedRows"] == 2
    assert report["humanMergeCandidateRows"] == 1
