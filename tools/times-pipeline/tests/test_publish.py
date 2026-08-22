from __future__ import annotations

import json
from pathlib import Path
import subprocess

import times_pipeline.publish as publisher


def touch(path: Path, body: bytes = b"jox") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


def test_publish_commits_mutable_pointers_after_article_objects(monkeypatch, tmp_path: Path) -> None:
    build = tmp_path / "build"
    times = build / "delivery" / "content" / "newspapers" / "times"
    touch(times / "items" / "2026" / "08" / "2026-08-22" / "articles" / "article.jox")
    touch(times / "items" / "2026" / "08" / "2026-08-22" / "manifest.jox")
    touch(times / "availability" / "2026.jox")
    touch(times / "index.jox")
    touch(times / "latest.jox")
    touch(build / "delivery" / "catalog.jox")
    touch(build / "raw" / "web-archives" / "times" / "2026" / "08" / "22" / "run-1" / "times-run-1.wacz")
    touch(build / "raw" / "web-archives" / "times" / "state.json.gz")
    touch(build / "canonical" / "newspapers" / "times" / "dataset.json")
    touch(build / "search" / "times" / "documents.jsonl.gz")
    (build / "report.json").write_text(json.dumps({"runId": "run-1"}), encoding="utf-8")

    commands: list[list[str]] = []
    monkeypatch.setattr(publisher.shutil, "which", lambda _name: "rclone")

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(publisher, "_run", fake_run)

    publisher.publish_release(
        build,
        delivery_remote="jojo-b2:jojo-newspaper",
        raw_remote="jojo-b2:jojo-news-raw",
    )

    rendered = [" ".join(command) for command in commands]
    article_copy = next(index for index, command in enumerate(rendered) if "/items" in command and "--exclude **/manifest.jox" in command)
    manifest_copy = next(index for index, command in enumerate(rendered) if "/items" in command and "--include **/manifest.jox" in command)
    assert article_copy < manifest_copy < len(commands) - 3
    raw_archive_copy = next(index for index, command in enumerate(rendered) if "--exclude web-archives/times/state.json.gz" in command)
    archive_state_copy = next(index for index, command in enumerate(rendered) if command.endswith("web-archives/times/state.json.gz --checksum"))
    assert raw_archive_copy < archive_state_copy < article_copy
    assert commands[-3][2].endswith("index.jox")
    assert commands[-2][2].endswith("latest.jox")
    assert commands[-1][2].endswith("catalog.jox")
    assert not any("search" in command for command in rendered)
