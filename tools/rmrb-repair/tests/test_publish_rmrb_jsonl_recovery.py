import importlib.util
import json
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "publish_rmrb_jsonl_recovery.py"
SPEC = importlib.util.spec_from_file_location("publish_rmrb_jsonl_recovery", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC.loader.exec_module(MODULE)


def test_load_decisions_and_remote_paths(tmp_path: Path):
    path = tmp_path / "decisions.jsonl"
    path.write_text(
        json.dumps(
            {
                "date": "1988-09-09",
                "page": 4,
                "peopleDataOrdinal": 47,
                "title": "失明以后",
                "decision": "accept",
                "content": "完整正文",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    decisions = MODULE.load_decisions(path)

    assert set(decisions) == {("1988-09-09", 4, 47)}
    assert "newspapers/rmrb/data/articles/1988.jsonl.gz" in MODULE.hf_patterns(decisions)
    assert "newspapers/rmrb/items/1988/09/1988-09-09.json.gz" in MODULE.hf_patterns(decisions)
    assert MODULE.delivery_paths(decisions)[1].endswith("1988-09-09/manifest.jox")


def test_load_decisions_rejects_empty_accept(tmp_path: Path):
    path = tmp_path / "decisions.jsonl"
    path.write_text(
        json.dumps(
            {
                "date": "1988-09-09",
                "page": 4,
                "peopleDataOrdinal": 47,
                "decision": "accept",
                "content": "",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="non-empty accept"):
        MODULE.load_decisions(path)


def test_staged_files_uses_repository_relative_posix_paths(tmp_path: Path):
    nested = tmp_path / "newspapers" / "rmrb" / "dataset.json"
    nested.parent.mkdir(parents=True)
    nested.write_text("{}", encoding="utf-8")

    assert MODULE.staged_files(tmp_path) == {
        "newspapers/rmrb/dataset.json": nested,
    }


def test_staged_files_requires_directory(tmp_path: Path):
    with pytest.raises(RuntimeError, match="directory is missing"):
        MODULE.staged_files(tmp_path / "missing")


def test_hf_git_head_parses_main(monkeypatch):
    class Result:
        returncode = 0
        stdout = "a" * 40 + "\trefs/heads/main\n"
        stderr = ""

    monkeypatch.setattr(MODULE.subprocess, "run", lambda *args, **kwargs: Result())

    assert MODULE.hf_git_head("owner/repo") == "a" * 40
