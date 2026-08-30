from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sqlite3
from urllib.error import URLError

import pytest

from tools.download_b2_validation_sample import (
    authorize,
    download_file,
    download_url,
    safe_local_path,
    selected_paths,
)


def test_authorize_retries_transient_tls_failure(monkeypatch) -> None:
    payload = BytesIO(
        json.dumps(
            {
                "authorizationToken": "token",
                "apiInfo": {
                    "storageApi": {"downloadUrl": "https://download.example"}
                },
            }
        ).encode()
    )
    responses = iter([URLError("temporary TLS failure"), payload])

    def fake_urlopen(*_args, **_kwargs):
        result = next(responses)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(
        "tools.download_b2_validation_sample.urlopen", fake_urlopen
    )
    monkeypatch.setattr(
        "tools.download_b2_validation_sample.time.sleep", lambda _seconds: None
    )

    assert authorize("key-id", "application-key") == (
        "token",
        "https://download.example",
    )


def test_download_url_encodes_each_object_name_segment() -> None:
    assert download_url(
        "https://download.example",
        "private bucket",
        "news archive/object+a.gz",
    ) == (
        "https://download.example/file/private%20bucket/"
        "news%20archive/object%2Ba.gz"
    )


def test_download_file_can_reuse_completed_checkpoint(
    tmp_path: Path, monkeypatch
) -> None:
    checkpoint = tmp_path / "capture.sqlite3.gz"
    checkpoint.write_bytes(b"completed checkpoint")

    def fail_urlopen(*_args, **_kwargs):
        raise AssertionError("reused checkpoint must not be downloaded again")

    monkeypatch.setattr(
        "tools.download_b2_validation_sample.urlopen", fail_urlopen
    )

    assert download_file(
        token="token",
        download_base="https://download.example",
        bucket="private-bucket",
        remote_names=["state/capture.sqlite3.gz"],
        target=checkpoint,
        reuse_existing=True,
    ) == "existing"


def test_selected_paths_supports_checkpoint_before_qa_revisions(
    tmp_path: Path,
) -> None:
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          sample_year INTEGER NOT NULL,
          canonical_url TEXT NOT NULL,
          sample_priority TEXT NOT NULL
        );
        CREATE TABLE parser_validation_results (
          canonical_url TEXT PRIMARY KEY,
          publisher TEXT NOT NULL,
          sample_year INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_pass INTEGER NOT NULL
        );
        CREATE TABLE captures (
          canonical_url TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          raw_path TEXT,
          raw_sha256 TEXT,
          dependent_resources_json TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2018, 1, 'nyt-parser/legacy');
        INSERT INTO parser_validation_samples
          VALUES (2018, 'https://example.com/article', '001');
        INSERT INTO parser_validation_results
          VALUES (
            'https://example.com/article', 'nyt', 2018,
            'nyt-parser/legacy', 1
          );
        INSERT INTO captures VALUES (
          'https://example.com/article', 'complete',
          'objects/html/aa/article.html.gz', 'abc123',
          '[{"blob":{"path":"objects/assets/bb/image.jpg"}}]'
        );
        """
    )
    connection.commit()
    connection.close()

    raw_hashes, paths = selected_paths(
        state, publisher="nyt", year=2018, target=1
    )

    assert raw_hashes == [
        ("objects/html/aa/article.html.gz", "abc123")
    ]
    assert paths == {
        "objects/html/aa/article.html.gz",
        "objects/assets/bb/image.jpg",
    }


def test_selected_paths_can_download_partial_sample_for_early_audit(
    tmp_path: Path,
) -> None:
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          sample_year INTEGER NOT NULL,
          canonical_url TEXT NOT NULL,
          sample_priority TEXT NOT NULL
        );
        CREATE TABLE parser_validation_results (
          canonical_url TEXT PRIMARY KEY,
          publisher TEXT NOT NULL,
          sample_year INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL,
          qa_pass INTEGER NOT NULL
        );
        CREATE TABLE captures (
          canonical_url TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          raw_path TEXT,
          raw_sha256 TEXT,
          dependent_resources_json TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2017, 800, 'ft-parser/current', 0);
        INSERT INTO parser_validation_samples
          VALUES (2017, 'https://example.com/article', '001');
        INSERT INTO parser_validation_results
          VALUES (
            'https://example.com/article', 'ft', 2017,
            'ft-parser/current', 0, 1
          );
        INSERT INTO captures VALUES (
          'https://example.com/article', 'complete',
          'objects/html/aa/article.html.gz', 'abc123', '[]'
        );
        """
    )
    connection.commit()
    connection.close()

    with pytest.raises(ValueError, match="selected 1 completed rows, expected 800"):
        selected_paths(state, publisher="ft", year=2017, target=800)

    raw_hashes, paths = selected_paths(
        state,
        publisher="ft",
        year=2017,
        target=800,
        allow_partial=True,
    )

    assert raw_hashes == [("objects/html/aa/article.html.gz", "abc123")]
    assert paths == {"objects/html/aa/article.html.gz"}


def test_safe_local_path_rejects_parent_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unsafe archive path"):
        safe_local_path(tmp_path, "objects/../secret")

    with pytest.raises(ValueError, match="unsafe archive path"):
        safe_local_path(tmp_path, "/absolute/object.gz")


def test_safe_local_path_maps_posix_object_path(tmp_path: Path) -> None:
    assert safe_local_path(tmp_path, "objects/ab/file.gz") == (
        tmp_path / "objects" / "ab" / "file.gz"
    )
