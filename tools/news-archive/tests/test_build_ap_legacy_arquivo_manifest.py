from __future__ import annotations

import httpx

from jojo_olds_api.ap_legacy_catalog import build_ap_hosted_manifest_rows
from tools import build_ap_legacy_arquivo_manifest as tool


def test_recovers_missing_ctime_from_hosted_ap_page_metadata():
    original = (
        "http://hosted.ap.org/dynamic/stories/A/AFR_POL_SUDAN_SPGL-"
        "?SITE=AP&SECTION=HOME&TEMPLATE=DEFAULT"
    )
    rows = [
        {
            "url": original,
            "timestamp": "20110111223516",
            "status": "200",
            "mime": "text/html",
            "digest": "SAME-CONTENT",
            "length": "80000",
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert "arquivo.pt/noFrame/replay/20110111223516/" in str(
            request.url
        )
        return httpx.Response(
            200,
            content=b"""
            <table class="ap-story-table hnews hentry item">
              <tr><td>
                <div class="timestamp updated"
                     title="2011-01-11T1023Z"></div>
                <span class="headline entry-title">
                  Reportes de violencia y muertos por enfrentamientos
                </span>
                <span class="entry-content">
                  <p>This archived AP story has enough substantive article
                  text for the recovery guard to reject navigation and error
                  shells while accepting a real legacy story page.</p>
                </span>
              </td></tr>
            </table>
            """,
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        recovered, metrics = tool.recover_missing_ctime_rows(
            rows,
            client,
            workers=2,
            attempts=1,
        )

    assert metrics == {
        "missingCtimeRows": 1,
        "recoveryGroups": 1,
        "recoveredGroups": 1,
        "recoveredRows": 1,
        "recoveryFailures": 0,
    }
    assert recovered[0]["canonicalUrl"].endswith(
        "?CTIME=2011-01-11-10-23-00"
    )
    assert recovered[0]["expectedHeadline"].startswith(
        "Reportes de violencia"
    )

    manifest, manifest_metrics = build_ap_hosted_manifest_rows(
        recovered,
        from_year=2011,
        to_year=2011,
    )
    assert manifest_metrics["articles"] == 1
    assert manifest[0]["canonicalUrl"] == (
        "https://hosted.ap.org/dynamic/stories/A/AFR_POL_SUDAN_SPGL-"
        "?CTIME=2011-01-11-10-23-00"
    )
    assert manifest[0]["candidates"][0]["expectedHeadline"].startswith(
        "Reportes de violencia"
    )


def test_recovers_google_hosted_ap_page_metadata():
    original = (
        "http://www.google.com/hostednews/ap/article/ALeqM5example"
        "?docId/x3d07a2e5909f194d3189d3c87c44864496"
    )
    rows = [
        {
            "url": original,
            "timestamp": "20111203005736",
            "status": "200",
            "mime": "text/html",
            "digest": "GOOGLE-CONTENT",
            "length": "80000",
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert "arquivo.pt/noFrame/replay/20111203005736/" in str(
            request.url
        )
        return httpx.Response(
            200,
            content=b"""
            <html><head>
              <meta name="googlebot"
                    content="unavailable_after: 30-Dec-2011 16:09:00 PST">
              <link rel="syndication-source"
                    href="http://www.ap.org/story-id">
            </head><body>
              <div id="hostednews-article"><div class="hn-copy">
                <div class="g-section">
                  <div id="hn-headline">Ex Colo. sheriff accused</div>
                  <p>This complete Associated Press report contains enough
                  substantive reporting for validation of a real archived
                  Google Hosted News article page and its source metadata.</p>
                </div>
              </div></div>
            </body></html>
            """,
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        recovered, metrics = tool.recover_google_hosted_rows(
            rows,
            client,
            workers=2,
            attempts=1,
        )

    assert metrics["googleRecoveredRows"] == 1
    assert metrics["googleRecoveryFailures"] == 0
    assert recovered[0]["canonicalUrl"].endswith(
        "?docId=07a2e5909f194d3189d3c87c44864496"
    )
    assert recovered[0]["publishedAt"] == "2011-12-01T00:09:00+00:00"
    assert recovered[0]["expectedHeadline"] == "Ex Colo. sheriff accused"


def test_recovers_huffpost_ap_wire_page_metadata():
    original = (
        "http://www.huffingtonpost.com/huff-wires/20110104/"
        "af-kenya-corruption/"
    )
    rows = [
        {
            "url": original,
            "timestamp": "20110104180243",
            "status": "200",
            "mime": "text/html",
            "digest": "HUFF-WIRE-CONTENT",
            "length": "90000",
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"""
            <div class="entry">
              <h1>Kenyan minister resigns over car imports scandal</h1>
              <div class="comments_datetime"><p>
                <a class="wire_author">TOM MALITI</a> |
                January 4, 2011 10:06 AM EST |
                <span class="ap"><img alt="AP"></span>
              </p></div>
              <div class="entry_content">
                <p>This complete Associated Press wire report contains
                enough substantive reporting to validate a real archived
                partner page rather than a navigation or error shell.</p>
              </div>
            </div>
            """,
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        recovered, metrics = tool.recover_huff_wire_rows(
            rows,
            client,
            workers=2,
            attempts=1,
        )

    assert metrics["huffRecoveredRows"] == 1
    assert metrics["huffRecoveryFailures"] == 0
    assert recovered[0]["canonicalUrl"] == (
        "https://www.huffingtonpost.com/huff-wires/20110104/"
        "af-kenya-corruption"
    )
    assert recovered[0]["publishedAt"] == "2011-01-04T15:06:00+00:00"
