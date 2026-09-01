from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from jojo_news_archive.migration.legacy_b2 import FILE_SET_FORMAT_VERSION
from jojo_news_archive.migration.replay import prepare_replay_layout


def _fixture(tmp_path: Path) -> tuple[Path, Path, bytes, str]:
    source_root = tmp_path / "source"
    local_path = "raw/records/aa/article.json"
    object_name = "raw/archive/v1/ap/2020-2020/wayback/raw/records/aa/article.json"
    content = b'{"capture":true}\n'
    source = source_root.joinpath(*local_path.split("/"))
    source.parent.mkdir(parents=True)
    source.write_bytes(content)
    manifest = tmp_path / "immutable.json"
    manifest.write_text(json.dumps({
        "formatVersion": FILE_SET_FORMAT_VERSION,
        "files": [{
            "localPath": local_path,
            "objectName": object_name,
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "required": True,
        }],
    }), encoding="utf-8")
    return source_root, manifest, content, object_name


def test_materializes_final_hf_layout_and_replay_file_set(tmp_path: Path):
    source_root, manifest, content, object_name = _fixture(tmp_path)
    workspace = tmp_path / "workspace"
    replay_manifest = tmp_path / "replay.json"
    report = prepare_replay_layout(
        source_root=source_root,
        file_set_path=manifest,
        workspace=workspace,
        output_file_set=replay_manifest,
        materialize=True,
    )
    target = workspace.joinpath(*object_name.split("/"))
    assert target.read_bytes() == content
    assert report["linked"] + report["copied"] == 1
    replay = json.loads(replay_manifest.read_text(encoding="utf-8"))
    assert replay["files"][0]["localPath"] == object_name
    assert replay["files"][0]["objectName"] == object_name

    repeated = prepare_replay_layout(
        source_root=source_root,
        file_set_path=manifest,
        workspace=workspace,
        output_file_set=replay_manifest,
        materialize=True,
    )
    assert repeated["existing"] == 1


def test_rejects_tampered_source_or_existing_target(tmp_path: Path):
    source_root, manifest, _content, object_name = _fixture(tmp_path)
    source_root.joinpath("raw/records/aa/article.json").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="does not match"):
        prepare_replay_layout(
            source_root=source_root,
            file_set_path=manifest,
            workspace=tmp_path / "workspace",
            output_file_set=tmp_path / "replay.json",
            materialize=True,
        )

    source_root, manifest, _content, object_name = _fixture(tmp_path / "second")
    workspace = tmp_path / "second-workspace"
    target = workspace.joinpath(*object_name.split("/"))
    target.parent.mkdir(parents=True)
    target.write_bytes(b"wrong")
    with pytest.raises(ValueError, match="does not match"):
        prepare_replay_layout(
            source_root=source_root,
            file_set_path=manifest,
            workspace=workspace,
            output_file_set=tmp_path / "second-replay.json",
            materialize=True,
        )
