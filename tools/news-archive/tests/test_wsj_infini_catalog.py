from __future__ import annotations

import gzip
import json
from pathlib import Path
import sqlite3

from jojo_olds_api.archive_sources import archive_source_spec
from jojo_olds_api.wayback_manifest import (
    export_capture_manifest,
    initialize_discovery_schema,
    wsj_catalog_count_for_year,
)
from jojo_olds_api.wsj_infini_catalog import (
    initialize_wsj_infini_schema,
    process_wsj_infini_documents,
    process_wsj_infini_queries,
    wsj_infini_summary,
)


CANONICAL_URL = (
    "https://www.wsj.com/articles/"
    "investors-prepare-for-a-volatile-summer-a1b2c3d4"
)
HEADLINE = "Investors Prepare for a Volatile Summer in Global Markets"


class StubResponse:
    def __init__(self, payload: object):
        self.payload = payload

    def json(self):
        return self.payload

    def raise_for_status(self):
        return None


class StubInfiniClient:
    def post(self, url, json):
        if url.endswith("/find"):
            query = json["query"]
            segment = [100, 102] if query == "WSJ subscription" else [0, 0]
            return StubResponse(
                {
                    "count": segment[1] - segment[0],
                    "segment_by_shard": [segment],
                    "shard_years": ["2017"],
                }
            )
        assert url.endswith("/get_doc")
        is_wsj = json["rank"] == 100
        return StubResponse(
            {
                "doc_ix": 123 if is_wsj else 456,
                "doc_len": 2_500,
                "metadata": {
                    "url": (
                        CANONICAL_URL
                        if is_wsj
                        else "https://www.barrons.com/articles/not-wsj"
                    ),
                    "date": "2017-06-03",
                    "warc_source": (
                        "CC-NEWS-20170603123456-00001.warc.gz"
                    ),
                    "language": "eng",
                    "title": (
                        HEADLINE + " - The Wall Street Journal"
                    ),
                    "hostname": (
                        "www.wsj.com" if is_wsj else "www.barrons.com"
                    ),
                },
            }
        )


class StubShortInfiniClient(StubInfiniClient):
    def post(self, url, json):
        response = super().post(url, json)
        if url.endswith("/get_doc") and response.payload["doc_ix"] == 123:
            response.payload["doc_len"] = 500
        return response


def test_wsj_infini_catalog_adds_only_canonical_origin_urls(
    tmp_path: Path,
):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2017,
        to_year=2017,
        collapse="urlkey",
    )
    initialize_wsj_infini_schema(
        connection,
        from_year=2017,
        to_year=2017,
    )
    client = StubInfiniClient()

    queries = process_wsj_infini_queries(
        connection,
        http_client=client,
        maximum_queries=5,
    )
    documents = process_wsj_infini_documents(
        connection,
        spec=spec,
        http_client=client,
        maximum=2,
        workers=1,
        minimum_request_interval=0,
    )

    assert queries == {
        "processed": 5,
        "occurrences": 2,
        "errors": [],
    }
    assert documents == {
        "attempted": 2,
        "accepted": 1,
        "rejected": 1,
        "errors": [],
    }
    assert wsj_infini_summary(connection) == {
        "queriesByStatus": {"complete": 5},
        "occurrencesByStatus": {"accepted": 1, "rejected": 1},
        "articlesByYear": {"2017": 1},
        "shouldContinue": False,
    }
    assert wsj_catalog_count_for_year(connection, 2017) == 1

    destination = tmp_path / "manifest.jsonl.gz"
    result = export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2017,
        to_year=2017,
    )
    assert result["articles"] == 1
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert row["canonicalUrl"] == CANONICAL_URL
    assert row["publishedAt"] == "2017-06-03T00:00:00+00:00"
    assert row["candidates"]
    derived = row["candidates"][0]
    assert derived["provider"] == "infini-news"
    assert "config=year_2017" in derived["snapshotUrl"]
    assert "offset=123" in derived["snapshotUrl"]
    assert derived["sourceUrl"] == CANONICAL_URL
    assert derived["expectedHeadline"] == HEADLINE
    assert derived["warcFilename"].endswith("00001.warc.gz")
    assert all(
        candidate["provider"] == "wayback"
        for candidate in row["candidates"][1:]
    )


def test_wsj_infini_catalog_does_not_export_short_preview_candidate(
    tmp_path: Path,
):
    spec = archive_source_spec("wsj")
    connection = sqlite3.connect(":memory:")
    initialize_discovery_schema(
        connection,
        spec=spec,
        from_year=2017,
        to_year=2017,
        collapse="urlkey",
    )
    initialize_wsj_infini_schema(
        connection,
        from_year=2017,
        to_year=2017,
    )
    client = StubShortInfiniClient()
    process_wsj_infini_queries(
        connection,
        http_client=client,
        maximum_queries=5,
    )
    process_wsj_infini_documents(
        connection,
        spec=spec,
        http_client=client,
        maximum=2,
        workers=1,
        minimum_request_interval=0,
    )

    destination = tmp_path / "manifest.jsonl.gz"
    export_capture_manifest(
        connection,
        spec=spec,
        destination=destination,
        from_year=2017,
        to_year=2017,
    )
    with gzip.open(destination, "rt", encoding="utf-8") as handle:
        row = json.loads(handle.readline())
    assert all(
        candidate["provider"] == "wayback"
        for candidate in row["candidates"]
    )
