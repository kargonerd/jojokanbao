import importlib.util
import json
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "merge_rmrb_peopledata_xlsx.py"
SPEC = importlib.util.spec_from_file_location("merge_rmrb_peopledata_xlsx", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_choose_prefers_exact_title_on_the_same_page():
    canonical = {"page": 2, "title": "在福冈"}
    candidates = [
        {"page": 1, "title": "在福冈", "content": "错误版次"},
        {"page": 2, "title": "在 福冈", "content": "正确正文"},
    ]
    selected, method = MODULE.choose(canonical, candidates)
    assert selected["content"] == "正确正文"
    assert method == "exact_title"


def test_choose_does_not_guess_between_distinct_duplicate_bodies():
    canonical = {"page": 2, "title": "更正"}
    candidates = [
        {"page": 2, "title": "更正", "content": "第一则"},
        {"page": 2, "title": "更正", "content": "第二则"},
    ]
    selected, method = MODULE.choose(canonical, candidates)
    assert selected is None
    assert method == "ambiguous"


def test_choose_matches_short_catalog_title_to_jsonl_title_with_author():
    canonical = {"page": 4, "title": "失明以后"}
    candidates = [
        {
            "page": 4,
            "title": "失明以后\n毕国顺",
            "content": "残疾人参与社会征文\n\n失明以后\n毕国顺\n完整正文",
        }
    ]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert selected["content"].endswith("完整正文")
    assert method == "exact_primary_title"


def test_choose_keeps_distinct_same_title_bylines_ambiguous():
    canonical = {"page": 2, "title": "更正"}
    candidates = [
        {"page": 2, "title": "更正\n张三", "content": "第一则"},
        {"page": 2, "title": "更正\n李四", "content": "第二则"},
    ]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is None
    assert method == "ambiguous"


def test_choose_matches_catalog_title_after_image_suffix_is_removed():
    canonical = {"page": 2, "title": "缉私"}
    candidates = [{"page": 2, "title": "缉私（图片）\n高诗林", "content": "【图片】"}]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert method == "exact_title_variant"


def test_choose_matches_image_caption_to_catalog_title():
    canonical = {"page": 2, "title": "麦收"}
    candidates = [{"page": 2, "title": "图片\n邹雅", "content": "麦收\n邹雅刻"}]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert method == "exact_title_variant"


def test_choose_normalizes_image_marker_on_both_sides():
    canonical = {"page": 4, "title": "图片 短命的高兴"}
    candidates = [
        {"page": 4, "title": "短命的高兴（图片）\n邹雅", "content": "短命的高兴"}
    ]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert method == "exact_title_variant"


def test_choose_matches_image_title_component_inside_long_catalog_title():
    canonical = {"page": 3, "title": "王克勤爱民如母 模范战士连环画"}
    candidates = [
        {"page": 3, "title": "王克勤爱民如母（图片）\n高诗林", "content": "图画正文"}
    ]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert method == "exact_title_component"


def test_choose_matches_reordered_headline_parts_by_exact_characters():
    canonical = {"page": 1, "title": "解放日报社论 一年的教训"}
    candidates = [
        {"page": 1, "title": "一年的教训  解放日报社论", "content": "社论正文"}
    ]

    selected, method = MODULE.choose(canonical, candidates)

    assert selected is not None
    assert method == "exact_title_characters"


def test_choose_uses_repeated_jsonl_title_to_validate_one_character_correction():
    canonical = {"date": "1947-08-31", "page": 2, "title": "黄河防汛记"}
    candidates = [
        {"page": 2, "title": "黄河防泛记\n君·谦", "content": "第二篇独立正文"}
    ]

    selected, method = MODULE.choose(
        canonical,
        candidates,
        jsonl_title_counts=Counter({"黄河防泛记": 2}),
        directory_title_counts=Counter({"黄河防泛记": 1}),
        self_validated_jsonl_titles={"黄河防泛记"},
        reviewed_title_corrections={
            ("1947-08-31", 2, "黄河防泛记", "黄河防汛记")
        },
    )

    assert selected is not None
    assert method == "reviewed_jsonl_one_character_correction"


def test_choose_does_not_generalize_one_character_correction_without_review():
    canonical = {"date": "1947-08-31", "page": 2, "title": "黄河防汛记"}
    candidates = [
        {"page": 2, "title": "黄河防泛记\n君·谦", "content": "正文"}
    ]

    selected, method = MODULE.choose(
        canonical,
        candidates,
        jsonl_title_counts=Counter({"黄河防泛记": 2}),
        directory_title_counts=Counter({"黄河防泛记": 1}),
        self_validated_jsonl_titles={"黄河防泛记"},
        reviewed_title_corrections=set(),
    )

    assert selected is None
    assert method == "ambiguous"


def test_merge_preserves_an_unaligned_jsonl_body_instead_of_silently_dropping_it(tmp_path: Path):
    directory = tmp_path / "directory.sqlite3"
    connection = sqlite3.connect(directory)
    connection.executescript(
        """
        CREATE TABLE issues (issue_date TEXT PRIMARY KEY, result_count INTEGER NOT NULL);
        CREATE TABLE articles (
            issue_date TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            page_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            href TEXT
        );
        INSERT INTO issues VALUES ('1988-09-09', 1);
        INSERT INTO articles VALUES ('1988-09-09', 47, 4, '失明以后', '/article');
        """
    )
    connection.commit()
    connection.close()
    source = tmp_path / "source.jsonl"
    source.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False) + "\n"
            for row in (
                {
                    "date": "1988-09-09",
                    "page": 4,
                    "title": "失明以后\n毕国顺",
                    "content": "完整正文",
                },
                {
                    "date": "1988-09-09",
                    "page": 4,
                    "title": "未进入目录的原正文",
                    "content": "也不能静默丢弃",
                },
            )
        ),
        encoding="utf-8",
    )
    output = tmp_path / "merged.jsonl"
    report = tmp_path / "report.json"
    orphans = tmp_path / "orphans.jsonl"
    result = subprocess.run(
        [
            sys.executable,
            str(MODULE_PATH),
            "--directory",
            str(directory),
            "--jsonl",
            str(source),
            "--xlsx-root",
            str(tmp_path / "xlsx"),
            "--output",
            str(output),
            "--unmatched",
            str(tmp_path / "missing.jsonl"),
            "--jsonl-orphans",
            str(orphans),
            "--report",
            str(report),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    merged = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert merged[0]["content"] == "完整正文"
    assert merged[0]["matchMethod"] == "exact_primary_title"
    assert merged[1] == {
        "date": "1988-09-09",
        "page": 4,
        "ordinal": 48,
        "title": "未进入目录的原正文",
        "href": None,
        "content": "也不能静默丢弃",
        "contentSource": "jsonl",
        "matchMethod": "jsonl_source_preserved",
        "sourceOnly": True,
    }
    audit = json.loads(report.read_text(encoding="utf-8"))
    assert audit["safeToPublish"] is True
    assert audit["counters"]["jsonlMatchedContentRows"] == 1
    assert audit["counters"]["jsonlPreservedSourceOnlyRows"] == 1
    assert audit["counters"]["jsonlOrphanedContentRows"] == 0
    orphan_rows = [json.loads(line) for line in orphans.read_text(encoding="utf-8").splitlines()]
    assert orphan_rows[0]["title"] == "未进入目录的原正文"
    assert orphan_rows[0]["alignmentReason"] == "unmatched_on_peopledata_date"
    assert orphan_rows[0]["preservedOrdinal"] == 48
