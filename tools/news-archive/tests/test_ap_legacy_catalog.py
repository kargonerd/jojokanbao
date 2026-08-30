from __future__ import annotations

from jojo_olds_api.ap_legacy_catalog import (
    ap_google_hosted_page_metadata,
    ap_huff_wire_page_metadata,
    ap_partner_publication_datetime,
    ap_hosted_page_metadata,
    build_ap_bigstory_manifest_rows,
    build_ap_partner_manifest_rows,
    build_ap_hosted_manifest_rows,
    normalize_ap_partner_url,
)
from jojo_olds_api.news_models import CaptureProvider


def _row(
    original: str,
    *,
    timestamp: str,
    digest: str,
) -> dict[str, object]:
    return {
        "url": original,
        "timestamp": timestamp,
        "status": "200",
        "mime": "text/html",
        "digest": digest,
        "length": "84520",
    }


def test_builds_distinct_hosted_ap_revisions_and_deduplicates_sites():
    first = (
        "http://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?SITE=AZPHG&SECTION=HOME&TEMPLATE=DEFAULT"
        "&CTIME=2011-01-11-12-21-19"
    )
    default_site = first.replace("SITE=AZPHG", "SITE=AP")
    second_revision = first.replace(
        "CTIME=2011-01-11-12-21-19",
        "CTIME=2011-01-13-16-03-00",
    )

    rows, metrics = build_ap_hosted_manifest_rows(
        [
            _row(first, timestamp="20110113114709", digest="A"),
            _row(default_site, timestamp="20110113114800", digest="B"),
            _row(second_revision, timestamp="20110116183019", digest="C"),
        ],
        from_year=2011,
        to_year=2011,
    )

    assert metrics["articles"] == 2
    assert rows[0]["canonicalUrl"] == (
        "https://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?CTIME=2011-01-11-12-21-19"
    )
    assert rows[1]["canonicalUrl"].endswith(
        "?CTIME=2011-01-13-16-03-00"
    )
    assert rows[0]["publishedAt"] == "2011-01-11T12:21:19+00:00"
    assert len(rows[0]["candidates"]) == 2
    assert rows[0]["candidates"][0]["provider"] == "arquivo-pt"
    assert "SITE=AP" in rows[0]["candidates"][0]["snapshotUrl"]


def test_rejects_missing_ctime_wrong_year_and_non_html_rows():
    valid = (
        "http://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?SITE=AP&CTIME=2011-01-11-12-21-19"
    )
    missing_ctime = valid.split("?", 1)[0] + "?SITE=AP"
    wrong_year = valid.replace("2011-", "2012-", 1)
    non_html = _row(valid, timestamp="20110113114709", digest="D")
    non_html["mime"] = "image/jpeg"

    rows, metrics = build_ap_hosted_manifest_rows(
        [
            _row(missing_ctime, timestamp="20110113114709", digest="A"),
            _row(wrong_year, timestamp="20120113114709", digest="B"),
            non_html,
        ],
        from_year=2011,
        to_year=2011,
    )

    assert rows == []
    assert metrics["rowsRejected"] == 3


def test_deduplicates_hosted_articles_by_primary_capture_digest():
    first = (
        "http://hosted.ap.org/dynamic/stories/A/AF_IVORY_COAST"
        "?SITE=AP&CTIME=2011-01-11-12-21-19"
    )
    duplicate = (
        "http://hosted.ap.org/dynamic/stories/B/BRITAIN_POLITICS"
        "?SITE=AP&CTIME=2011-01-12-12-21-19"
    )

    rows, metrics = build_ap_hosted_manifest_rows(
        [
            _row(first, timestamp="20110113114709", digest="SAME"),
            _row(duplicate, timestamp="20110114114709", digest="SAME"),
        ],
        from_year=2011,
        to_year=2011,
    )

    assert len(rows) == 1
    assert metrics["duplicateArticlesByDigest"] == 1


def test_reads_identity_metadata_from_missing_ctime_story_page():
    result = ap_hosted_page_metadata(
        b"""
        <table class="ap-story-table hnews hentry item">
          <tr><td>
            <div class="timestamp updated" title="2011-01-16T1946Z"></div>
            <span class="headline entry-title">
              Gunbattles, food shortages temper Tunisians' joy
            </span>
            <span class="entry-content">
              <p>This complete Associated Press report contains enough
              substantive reporting to establish that the replay is an
              article rather than a front page, error shell, or redirect.</p>
            </span>
          </td></tr>
        </table>
        """
    )

    assert result is not None
    published_at, headline = result
    assert published_at.isoformat() == "2011-01-16T19:46:00+00:00"
    assert headline == "Gunbattles, food shortages temper Tunisians' joy"


def test_normalizes_legacy_google_and_yahoo_ap_partner_urls():
    google = (
        "http://www.google.com/hostednews/ap/article/ALeqM5example"
        "?docId/x3d07a2e5909f194d3189d3c87c44864496"
    )
    assert normalize_ap_partner_url(google) == (
        "https://www.google.com/hostednews/ap/article/ALeqM5example"
        "?docId=07a2e5909f194d3189d3c87c44864496"
    )
    assert normalize_ap_partner_url(
        google.replace("docId/x3d", "docId/u003d")
    ) == normalize_ap_partner_url(google)
    yahoo = (
        "http://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
        ";_ylt=tracking?utm_source=test"
    )
    assert normalize_ap_partner_url(yahoo) == (
        "https://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
    )
    yahoo = (
        "http://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
        "?utm_source=test"
    )
    assert normalize_ap_partner_url(yahoo) == (
        "https://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear"
    )
    assert ap_partner_publication_datetime(yahoo).isoformat() == (
        "2011-01-11T00:00:00+00:00"
    )
    yahoo_travel = (
        "http://news.yahoo.com/s/ap_travel/20101223/ap_tr_ge/"
        "us_travel_cybertrips_fodor_s;_ylt=tracking"
    )
    assert normalize_ap_partner_url(yahoo_travel) == (
        "https://news.yahoo.com/s/ap_travel/20101223/ap_tr_ge/"
        "us_travel_cybertrips_fodor_s"
    )
    assert ap_partner_publication_datetime(yahoo_travel).year == 2010
    huff_wire = (
        "http://www.huffingtonpost.com/huff-wires/20110104/"
        "af-kenya-corruption/?utm_source=tracking"
    )
    assert normalize_ap_partner_url(huff_wire) == (
        "https://www.huffingtonpost.com/huff-wires/20110104/"
        "af-kenya-corruption"
    )
    assert ap_partner_publication_datetime(huff_wire).isoformat() == (
        "2011-01-04T00:00:00+00:00"
    )


def test_reads_google_hosted_ap_identity_metadata():
    result = ap_google_hosted_page_metadata(
        b"""
        <html><head>
          <meta name="googlebot"
                content="unavailable_after: 30-Dec-2011 16:09:00 PST">
          <link rel="syndication-source"
                href="https://arquivo.pt/noFrame/replay/20111203005736oe_/http://www.ap.org/story-id">
        </head><body>
          <div id="hostednews-article"><div class="hn-copy">
            <div class="g-section">
              <div id="hn-headline">Ex Colo. sheriff accused</div>
              <p>This Associated Press report has enough substantive text
              to establish that the archived page is a real article rather
              than a navigation, consent, redirect, or error shell.</p>
            </div>
          </div></div>
        </body></html>
        """
    )

    assert result is not None
    published_at, headline = result
    assert published_at.isoformat() == "2011-12-01T00:09:00+00:00"
    assert headline == "Ex Colo. sheriff accused"


def test_builds_google_and_yahoo_partner_manifest_rows():
    google = _row(
        "http://www.google.com/hostednews/ap/article/ALeqM5example"
        "?docId/x3d07a2e5909f194d3189d3c87c44864496",
        timestamp="20111203005736",
        digest="GOOGLE",
    )
    google["publishedAt"] = "2011-11-30T00:09:00+00:00"
    google["expectedHeadline"] = "Ex Colo. sheriff accused"
    google["partnerValidated"] = "google-hosted-ap"
    yahoo = _row(
        "http://news.yahoo.com/s/ap/20110111/ap_on_re_eu/iran_nuclear",
        timestamp="20110112185146",
        digest="YAHOO",
    )

    rows, metrics = build_ap_partner_manifest_rows(
        [google, yahoo],
        from_year=2011,
        to_year=2011,
    )

    assert metrics["articles"] == 2
    assert rows[0]["canonicalUrl"].startswith(
        "https://news.yahoo.com/s/ap/20110111/"
    )
    assert rows[0]["publishedAt"] == "2011-01-11T00:00:00+00:00"
    assert rows[1]["canonicalUrl"].startswith(
        "https://www.google.com/hostednews/ap/article/"
    )
    assert rows[1]["candidates"][0]["expectedHeadline"] == (
        "Ex Colo. sheriff accused"
    )


def test_builds_wayback_yahoo_partner_candidate():
    yahoo = _row(
        "http://news.yahoo.com:80/s/ap/20100101/"
        "ap_en_ce/us_limbaugh_hospital",
        timestamp="20100104083044",
        digest="WAYBACK-YAHOO",
    )

    rows, metrics = build_ap_partner_manifest_rows(
        [yahoo],
        from_year=2010,
        to_year=2010,
        provider=CaptureProvider.WAYBACK,
    )

    assert metrics["articles"] == 1
    candidate = rows[0]["candidates"][0]
    assert candidate["provider"] == "wayback"
    assert candidate["snapshotUrl"] == (
        "https://web.archive.org/web/20100104083044id_/"
        "http://news.yahoo.com:80/s/ap/20100101/"
        "ap_en_ce/us_limbaugh_hospital"
    )


def test_builds_wayback_bigstory_candidate_with_capture_year_hint():
    row = _row(
        "http://bigstory.ap.org:80/article/"
        "007-exhibition-looks-screen-spy-style-icon",
        timestamp="20120706031558",
        digest="BIGSTORY",
    )

    rows, metrics = build_ap_bigstory_manifest_rows(
        [row],
        from_year=2012,
        to_year=2012,
    )

    assert metrics["articles"] == 1
    assert rows[0]["canonicalUrl"] == (
        "https://bigstory.ap.org/article/"
        "007-exhibition-looks-screen-spy-style-icon"
    )
    assert rows[0]["publishedAt"] == "2012-07-06T03:15:58+00:00"
    assert rows[0]["candidates"][0]["provider"] == "wayback"


def test_rejects_unvalidated_google_and_huffpost_partner_rows():
    google = _row(
        "http://www.google.com/hostednews/ap/article/ALeqM5example",
        timestamp="20111203005736",
        digest="GOOGLE",
    )
    google["publishedAt"] = "2011-12-01T00:09:00+00:00"
    huff = _row(
        "http://www.huffingtonpost.com/huff-wires/20110104/"
        "af-kenya-corruption/",
        timestamp="20110104180243",
        digest="HUFF",
    )

    rows, metrics = build_ap_partner_manifest_rows(
        [google, huff],
        from_year=2011,
        to_year=2011,
    )

    assert rows == []
    assert metrics["rowsRejected"] == 2


def test_reads_huffpost_ap_wire_identity_metadata():
    result = ap_huff_wire_page_metadata(
        b"""
        <div class="entry">
          <h1>Kenyan minister resigns over car imports scandal</h1>
          <div class="comments_datetime"><p>
            <a class="wire_author">TOM MALITI</a> |
            January 4, 2011 10:06 AM EST |
            <span class="ap"><img alt="AP"></span>
          </p></div>
          <div class="entry_content">
            <p>This complete Associated Press wire report contains enough
            substantive reporting to validate a real partner article page,
            rather than a navigation, consent, redirect, or error shell.</p>
          </div>
        </div>
        """
    )

    assert result is not None
    published_at, headline = result
    assert published_at.isoformat() == "2011-01-04T15:06:00+00:00"
    assert headline == "Kenyan minister resigns over car imports scandal"
