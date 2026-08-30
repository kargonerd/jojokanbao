from __future__ import annotations

import json
from pathlib import Path
import sqlite3

from jojo_olds_api.raw_archive_capture import initialize_capture_schema
from tools import preindex_arquivo_pt_catalog as tool


def test_preindex_is_resumable_and_removes_bulk_catalog(
    tmp_path: Path,
    monkeypatch,
) -> None:
    state = tmp_path / "capture.sqlite3"
    canonical_url = "https://www.wsj.com/articles/example"
    connection = sqlite3.connect(state)
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="test",
    )
    connection.execute(
        """
        INSERT INTO captures(
            canonical_url, article_id, publisher, published_at, section,
            candidates_json, status, updated_at
        ) VALUES (?, 'wsj:example', 'wsj', '2017-01-01T00:00:00Z',
                  NULL, '[]', 'pending', 'now')
        """,
        (canonical_url,),
    )
    connection.commit()
    connection.close()

    def download(destination: Path, **_: object) -> int:
        payload = json.dumps(
            {
                "url": canonical_url,
                "timestamp": "20170102000000",
                "mime": "text/html",
                "status": "200",
                "digest": "MATCH",
            }
        ).encode()
        destination.write_bytes(payload + b"\n")
        return len(payload) + 1

    monkeypatch.setattr(tool, "_download_catalog", download)
    first = tool.preindex(
        state,
        publisher="wsj",
        year=2017,
        limit=100_000,
        maximum_bytes=75_000_000,
        timeout=75,
        attempts=3,
    )

    assert first["targetsMatched"] == 1
    assert first["skipped"] is False
    assert not tuple(tmp_path.glob("arquivo-pt-prefix-*.ndjson"))

    def unexpected_download(*_: object, **__: object) -> int:
        raise AssertionError("completed prefix must not be downloaded twice")

    monkeypatch.setattr(tool, "_download_catalog", unexpected_download)
    second = tool.preindex(
        state,
        publisher="wsj",
        year=2017,
        limit=100_000,
        maximum_bytes=75_000_000,
        timeout=75,
        attempts=3,
    )

    assert second["skipped"] is True
    assert second["targetsMatched"] == 1
