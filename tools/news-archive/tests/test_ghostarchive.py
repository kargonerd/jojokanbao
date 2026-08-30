from __future__ import annotations

from jojo_olds_api.ghostarchive import (
    discover_ghostarchive_candidates,
    fetch_ghostarchive_candidate,
    ghostarchive_search_url,
)
from jojo_olds_api.raw_archive_capture import (
    ManifestItem,
    _validate_ft_ghostarchive_response,
    capture_item,
)


CANONICAL_URL = (
    "https://www.ft.com/content/"
    "4389caaa-b87a-4d4c-82a1-db161d3265d3"
)
ARCHIVE_URL = "https://ghostarchive.org/archive/B5mFX"
WARC_URL = "https://ghostarchive.org/chimurai4/B5mFX.warc"
HEADLINE = "The great bond and equity conundrum"


class StubClient:
    def __init__(self, responses):
        self.responses = responses
        self.requests: list[tuple[str, int]] = []

    def fetch(self, url: str, *, maximum_bytes: int):
        self.requests.append((url, maximum_bytes))
        return self.responses[url]


def _article_html() -> bytes:
    paragraphs = "".join(
        (
            "<p>Full Financial Times reporting paragraph "
            f"{index} contains market analysis, evidence, quotations, "
            "context, and conclusions preserved in the archived article. "
            "It is substantive article copy rather than a paywall shell.</p>"
        )
        for index in range(1, 12)
    )
    return f"""
    <!doctype html><html><head>
      <script type="application/ld+json">
      {{
        "@type": "NewsArticle",
        "headline": "{HEADLINE}",
        "datePublished": "2026-06-12T04:00:22.942Z"
      }}
      </script>
    </head><body><article><h1>{HEADLINE}</h1>
      {paragraphs}
    </article></body></html>
    """.encode()


def _warc_response(html: bytes) -> bytes:
    http_payload = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/html; charset=utf-8\r\n"
        + f"Content-Length: {len(html)}\r\n\r\n".encode()
        + html
    )
    return (
        b"WARC/1.0\r\n"
        b"WARC-Type: response\r\n"
        + f"WARC-Target-URI: {CANONICAL_URL}?syn-test=1\r\n".encode()
        + b"Content-Type: application/http; msgtype=response\r\n"
        + f"Content-Length: {len(http_payload)}\r\n\r\n".encode()
        + http_payload
        + b"\r\n\r\n"
    )


def test_discovers_and_decodes_full_ghostarchive_warc(tmp_path):
    search_url = ghostarchive_search_url(CANONICAL_URL)
    search_html = f"""
    <html><body><table><tr><td>
      <a href="/archive/B5mFX">{CANONICAL_URL}?syn-test=1</a>
    </td></tr></table></body></html>
    """.encode()
    wrapper_html = f"""
    <html><body>
      <replay-web-page
        source="{WARC_URL}"
        url="{CANONICAL_URL}?syn-test=1">
      </replay-web-page>
    </body></html>
    """.encode()
    article_html = _article_html()
    client = StubClient(
        {
            search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                search_html,
                search_url,
            ),
            ARCHIVE_URL: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                wrapper_html,
                ARCHIVE_URL,
            ),
            WARC_URL: (
                200,
                {"content-type": "application/warc"},
                _warc_response(article_html),
                WARC_URL,
            ),
        }
    )

    candidates = discover_ghostarchive_candidates(
        CANONICAL_URL,
        archive_client=client,
    )

    assert [candidate.snapshot_url for candidate in candidates] == [
        ARCHIVE_URL
    ]
    status, headers, content, final_url, signals = (
        fetch_ghostarchive_candidate(
            candidates[0],
            canonical_url=CANONICAL_URL,
            archive_client=client,
            maximum_html_bytes=1_000_000,
        )
    )
    assert status == 200
    assert headers["content-type"].startswith("text/html")
    assert content == article_html
    assert final_url == CANONICAL_URL + "?syn-test=1"
    assert signals["ghostarchiveWarcValidated"] is True

    item = ManifestItem(
        publisher="ft",
        canonical_url=CANONICAL_URL,
        published_at="2026-06-11T07:00:00Z",
        section="markets",
        candidates=(),
    )
    valid, validation_signals = _validate_ft_ghostarchive_response(
        item,
        expected_headline=None,
        content=content,
        final_url=final_url,
    )
    assert valid is True
    assert (
        validation_signals["ftGhostarchiveOriginValidated"]
        is True
    )
    assert validation_signals["ghostarchiveOriginDateDeltaDays"] == 1
    assert validation_signals["ghostarchiveOriginBodyCharacters"] >= 1_000

    capture_client = StubClient(
        {
            search_url: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                search_html,
                search_url,
            ),
            ARCHIVE_URL: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                wrapper_html,
                ARCHIVE_URL,
            ),
            WARC_URL: (
                200,
                {"content-type": "application/warc"},
                _warc_response(article_html),
                WARC_URL,
            ),
        }
    )
    result = capture_item(
        item,
        archive_client=capture_client,
        output_dir=tmp_path,
        maximum_html_bytes=1_000_000,
    )
    assert result["status"] == "complete"
    capture = result["capture"]
    assert capture.selected_candidate.snapshot_url == ARCHIVE_URL
    assert capture.quality_score == 100
    assert capture.quality_signals["ghostarchiveWarcValidated"] is True
    assert (
        capture.quality_signals["ftGhostarchiveOriginValidated"]
        is True
    )
