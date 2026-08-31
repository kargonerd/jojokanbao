from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sqlite3

import httpx
import pytest

from jojo_news_archive.sources.registry import (
    archive_source_spec,
    archive_source_variant,
    normalize_article_url,
)
from jojo_news_archive.discovery.common_crawl_prefix import (
    COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS,
    CommonCrawlPrefixClient,
    PrefixCollection,
    PrefixIndexPage,
    export_prefix_manifest,
    initialize_prefix_schema,
    next_prefix_query,
    prefix_patterns,
    prefix_summary,
    process_prefix_date_hydration,
    record_prefix_page,
    record_prefix_page_count,
    reconcile_prefix_year_targets,
)
from jojo_news_archive.sources.nikkei.discovery import _nikkei_article_year_hint
from jojo_news_archive.sources.npr.discovery import _npr_story_id
from jojo_news_archive.models import CaptureProvider
from jojo_news_archive.capture.raw import manifest_item_from_row
from tools.build_common_crawl_prefix_manifest import (
    initialize_with_collection_refresh,
)


INDEX_URL = "https://index.commoncrawl.org/CC-MAIN-2014-10-index"
WARC_FILENAME = (
    "crawl-data/CC-MAIN-2014-10/segments/example/warc/"
    "CC-MAIN-201403-example.warc.gz"
)
ARTICLE_URL = (
    "http://www.npr.org/2010/03/06/124385712/"
    "actor-tony-shalhoub-plays-not-my-job?ft=1"
)
CANONICAL_URL = (
    "https://www.npr.org/2010/03/06/124385712/"
    "actor-tony-shalhoub-plays-not-my-job"
)
NIKKEI_URL = (
    "https://www.nikkei.com/article/DGXNASFE22044_X10C13A5TY5000"
)
FT_URL = "https://www.ft.com/content/12345678-1234-1234-1234-123456789012"
WSJ_LEGACY_URL = "https://www.wsj.com/article/SB100014240527487000000000.html"


def _collection(identifier: str = "CC-MAIN-2014-10") -> PrefixCollection:
    return PrefixCollection(
        identifier=identifier,
        index_url=INDEX_URL.replace("CC-MAIN-2014-10", identifier),
        from_at=datetime(2014, 3, 7, tzinfo=timezone.utc),
        to_at=datetime(2014, 3, 17, tzinfo=timezone.utc),
    )


def _index_row(timestamp: str, *, offset: int) -> dict[str, object]:
    return {
        "url": ARTICLE_URL,
        "timestamp": timestamp,
        "status": "200",
        "mime": "text/html",
        "digest": f"digest-{offset}",
        "length": "9000",
        "offset": str(offset),
        "filename": WARC_FILENAME,
    }


def _nikkei_index_row(timestamp: str, *, length: int) -> dict[str, object]:
    return {
        "url": NIKKEI_URL + "/?n_cid=test",
        "timestamp": timestamp,
        "status": "200",
        "mime": "text/html",
        "digest": "nikkei-digest",
        "length": str(length),
        "offset": "500",
        "filename": WARC_FILENAME,
    }


def _ft_index_row(timestamp: str, *, length: int) -> dict[str, object]:
    return {
        "url": FT_URL,
        "timestamp": timestamp,
        "status": "200",
        "mime": "text/html",
        "digest": "ft-digest",
        "length": str(length),
        "offset": "500",
        "filename": WARC_FILENAME,
    }


def _wsj_legacy_index_row(timestamp: str, *, length: int) -> dict[str, object]:
    return {
        "url": WSJ_LEGACY_URL.replace("www.wsj.com", "online.wsj.com"),
        "timestamp": timestamp,
        "status": "200",
        "mime": "text/html",
        "digest": "wsj-legacy-digest",
        "length": str(length),
        "offset": "500",
        "filename": WARC_FILENAME,
    }


def _warc_record(target_url: str, content: bytes) -> bytes:
    response = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/html; charset=utf-8\r\n"
        + f"Content-Length: {len(content)}\r\n".encode()
        + b"\r\n"
        + content
    )
    record = (
        b"WARC/1.0\r\n"
        b"WARC-Type: response\r\n"
        + f"WARC-Target-URI: {target_url}\r\n".encode()
        + f"Content-Length: {len(response)}\r\n".encode()
        + b"\r\n"
        + response
        + b"\r\n\r\n"
    )
    return gzip.compress(record, mtime=0)


class _RangeClient:
    def __init__(self, compressed: bytes) -> None:
        self.compressed = compressed

    def fetch_range(
        self,
        url: str,
        *,
        offset: int,
        length: int,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]:
        assert offset == 500
        assert length == len(self.compressed)
        assert maximum_bytes == 25_000_000
        return 206, {"content-type": "application/octet-stream"}, self.compressed, url


class _MappedRangeClient:
    def __init__(self, records: dict[int, bytes]) -> None:
        self.records = records

    def fetch_range(
        self,
        url: str,
        *,
        offset: int,
        length: int,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]:
        compressed = self.records[offset]
        assert length == len(compressed)
        assert maximum_bytes == 25_000_000
        return 206, {"content-type": "application/octet-stream"}, compressed, url


def test_npr_prefix_patterns_include_www_and_bare_hosts():
    assert prefix_patterns(
        archive_source_spec("npr"),
        from_year=2010,
        to_year=2010,
    ) == (
        "www.npr.org/2010/",
        "npr.org/2010/",
        "www.npr.org/templates/story/story.php",
        "npr.org/templates/story/story.php",
    )


def test_nikkei_asia_probe_variant_is_isolated_from_canonical_source():
    canonical = archive_source_spec("nikkei")
    probe = archive_source_variant("nikkei", "nikkei-asia-probe")

    assert canonical.canonical_host == "www.nikkei.com"
    assert probe.publisher == "nikkei"
    assert probe.canonical_host == "asia.nikkei.com"
    assert prefix_patterns(probe, from_year=2016, to_year=2016) == (
        "asia.nikkei.com/",
    )
    assert normalize_article_url(
        probe,
        "http://asia.nikkei.com/Business/Companies/example-story?ref=home",
    ) == "https://asia.nikkei.com/Business/Companies/example-story"
    assert normalize_article_url(
        probe,
        "https://asia.nikkei.com/Business",
    ) is None
    assert normalize_article_url(
        canonical,
        "https://asia.nikkei.com/Business/Companies/example-story",
    ) is None


def test_axios_source_accepts_local_newsroom_articles():
    spec = archive_source_spec("axios")

    assert normalize_article_url(
        spec,
        "https://www.axios.com/local/charlotte/2017/01/31/example-story-79510",
    ) == (
        "https://www.axios.com/local/charlotte/2017/01/31/"
        "example-story-79510"
    )
    assert "www.axios.com/local/" in prefix_patterns(
        spec,
        from_year=2017,
        to_year=2017,
    )


def test_archive_source_variant_rejects_cross_publisher_probe():
    with pytest.raises(ValueError, match="unsupported archive source variant"):
        archive_source_variant("ft", "nikkei-asia-probe")


def test_wsj_legacy_probe_variant_is_isolated_and_hydratable():
    canonical = archive_source_spec("wsj")
    probe = archive_source_variant("wsj", "wsj-legacy-probe")

    assert probe.publisher == "wsj"
    assert prefix_patterns(probe, from_year=2010, to_year=2013) == (
        "online.wsj.com/article/",
        "online.wsj.com/news/articles/",
        "www.wsj.com/news/articles/",
    )
    assert normalize_article_url(
        probe,
        "http://online.wsj.com/article/SB100014240527487000000000.html",
    ) == "https://www.wsj.com/article/SB100014240527487000000000.html"
    assert "wsj" in COMMON_CRAWL_DATE_HYDRATION_PUBLISHERS
    assert canonical.wayback_patterns != probe.wayback_patterns


def test_npr_story_id_matches_dated_and_legacy_urls():
    assert _npr_story_id(
        "https://www.npr.org/2010/12/02/131356105/example"
    ) == 131356105
    assert _npr_story_id(
        "https://www.npr.org/templates/story/story.php?storyId=131356105"
    ) == 131356105


def test_aljazeera_prefix_patterns_include_article_sections():
    assert prefix_patterns(
        archive_source_spec("aljazeera"),
        from_year=2020,
        to_year=2020,
    ) == (
        "www.aljazeera.com/news/2020/",
        "www.aljazeera.com/economy/2020/",
        "www.aljazeera.com/features/2020/",
        "www.aljazeera.com/opinions/2020/",
        "www.aljazeera.com/sports/2020/",
        "www.aljazeera.com/gallery/2020/",
        "www.aljazeera.com/2020/",
        "aljazeera.com/2020/",
    )


def test_scmp_prefix_patterns_include_modern_article_sections():
    assert prefix_patterns(
        archive_source_spec("scmp"),
        from_year=2017,
        to_year=2017,
    ) == (
        "www.scmp.com/article/",
        "www.scmp.com/news/",
        "www.scmp.com/business/",
        "www.scmp.com/sport/",
        "www.scmp.com/lifestyle/",
        "www.scmp.com/tech/",
        "www.scmp.com/comment/",
        "www.scmp.com/asia/",
        "www.scmp.com/infographics/",
    )


def test_wsj_prefix_patterns_include_legacy_news_article_route():
    patterns = prefix_patterns(
        archive_source_spec("wsj"),
        from_year=2010,
        to_year=2013,
    )
    assert "online.wsj.com/news/articles/" in patterns
    assert "www.wsj.com/news/articles/" in patterns


def test_ft_common_crawl_date_hydration_uses_article_metadata():
    body = "Financial Times verification article body. " * 40
    html = f"""
        <html><head>
          <meta property="article:published_time"
            content="2014-05-26T08:00:00+00:00">
        </head><body><article><h1>FT verification article</h1>
          <p>{body}</p></article></body></html>
    """.encode()
    compressed = _warc_record(FT_URL, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("ft")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collections=(collection,),
    )
    pattern = "www.ft.com/content/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    result = record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(_ft_index_row("20140526080000", length=len(compressed)),)
        ),
    )

    assert result["datedAccepted"] == 0
    assert result["undatedAccepted"] == 1
    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_RangeClient(compressed),
        maximum=1,
    )

    assert hydration["found"] == 1
    assert prefix_summary(connection)["articlesByYear"] == {"2014": 1}


def test_wsj_legacy_probe_hydrates_undated_sb_article_from_warc():
    body = "WSJ legacy verification article body. " * 40
    html = f"""
        <html><head>
          <meta property="article:published_time"
            content="2011-06-14T08:00:00-04:00">
          <meta property="og:title" content="Legacy WSJ report">
        </head><body><article><p>{body}</p></article></body></html>
    """.encode()
    compressed = _warc_record(WSJ_LEGACY_URL, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_variant("wsj", "wsj-legacy-probe")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2013,
        collections=(collection,),
    )
    pattern = "online.wsj.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    result = record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(
                _wsj_legacy_index_row(
                    "20140601000000",
                    length=len(compressed),
                ),
            )
        ),
    )

    assert result["datedAccepted"] == 0
    assert result["undatedAccepted"] == 1
    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_RangeClient(compressed),
        maximum=1,
    )

    assert hydration["found"] == 1
    assert prefix_summary(connection)["articlesByYear"] == {"2011": 1}


def test_prefix_schema_widening_reuses_out_of_window_hydration():
    body = "WSJ legacy verification article body. " * 40
    html = f"""
        <html><head>
          <meta property="article:published_time"
            content="2011-06-14T08:00:00-04:00">
          <meta property="og:title" content="Legacy WSJ report">
        </head><body><article><p>{body}</p></article></body></html>
    """.encode()
    compressed = _warc_record(WSJ_LEGACY_URL, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_variant("wsj", "wsj-legacy-probe")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2012,
        to_year=2013,
        collections=(collection,),
    )
    pattern = "online.wsj.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(
                _wsj_legacy_index_row(
                    "20140601000000",
                    length=len(compressed),
                ),
            )
        ),
    )
    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_RangeClient(compressed),
        maximum=1,
    )
    assert hydration["outOfWindow"] == 1
    assert prefix_summary(connection)["articlesByYear"] == {}

    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2013,
        collections=(collection,),
    )

    assert prefix_summary(connection)["articlesByYear"] == {"2011": 1}
    assert connection.execute(
        "SELECT status FROM prefix_date_hydration"
    ).fetchone()[0] == "complete"


def test_reuters_prefix_patterns_include_modern_section_roots():
    patterns = prefix_patterns(
        archive_source_spec("reuters"),
        from_year=2016,
        to_year=2020,
    )
    assert patterns[:3] == (
        "www.reuters.com/article/a",
        "www.reuters.com/article/b",
        "www.reuters.com/article/c",
    )
    assert patterns[-11:] == (
        "www.reuters.com/world/",
        "www.reuters.com/business/",
        "www.reuters.com/markets/",
        "www.reuters.com/technology/",
        "www.reuters.com/legal/",
        "www.reuters.com/sports/",
        "www.reuters.com/lifestyle/",
        "www.reuters.com/science/",
        "www.reuters.com/fact-check/",
        "www.reuters.com/breakingviews/",
        "www.reuters.com/investigates/",
    )


def test_prefix_schema_adds_new_collections_without_resetting_progress():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    first = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(first,),
    )
    collection_id, _, pattern, _, _ = next_prefix_query(connection)
    record_prefix_page_count(
        connection,
        collection_id=collection_id,
        pattern=pattern,
        total_pages=0,
    )

    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(first, _collection("CC-MAIN-2015-11")),
    )

    assert connection.execute(
        "SELECT COUNT(*) FROM prefix_queries"
    ).fetchone()[0] == 8
    assert connection.execute(
        """
        SELECT status FROM prefix_queries
        WHERE collection_id=? AND pattern=?
        """,
        (collection_id, pattern),
    ).fetchone()[0] == "complete"


def test_prefix_schema_reopens_no_date_rows_after_parser_upgrade():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(_collection(),),
    )
    connection.execute(
        "INSERT INTO prefix_date_hydration("
        "canonical_url,publisher,status,attempts,updated_at"
        ") VALUES (?,?,?,?,?)",
        (
            "https://www.npr.org/templates/story/story.php?storyId=1",
            "npr",
            "no-date",
            1,
            "old",
        ),
    )
    connection.execute(
        "UPDATE prefix_metadata SET value='npr-parser/old' "
        "WHERE key='hydration_parser_version'"
    )

    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(_collection(),),
    )

    assert connection.execute(
        "SELECT status, attempts FROM prefix_date_hydration"
    ).fetchone() == ("pending", 0)


def test_prefix_schema_allows_additive_publisher_patterns():
    connection = sqlite3.connect(":memory:")
    current = archive_source_spec("npr")
    original = replace(
        current,
        wayback_patterns=current.wayback_patterns[:1],
    )
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=original,
        from_year=2010,
        to_year=2010,
        collections=(collection,),
    )
    old_count = connection.execute(
        "SELECT COUNT(*) FROM prefix_queries"
    ).fetchone()[0]

    initialize_prefix_schema(
        connection,
        spec=current,
        from_year=2010,
        to_year=2010,
        collections=(collection,),
    )

    new_count = connection.execute(
        "SELECT COUNT(*) FROM prefix_queries"
    ).fetchone()[0]
    assert new_count > old_count
    assert connection.execute(
        "SELECT COUNT(*) FROM prefix_queries WHERE status='pending'"
    ).fetchone()[0] == new_count


def test_prefix_queries_prioritize_recent_collections():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(
            _collection("CC-MAIN-2014-10"),
            _collection("CC-MAIN-2026-30"),
        ),
    )

    collection_id, _, _, _, _ = next_prefix_query(connection)

    assert collection_id == "CC-MAIN-2026-30"


def test_reuters_prefix_queries_prioritize_modern_section_roots():
    connection = sqlite3.connect(":memory:")
    initialize_prefix_schema(
        connection,
        spec=archive_source_spec("reuters"),
        from_year=2016,
        to_year=2020,
        collections=(_collection("CC-MAIN-2026-30"),),
    )

    _, _, pattern, _, _ = next_prefix_query(connection)

    assert pattern in {
        "www.reuters.com/world/",
        "www.reuters.com/business/",
        "www.reuters.com/markets/",
        "www.reuters.com/technology/",
        "www.reuters.com/legal/",
        "www.reuters.com/sports/",
        "www.reuters.com/lifestyle/",
        "www.reuters.com/science/",
        "www.reuters.com/fact-check/",
        "www.reuters.com/breakingviews/",
        "www.reuters.com/investigates/",
    }


def test_npr_prefix_queries_probe_legacy_story_ids_first():
    connection = sqlite3.connect(":memory:")
    initialize_prefix_schema(
        connection,
        spec=archive_source_spec("npr"),
        from_year=2010,
        to_year=2010,
        collections=(_collection("CC-MAIN-2026-30"),),
    )

    _, _, pattern, _, _ = next_prefix_query(connection)

    assert pattern.endswith("/templates/story/story.php")


def test_npr_legacy_story_ids_prefer_known_usable_2018_indexes():
    connection = sqlite3.connect(":memory:")
    initialize_prefix_schema(
        connection,
        spec=archive_source_spec("npr"),
        from_year=2010,
        to_year=2010,
        collections=(
            _collection("CC-MAIN-2014-10"),
            _collection("CC-MAIN-2018-05"),
            _collection("CC-MAIN-2026-30"),
        ),
    )

    collection_id, _, pattern, _, _ = next_prefix_query(connection)

    assert collection_id == "CC-MAIN-2018-05"
    assert pattern.endswith("/templates/story/story.php")


def test_prefix_queries_can_prioritize_oldest_collections():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2015,
        collections=(
            _collection("CC-MAIN-2013-48"),
            _collection("CC-MAIN-2016-50"),
        ),
    )

    collection_id, _, _, _, _ = next_prefix_query(
        connection,
        collection_order="oldest",
    )

    assert collection_id == "CC-MAIN-2013-48"


def test_prefix_year_target_skips_and_can_reopen_pending_queries():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    first = _collection("CC-MAIN-2025-30")
    second = _collection("CC-MAIN-2026-30")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(first, second),
    )
    pattern = "www.npr.org/2010/"
    record_prefix_page_count(
        connection,
        collection_id=second.identifier,
        pattern=pattern,
        total_pages=1,
    )
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=second.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(rows=(_index_row("20260701000000", offset=1),)),
    )

    completed = reconcile_prefix_year_targets(
        connection,
        target_articles_per_year=1,
    )

    assert completed == 7
    assert prefix_summary(connection)["queryStatus"] == {
        "complete": 1,
        "target-complete": 7,
    }
    assert next_prefix_query(connection) is None

    reconcile_prefix_year_targets(
        connection,
        target_articles_per_year=2,
    )

    assert next_prefix_query(connection) is not None
    assert prefix_summary(connection)["queriesRemaining"] == 7


def test_collection_refresh_timeout_reuses_checkpoint_queries():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(_collection(),),
    )

    class TimeoutClient:
        def collections(self):
            raise RuntimeError("temporary collection endpoint timeout")

    result = initialize_with_collection_refresh(
        connection,
        client=TimeoutClient(),
        spec=spec,
        from_year=2010,
        to_year=2010,
        collection_from_year=2014,
    )

    assert result == {
        "source": "checkpoint",
        "queryCount": 4,
        "refreshError": "RuntimeError",
    }
    assert connection.execute(
        "SELECT COUNT(*) FROM prefix_queries"
    ).fetchone()[0] == 4


def test_collection_refresh_timeout_rejects_empty_checkpoint():
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")

    class TimeoutClient:
        def collections(self):
            raise RuntimeError("temporary collection endpoint timeout")

    try:
        initialize_with_collection_refresh(
            connection,
            client=TimeoutClient(),
            spec=spec,
            from_year=2010,
            to_year=2010,
            collection_from_year=2014,
        )
    except RuntimeError as exc:
        assert "temporary collection endpoint timeout" in str(exc)
    else:
        raise AssertionError("an empty checkpoint must not look complete")


def test_records_caps_and_exports_common_crawl_candidates(tmp_path: Path):
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(collection,),
    )
    pattern = "www.npr.org/2010/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    result = record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=tuple(
                _index_row(timestamp, offset=index)
                for index, timestamp in enumerate(
                    (
                        "20140307033634",
                        "20140308033634",
                        "20140309033634",
                        "20140310033634",
                    ),
                    start=1,
                )
            )
            + (
                {
                    **_index_row("20140311033634", offset=99),
                    "filename": "crawl-002/legacy.arc.gz",
                },
            ),
        ),
    )

    assert result == {"seen": 5, "accepted": 4, "complete": True}
    assert connection.execute(
        "SELECT COUNT(*) FROM prefix_candidates"
    ).fetchone()[0] == 3
    assert prefix_summary(connection)["shouldContinue"] is True

    # The bare-host query remains pending; finish it without index rows.
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern="npr.org/2010/",
        total_pages=0,
    )
    for legacy_pattern in (
        "www.npr.org/templates/story/story.php",
        "npr.org/templates/story/story.php",
    ):
        record_prefix_page_count(
            connection,
            collection_id=collection.identifier,
            pattern=legacy_pattern,
            total_pages=0,
        )
    assert prefix_summary(connection)["shouldContinue"] is False

    destination = tmp_path / "manifest.jsonl.gz"
    summary = export_prefix_manifest(
        connection,
        spec=spec,
        destination=destination,
    )
    assert summary["articles"] == 1
    assert summary["candidates"] == 3
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    item = manifest_item_from_row(row, publisher="npr")
    assert item.canonical_url == CANONICAL_URL
    assert len(item.candidates) == 3
    assert all(
        candidate.provider == CaptureProvider.COMMON_CRAWL
        for candidate in item.candidates
    )
    assert item.candidates[0].warc_length == 9000


def test_hydrates_nikkei_publication_date_from_common_crawl_warc(
    tmp_path: Path,
):
    body = "市場と企業の動きを詳しく分析する記事本文です。" * 40
    html = f"""
        <html><head>
          <script type="application/ld+json">
            {{"@type":"NewsArticle","headline":"日経テスト記事",
              "datePublished":"2013-05-26T08:00:00+09:00"}}
          </script>
        </head><body><article><h1>日経テスト記事</h1><p>{body}</p></article></body></html>
    """.encode()
    compressed = _warc_record(NIKKEI_URL, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2012,
        to_year=2014,
        collections=(collection,),
    )
    pattern = "www.nikkei.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    result = record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(
                _nikkei_index_row(
                    "20140830021036",
                    length=len(compressed),
                ),
            )
        ),
    )

    assert result == {
        "seen": 1,
        "accepted": 1,
        "datedAccepted": 0,
        "undatedAccepted": 1,
        "complete": True,
    }
    before = prefix_summary(connection)
    assert before["articlesByYear"] == {}
    assert before["dateHydration"]["remaining"] == 1
    assert before["shouldContinue"] is True

    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_RangeClient(compressed),
        maximum=1,
    )

    assert hydration == {
        "attempted": 1,
        "found": 1,
        "outOfWindow": 0,
        "noDate": 0,
        "failed": 0,
        "remaining": 0,
        "errors": [],
    }
    after = prefix_summary(connection)
    assert after["articlesByYear"] == {"2013": 1}
    assert after["dateHydration"]["complete"] == 1
    assert after["shouldContinue"] is False
    destination = tmp_path / "nikkei.jsonl.gz"
    export_prefix_manifest(
        connection,
        spec=spec,
        destination=destination,
    )
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        exported = json.loads(handle.readline())
    assert exported["canonicalUrl"] == NIKKEI_URL
    assert exported["publishedAt"] == "2013-05-26T08:00:00+09:00"
    assert exported["candidates"][0]["provider"] == "commoncrawl"


def test_nikkei_year_hint_prioritizes_requested_legacy_year():
    target_url = (
        "https://www.nikkei.com/article/"
        "DGXNZO13224730R20C10A8ML0000"
    )
    newer_url = (
        "https://www.nikkei.com/article/"
        "DGXMZO42297010R10C19A3LB0000"
    )
    assert _nikkei_article_year_hint(target_url) == 2010
    assert _nikkei_article_year_hint(newer_url) == 2019
    assert (
        _nikkei_article_year_hint(
            "https://www.nikkei.com/article/DGXLASS0ISST2_U9A400C1000000"
        )
        == 2019
    )

    body = "日本経済の動きを詳しく伝える検証用の記事本文です。" * 40

    def archived_html(published_at: str) -> bytes:
        return f"""
            <html><head><script type="application/ld+json">
            {{"@type":"NewsArticle","headline":"日経検証記事",
              "datePublished":"{published_at}"}}
            </script></head><body><article><h1>日経検証記事</h1>
            <p>{body}</p></article></body></html>
        """.encode()

    target_record = _warc_record(
        target_url,
        archived_html("2010-08-23T08:00:00+09:00"),
    )
    newer_record = _warc_record(
        newer_url,
        archived_html("2019-03-11T08:00:00+09:00"),
    )
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(collection,),
    )
    pattern = "www.nikkei.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    target_row = {
        **_nikkei_index_row("20190525054234", length=len(target_record)),
        "url": target_url,
        "digest": "target-2010",
        "offset": "500",
    }
    newer_row = {
        **_nikkei_index_row("20170525054234", length=len(newer_record)),
        "url": newer_url,
        "digest": "newer-2019",
        "offset": "501",
    }
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(rows=(newer_row, target_row)),
    )

    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_MappedRangeClient(
            {500: target_record, 501: newer_record}
        ),
        maximum=1,
    )

    assert hydration["attempted"] == 1
    assert hydration["found"] == 1
    assert hydration["outOfWindow"] == 0
    assert prefix_summary(connection)["articlesByYear"] == {"2010": 1}


def test_hydration_stops_when_year_targets_are_already_satisfied():
    body = "日経の検証用記事本文です。" * 40
    html = f"""
        <html><head><meta property="article:published_time"
          content="2013-05-26T08:00:00+09:00"></head>
        <body><article><h1>検証用記事</h1><p>{body}</p></article></body></html>
    """.encode()
    first_compressed = _warc_record(NIKKEI_URL, html)
    second_url = (
        "https://www.nikkei.com/article/"
        "AAAAAAFE22044_X10C13A5TY5001"
    )
    second_compressed = _warc_record(second_url, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2013,
        to_year=2013,
        collections=(collection,),
    )
    pattern = "www.nikkei.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    second_row = _nikkei_index_row(
        "20200830021036",
        length=len(second_compressed),
    )
    second_row.update(
        url=second_url,
        digest="nikkei-digest-second",
        offset="501",
    )
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(
                _nikkei_index_row(
                    "20140830021036",
                    length=len(first_compressed),
                ),
                second_row,
            )
        ),
    )
    reconcile_prefix_year_targets(
        connection,
        target_articles_per_year=1,
    )

    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_MappedRangeClient(
            {500: first_compressed, 501: second_compressed}
        ),
        maximum=2,
        target_articles_per_year=1,
    )

    assert hydration["attempted"] == 1
    assert hydration["found"] == 1
    assert hydration["remaining"] == 1
    assert prefix_summary(connection)["targetComplete"] is True
    assert prefix_summary(connection)["shouldContinue"] is False


def test_hydrates_npr_legacy_story_id_into_requested_year(tmp_path: Path):
    legacy_url = (
        "https://www.npr.org/templates/story/story.php?storyId=131356105"
    )
    body = "This archived NPR report contains complete editorial prose. " * 30
    html = f"""
        <html><head><script type="application/ld+json">
        {{"@type":"NewsArticle","headline":"Legacy NPR report",
          "datePublished":"2010-12-02T08:00:00-05:00"}}
        </script></head><body><article><h1>Legacy NPR report</h1>
        <p>{body}</p></article></body></html>
    """.encode()
    compressed = _warc_record(legacy_url, html)
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("npr")
    collection = _collection()
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2010,
        to_year=2010,
        collections=(collection,),
    )
    pattern = "www.npr.org/templates/story/story.php"
    record_prefix_page_count(
        connection,
        collection_id=collection.identifier,
        pattern=pattern,
        total_pages=1,
    )
    row = {
        **_index_row("20180122150511", offset=1),
        "url": legacy_url,
        "length": str(len(compressed)),
        "offset": "500",
    }
    result = record_prefix_page(
        connection,
        spec=spec,
        collection_id=collection.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(rows=(row,)),
    )
    assert result["undatedAccepted"] == 1

    hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_RangeClient(compressed),
        maximum=1,
    )

    assert hydration["found"] == 1
    destination = tmp_path / "npr-legacy.jsonl.gz"
    export_prefix_manifest(connection, spec=spec, destination=destination)
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        exported = json.loads(handle.readline())
    assert exported["canonicalUrl"] == legacy_url
    assert exported["publishedAt"].startswith("2010-12-02T08:00:00")


def test_new_nikkei_candidate_reopens_a_prior_no_date_result():
    body = "企業の動きを伝える日経記事の本文です。" * 40
    no_date_html = (
        f"<html><body><article><h1>日経記事</h1><p>{body}</p>"
        "</article></body></html>"
    ).encode()
    dated_html = f"""
        <html><head><meta property="article:published_time"
          content="2013-05-26T08:00:00+09:00"></head>
        <body><article><h1>日経記事</h1><p>{body}</p></article></body></html>
    """.encode()
    first_record = _warc_record(NIKKEI_URL, no_date_html)
    second_record = _warc_record(NIKKEI_URL, dated_html)
    records = {500: first_record, 501: second_record}
    connection = sqlite3.connect(":memory:")
    spec = archive_source_spec("nikkei")
    first = _collection("CC-MAIN-2014-10")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2012,
        to_year=2014,
        collections=(first,),
    )
    pattern = "www.nikkei.com/article/"
    record_prefix_page_count(
        connection,
        collection_id=first.identifier,
        pattern=pattern,
        total_pages=1,
    )
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=first.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(
            rows=(
                _nikkei_index_row(
                    "20140307033634",
                    length=len(first_record),
                ),
            )
        ),
    )
    first_hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_MappedRangeClient(records),
        maximum=1,
    )
    assert first_hydration["noDate"] == 1
    assert prefix_summary(connection)["shouldContinue"] is False

    second = _collection("CC-MAIN-2014-11")
    initialize_prefix_schema(
        connection,
        spec=spec,
        from_year=2012,
        to_year=2014,
        collections=(first, second),
    )
    record_prefix_page_count(
        connection,
        collection_id=second.identifier,
        pattern=pattern,
        total_pages=1,
    )
    second_row = {
        **_nikkei_index_row(
            "20140407033634",
            length=len(second_record),
        ),
        "offset": "501",
        "digest": "nikkei-digest-2",
    }
    record_prefix_page(
        connection,
        spec=spec,
        collection_id=second.identifier,
        pattern=pattern,
        page_number=0,
        total_pages=1,
        page=PrefixIndexPage(rows=(second_row,)),
    )

    assert prefix_summary(connection)["dateHydration"]["remaining"] == 1
    second_hydration = process_prefix_date_hydration(
        connection,
        spec=spec,
        archive_client=_MappedRangeClient(records),
        maximum=1,
    )

    assert second_hydration["found"] == 1
    assert prefix_summary(connection)["articlesByYear"] == {"2013": 1}


def test_prefix_client_uses_page_count_then_ndjson_page():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/collinfo.json":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "CC-MAIN-2014-10",
                        "cdx-api": INDEX_URL,
                        "from": "2014-03-07T03:34:34",
                        "to": "2014-03-17T22:15:18",
                    }
                ],
                request=request,
            )
        if request.url.params.get("showNumPages") == "true":
            return httpx.Response(200, json={"pages": 1}, request=request)
        return httpx.Response(
            200,
            text=json.dumps(_index_row("20140307033634", offset=1)) + "\n",
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CommonCrawlPrefixClient(
        minimum_interval=0,
        attempts=1,
        page_size=1,
        client=http_client,
    )
    collections = client.collections()
    assert collections[0].identifier == "CC-MAIN-2014-10"
    assert client.page_count(
        index_url=INDEX_URL,
        pattern="www.npr.org/2010/",
    ) == 1
    page = client.page(
        index_url=INDEX_URL,
        pattern="www.npr.org/2010/",
        page=0,
    )
    assert len(page.rows) == 1
    query = requests[-1].url.params
    assert query.get("matchType") == "prefix"
    assert query.get("collapse") == "urlkey"
    assert query.get("pageSize") == "1"
    assert query.get_list("filter") == ["status:200", "mime:text/html"]
    http_client.close()


def test_prefix_client_retries_malformed_json_page_count():
    page_count_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal page_count_requests
        if request.url.params.get("showNumPages") == "true":
            page_count_requests += 1
            if page_count_requests == 1:
                return httpx.Response(
                    200,
                    text="<html>busy</html>",
                    request=request,
                )
            return httpx.Response(200, json={"pages": 1}, request=request)
        raise AssertionError("page request was not expected")

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CommonCrawlPrefixClient(
        minimum_interval=0,
        attempts=2,
        client=http_client,
    )

    assert (
        client.page_count(index_url=INDEX_URL, pattern="www.npr.org/2010/")
        == 1
    )
    assert page_count_requests == 2
    http_client.close()


def test_prefix_client_retries_malformed_ndjson_page():
    page_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal page_requests
        page_requests += 1
        if page_requests == 1:
            return httpx.Response(200, text='{"url":\n', request=request)
        return httpx.Response(
            200,
            text=json.dumps(_index_row("20140307033634", offset=1)) + "\n",
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CommonCrawlPrefixClient(
        minimum_interval=0,
        attempts=2,
        client=http_client,
    )

    page = client.page(
        index_url=INDEX_URL,
        pattern="www.npr.org/2010/",
        page=0,
    )
    assert len(page.rows) == 1
    assert page_requests == 2
    http_client.close()


def test_prefix_client_treats_filtered_no_capture_page_as_empty():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("showNumPages") == "true":
            return httpx.Response(
                200,
                json={"pages": 2, "pageSize": 1, "blocks": 2},
                request=request,
            )
        return httpx.Response(
            404,
            json={"message": "No Captures found for: example.com/path/"},
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CommonCrawlPrefixClient(
        minimum_interval=0,
        attempts=3,
        page_size=1,
        client=http_client,
    )

    assert client.page_count(
        index_url=INDEX_URL,
        pattern="example.com/path/",
    ) == 2
    assert client.page(
        index_url=INDEX_URL,
        pattern="example.com/path/",
        page=0,
    ).rows == ()
    http_client.close()


def test_prefix_client_treats_no_capture_count_as_zero_pages():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"message": "No Captures found for: example.com/path/"},
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CommonCrawlPrefixClient(
        minimum_interval=0,
        attempts=3,
        client=http_client,
    )

    assert client.page_count(
        index_url=INDEX_URL,
        pattern="example.com/path/",
    ) == 0
    http_client.close()
