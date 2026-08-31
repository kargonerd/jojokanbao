from __future__ import annotations

import gzip
import json
from pathlib import Path
import sqlite3

from jojo_news_archive.sources.registry import (
    archive_source_spec,
    article_deduplication_key,
    article_url_publication_year,
)
from jojo_news_archive.sources.npr.discovery import (
    export_npr_archive_manifest,
    initialize_npr_archive_schema,
    next_npr_archive_query,
    npr_archive_summary,
    parse_npr_archive_page,
    record_npr_archive_page,
)


def _archive_page(*items: tuple[str, str, str]) -> bytes:
    articles = "".join(
        f"""
        <article class="item">
          <h2 class="title"><a href="{url}">{headline}</a></h2>
          <p class="teaser"><time datetime="{published}"></time></p>
        </article>
        """
        for url, published, headline in items
    )
    return f"<html><body><div class='archivelist'>{articles}</div></body></html>".encode()


def test_npr_section_urls_share_story_identity_and_year():
    spec = archive_source_spec("npr")
    sectioned = (
        "https://www.npr.org/sections/thetwo-way/2014/12/31/374304810/"
        "stampede-kills-35"
    )
    root = "https://www.npr.org/2014/12/31/374304810/stampede-kills-35"
    assert article_deduplication_key(spec, sectioned) == "npr:374304810"
    assert article_deduplication_key(spec, root) == "npr:374304810"
    assert article_url_publication_year(spec, sectioned) == 2014


def test_npr_archive_parser_and_checkpoint_export(tmp_path: Path):
    spec = archive_source_spec("npr")
    first_url = (
        "https://www.npr.org/sections/thetwo-way/2014/12/31/374304810/"
        "stampede-kills-35"
    )
    second_url = (
        "https://www.npr.org/2014/12/31/374253565/"
        "a-haven-in-a-land-of-unsafe-abortions"
    )
    older_url = "https://www.npr.org/2013/12/31/999999999/older"
    first_page = _archive_page(
        (first_url, "2014-12-31", "Stampede Kills 35"),
    )
    parsed = parse_npr_archive_page(first_page, spec=spec)
    assert parsed == [
        (
            first_url,
            "2014-12-31T00:00:00+00:00",
            "Stampede Kills 35",
        )
    ]

    connection = sqlite3.connect(":memory:")
    initialize_npr_archive_schema(connection, from_year=2014, to_year=2014)
    assert next_npr_archive_query(connection) == (
        2014,
        "2014-12-31",
        0,
    )
    result = record_npr_archive_page(
        connection,
        spec=spec,
        year=2014,
        cursor_date="2014-12-31",
        offset=0,
        content=first_page,
    )
    assert result == {
        "seen": 1,
        "accepted": 1,
        "complete": False,
        "cursorRotated": False,
    }
    assert next_npr_archive_query(connection) == (
        2014,
        "2014-12-31",
        15,
    )

    result = record_npr_archive_page(
        connection,
        spec=spec,
        year=2014,
        cursor_date="2014-12-31",
        offset=15,
        content=_archive_page(
            (second_url, "2014-12-31", "A Haven"),
            (older_url, "2013-12-31", "Older"),
        ),
    )
    assert result == {
        "seen": 2,
        "accepted": 1,
        "complete": True,
        "cursorRotated": False,
    }
    assert next_npr_archive_query(connection) is None
    assert npr_archive_summary(connection) == {
        "formatVersion": "jojo-npr-official-archive/2",
        "queriesByStatus": {"complete": 1},
        "pages": 2,
        "rowsSeen": 3,
        "rowsAccepted": 2,
        "articlesByYear": {"2014": 2},
        "articles": 2,
        "queryCursors": {
            "2014": {"date": "2014-12-31", "offset": 30}
        },
        "complete": True,
        "exhaustedQueries": 0,
        "shouldContinue": False,
    }

    destination = tmp_path / "manifest.jsonl.gz"
    exported = export_npr_archive_manifest(
        connection,
        destination=destination,
    )
    assert exported["articles"] == 2
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle]
    assert rows[0]["formatVersion"] == "jojo-capture-manifest/1"
    assert rows[0]["publisher"] == "npr"
    expected_headline = (
        "A Haven" if rows[0]["canonicalUrl"] == second_url
        else "Stampede Kills 35"
    )
    assert rows[0]["candidates"][0] == {
        "provider": "live-origin",
        "snapshotUrl": rows[0]["canonicalUrl"],
        "expectedHeadline": expected_headline,
    }
    assert [candidate["provider"] for candidate in rows[0]["candidates"]] == [
        "live-origin",
        "wayback",
        "wayback",
        "wayback",
    ]


def test_npr_archive_state_rejects_different_year_window():
    connection = sqlite3.connect(":memory:")
    initialize_npr_archive_schema(connection, from_year=2014, to_year=2014)
    try:
        initialize_npr_archive_schema(
            connection,
            from_year=2013,
            to_year=2014,
        )
    except ValueError as exc:
        assert "another year window" in str(exc)
    else:
        raise AssertionError("expected a fingerprint mismatch")


def test_npr_archive_rotates_date_cursor_before_deep_offset():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    initialize_npr_archive_schema(connection, from_year=2014, to_year=2014)
    result = record_npr_archive_page(
        connection,
        spec=spec,
        year=2014,
        cursor_date="2014-12-31",
        offset=1785,
        content=_archive_page(
            (
                "https://www.npr.org/sections/news/2014/09/30/123456789/"
                "cursor-boundary",
                "2014-09-30",
                "Cursor boundary",
            ),
        ),
    )

    assert result["cursorRotated"] is True
    assert next_npr_archive_query(connection) == (
        2014,
        "2014-09-30",
        0,
    )
    duplicate = record_npr_archive_page(
        connection,
        spec=spec,
        year=2014,
        cursor_date="2014-09-30",
        offset=0,
        content=_archive_page(
            (
                "https://www.npr.org/sections/news/2014/09/30/123456789/"
                "cursor-boundary",
                "2014-09-30",
                "Cursor boundary",
            ),
        ),
    )
    assert duplicate["accepted"] == 0


def test_npr_archive_migrates_stranded_v1_checkpoint():
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE npr_archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE npr_archive_queries (
            year INTEGER PRIMARY KEY,
            next_offset INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            pages INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_accepted INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE npr_archive_articles (
            canonical_url TEXT PRIMARY KEY,
            published_at TEXT NOT NULL,
            headline TEXT,
            source_archive_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO npr_archive_queries(
            year, next_offset, status, attempts, updated_at
        ) VALUES (2014, 1995, 'error', 3, '2026-08-30T00:00:00Z');
        INSERT INTO npr_archive_articles(
            canonical_url, published_at, headline,
            source_archive_url, updated_at
        ) VALUES (
            'https://www.npr.org/2014/10/01/123456789/story',
            '2014-10-01T00:00:00+00:00', 'Story',
            'https://www.npr.org/sections/news/archive?date=12-31-2014',
            '2026-08-30T00:00:00Z'
        );
        """
    )

    initialize_npr_archive_schema(connection, from_year=2014, to_year=2014)

    assert next_npr_archive_query(connection) == (
        2014,
        "2014-10-01",
        0,
    )
    row = connection.execute(
        "SELECT attempts, status, last_error FROM npr_archive_queries"
    ).fetchone()
    assert row == (0, "running", None)
