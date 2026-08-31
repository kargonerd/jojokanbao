from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from jojo_news_archive.migration.legacy_b2 import FILE_SET_FORMAT_VERSION
from jojo_news_archive.migration.records import write_record_list


def _file_set(path: Path, names: list[str]) -> Path:
    payload = {
        "formatVersion": FILE_SET_FORMAT_VERSION,
        "files": [
            {
                "localPath": f"local/{index}.json",
                "objectName": name,
                "size": 2,
                "sha256": hashlib.sha256(b"{}").hexdigest(),
                "required": True,
            }
            for index, name in enumerate(names)
        ],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_selects_only_records_with_a_reproducible_limit(tmp_path: Path):
    prefix = "raw/archive/v1/bloomberg/2020-2020/wayback"
    records = [f"{prefix}/raw/records/aa/{index}.json" for index in range(10)]
    manifest = _file_set(
        tmp_path / "immutable.json",
        [*records, f"{prefix}/raw/objects/html/aa/page.html.gz"],
    )
    first = write_record_list(
        file_set_path=manifest,
        output=tmp_path / "first.txt",
        limit=4,
        seed="fixed",
    )
    second = write_record_list(
        file_set_path=manifest,
        output=tmp_path / "second.txt",
        limit=4,
        seed="fixed",
    )
    assert first == second
    assert len(first) == 4
    assert (tmp_path / "first.txt").read_text(encoding="utf-8").splitlines() == list(first)


def test_rejects_empty_record_sets_and_invalid_limits(tmp_path: Path):
    prefix = "raw/archive/v1/bloomberg/2020-2020/wayback"
    manifest = _file_set(
        tmp_path / "immutable.json",
        [f"{prefix}/raw/objects/html/aa/page.html.gz"],
    )
    with pytest.raises(ValueError, match="no historical capture records"):
        write_record_list(file_set_path=manifest, output=tmp_path / "records.txt")
    with pytest.raises(ValueError, match="positive"):
        write_record_list(
            file_set_path=manifest,
            output=tmp_path / "records.txt",
            limit=0,
        )
