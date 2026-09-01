from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sqlite3
from types import SimpleNamespace

import pytest

import tools.audit_parser_validation_content as content_audit
from tools.audit_parser_validation_content import (
    _INTERFACE_TEXT_RE,
    _NYT_DEAD_INTERACTIVE_CONTROL_RE,
    _suspicious_selected_image,
    article_content_identity,
    contextual_scmp_competition_terms_block,
    contextual_scmp_virtual_event_signup_block,
    contextual_signup_article_block,
    image_identity,
    near_duplicate_article_pairs,
    nyt_raw_interactive_prose_characters,
    normalize_text,
    replacement_character_count,
    source_replacement_character_count,
    selected_validation_urls,
    url_year_mismatch,
)


def test_content_identity_detects_duplicate_articles_across_urls() -> None:
    body = "A complete gallery caption with substantive reporting. " * 4

    identity = article_content_identity(body)

    assert identity is not None
    assert identity == article_content_identity(body.replace(" ", "  "))
    assert identity != article_content_identity(body + " An independent update.")
    assert article_content_identity("too short") is None


def test_only_contextual_wsj_signup_story_blocks_bypass_interface_audit() -> None:
    text = "sign up for the newsletter and check out what we created."
    assert contextual_signup_article_block(
        "wsj",
        "https://www.wsj.com/articles/sign-up-for-wsjs-money-challenge-1",
        "Sign Up for WSJ's Money Challenge",
        text,
    )
    assert not contextual_signup_article_block(
        "wsj",
        "https://www.wsj.com/articles/an-unrelated-report-1",
        "An unrelated report",
        text,
    )
    assert not contextual_signup_article_block(
        "ft",
        "https://www.ft.com/content/sign-up-for-example",
        "Sign up for an example",
        text,
    )


def test_only_substantive_scmp_competition_terms_bypass_interface_audit() -> None:
    url = (
        "https://www.scmp.com/yp/discover/your-voice/competitions/article/"
        "3054565/fathers-day-picture-competition-2019-win-buffet"
    )
    rules = (
        "Terms and conditions. The contest is only open to secondary school "
        "students in Hong Kong. Entries must be the contestant's original work. "
        "Contestants retain copyright of their submitted entries."
    )

    assert contextual_scmp_competition_terms_block(
        "scmp", url, "terms and conditions", rules
    )
    assert not contextual_scmp_competition_terms_block(
        "scmp", url, "terms and conditions", "Terms and conditions"
    )
    assert not contextual_scmp_competition_terms_block(
        "scmp",
        "https://www.scmp.com/news/china/article/1/example",
        "terms and conditions",
        rules,
    )
    assert not contextual_scmp_competition_terms_block(
        "ft", url, "terms and conditions", rules
    )
    assert not contextual_scmp_competition_terms_block(
        "scmp", url, "terms of use", rules
    )


def test_scmp_clockenflap_competition_terms_bypass_interface_audit() -> None:
    url = (
        "https://www.scmp.com/yp/discover/your-voice/competitions/article/"
        "3066591/band-share-your-sound-your-chance-win-tickets"
    )
    rules = (
        "Terms and Conditions. The tickets cannot be exchanged for cash. "
        "All members must be Hong Kong secondary school students 19 years old "
        "or younger. Entry to the competition means you consent to Young Post "
        "using your photo and music."
    )

    assert contextual_scmp_competition_terms_block(
        "scmp", url, "terms and conditions", rules
    )
    assert not contextual_scmp_competition_terms_block(
        "scmp",
        url,
        "terms and conditions",
        "The tickets cannot be exchanged for cash.",
    )


def test_only_official_scmp_virtual_event_signup_bypasses_interface_audit() -> None:
    url = (
        "https://www.scmp.com/yp/discover/news/hong-kong/article/3105813/"
        "hong-kong-university-science-and-technology-hold-online"
    )
    headline = (
        "Hong Kong University of Science and Technology to hold online "
        "information session on Saturday"
    )
    text = "sign up for the virtual tour here."
    body = (
        "The virtual information day is for undergraduate students. "
        "Admission information will be available and participants can take "
        "a virtual campus tour. Sign up for the virtual tour here."
    )
    official_link = (
        '<p><a href="https://join.ust.hk/vinfoday">'
        "Sign up for the virtual tour here.</a></p>"
    )

    assert contextual_scmp_virtual_event_signup_block(
        "scmp", url, headline, text, body, official_link
    )
    assert not contextual_scmp_virtual_event_signup_block(
        "scmp",
        url,
        headline,
        text,
        body,
        official_link.replace("join.ust.hk", "ads.example.test"),
    )
    assert not contextual_scmp_virtual_event_signup_block(
        "scmp",
        "https://www.scmp.com/news/china/article/1/example",
        headline,
        text,
        body,
        official_link,
    )


def test_near_duplicate_content_detects_minor_hold_page_revision() -> None:
    body = " ".join(
        f"Paragraph {index} reports the central bank decision and its impact."
        for index in range(100)
    )
    near_duplicate = body.replace(
        "central bank decision",
        "central bank policy decision",
        1,
    )
    unrelated = " ".join(
        f"Section {index} reviews an unrelated election campaign and its result."
        for index in range(100)
    )

    duplicates = near_duplicate_article_pairs(
        {
            "https://example.test/formal": body,
            "https://example.test/hold-formal": near_duplicate,
            "https://example.test/unrelated": unrelated,
        }
    )

    assert duplicates == [
        {
            "type": "near-duplicate-article-content",
            "url": "https://example.test/formal",
            "detail": {
                "sampleUrls": [
                    "https://example.test/formal",
                    "https://example.test/hold-formal",
                ],
                "similarity": pytest.approx(0.98, abs=0.02),
                "bodyCharacters": [len(normalize_text(body)), len(normalize_text(near_duplicate))],
            },
        },
    ]
    assert near_duplicate_article_pairs(
        {
            "https://example.test/exact-a": body,
            "https://example.test/exact-b": body,
        }
    ) == []


def test_normalizes_text_and_image_identity() -> None:
    assert normalize_text("  Hello\n WORLD ") == "hello world"
    assert image_identity("HTTPS://IMG.EXAMPLE/a.jpg?width=1200#x") == (
        "https://img.example/a.jpg"
    )
    assert image_identity(
        "http://s1.reutersmedia.net/resources/r/"
        "?m=02&d=20120310&t=2&i=580898814&w=1200&r=CBRE82902CK00"
    ) == image_identity(
        "http://s1.reutersmedia.net/resources/r/"
        "?m=02&d=20120310&t=2&i=580898814&w=20&r=CBRE82902CK00"
    )
    assert image_identity(
        "http://s1.reutersmedia.net/resources/r/"
        "?m=02&d=20120310&t=2&i=580898814&r=OTHER"
    ) != image_identity(
        "http://s1.reutersmedia.net/resources/r/"
        "?m=02&d=20120310&t=2&i=580898814&r=CBRE82902CK00"
    )
    assert image_identity(
        "http://markets.on.nytimes.com/research/tools/builder/api.asp"
        "?sym=AMZN&duration=1&w=300&h=200"
    ) != image_identity(
        "http://markets.on.nytimes.com/research/tools/builder/api.asp"
        "?sym=AMZN&duration=90&w=300&h=200"
    )
    assert image_identity(
        "http://markets.on.nytimes.com/research/tools/builder/api.asp"
        "?sym=AMZN&duration=90&w=300&h=200"
    ) == image_identity(
        "http://markets.on.nytimes.com/research/tools/builder/api.asp"
        "?h=600&duration=90&sym=AMZN&w=900"
    )
    assert image_identity(
        "https://cdn.i-scmp.com/sites/default/files/styles/og_image_scmp_generic/"
        "public/d8/images/methode/2020/08/12/"
        "7cc6bfec-dc3d-11ea-b1d3-42d340dc91a3_image_hires_151415.jpg"
    ) == image_identity(
        "https://cdn.i-scmp.com/sites/default/files/d8/images/methode/2020/08/12/"
        "7cc6bfec-dc3d-11ea-b1d3-42d340dc91a3_1320x770_151415.jpg"
    )


def test_interface_text_detector_does_not_match_ordinary_prose() -> None:
    assert _INTERFACE_TEXT_RE.search("subscribe") is not None
    assert _INTERFACE_TEXT_RE.search("Related") is not None
    assert _INTERFACE_TEXT_RE.search("Share this:") is not None
    assert _INTERFACE_TEXT_RE.search("Keep reading") is not None
    assert _INTERFACE_TEXT_RE.search("-" * 80) is not None
    assert _INTERFACE_TEXT_RE.search(
        "Where climate change meets business, markets and politics."
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "Find out about our latest stories first — follow @ftweekend on Twitter"
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "RECOMMENDED NEWSLETTERS FOR YOU Due Diligence — Top stories"
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "Sign up now for a 50% early bird discount on the 100+ page China "
        "Internet Report 2020 Pro Edition."
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "Purchase the 100+ page China Internet Report 2020 Pro Edition."
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "Purchase the 120+ page China Internet Report 2020 Pro Edition."
    ) is not None
    assert _INTERFACE_TEXT_RE.search("c.2020 The New York Times Company") is not None
    assert _INTERFACE_TEXT_RE.search("RSS") is not None
    assert _INTERFACE_TEXT_RE.search("The reports are closely related.") is None
    assert _INTERFACE_TEXT_RE.search("subscribe to our daily newsletter") is not None
    assert _INTERFACE_TEXT_RE.search("terms of use") is not None
    assert _INTERFACE_TEXT_RE.search("Download the app") is not None
    assert _INTERFACE_TEXT_RE.search("Download our app today!") is not None
    assert _INTERFACE_TEXT_RE.search(
        "Download the app and sign in for the deal."
    ) is None
    assert _INTERFACE_TEXT_RE.search("01 第1页 02 第2页") is not None
    assert _INTERFACE_TEXT_RE.search(
        "MarketWatch拥有位于三大洲的100多名记者，为世界各地读者提供新闻。"
    ) is not None
    assert _INTERFACE_TEXT_RE.search(
        "The court considered whether violating the terms of use was illegal."
    ) is None
    assert _INTERFACE_TEXT_RE.search(
        "Terms and Conditions in free software says certain provisions can be "
        "ignored in the case of a widespread viral infection."
    ) is None
    assert _INTERFACE_TEXT_RE.search(
        "Kafka users can publish data streams or subscribe to them in real time."
    ) is None
    assert _NYT_DEAD_INTERACTIVE_CONTROL_RE.fullmatch("Read full answer")
    assert _NYT_DEAD_INTERACTIVE_CONTROL_RE.fullmatch("Next: Another Candidate")
    assert not _NYT_DEAD_INTERACTIVE_CONTROL_RE.fullmatch(
        "The next section explains the result."
    )
    assert replacement_character_count("clean", "also clean") == 0
    assert replacement_character_count("bad \ufffd text", "\ufffd") == 2
    assert source_replacement_character_count(b"raw \xef\xbf\xbd marker") == 1
    assert source_replacement_character_count(b"clean") == 0


def test_measures_unique_raw_nyt_interactive_prose() -> None:
    paragraph = "A detailed reported paragraph with useful context. " * 12
    html = (
        "<div class='interactive-graphic'><p>"
        + paragraph
        + "</p><p>"
        + paragraph
        + "</p></div>"
    ).encode()

    assert nyt_raw_interactive_prose_characters(
        html,
        "https://www.nytimes.com/interactive/2019/example.html",
    ) == len(normalize_text(paragraph))
    assert nyt_raw_interactive_prose_characters(
        html,
        "https://www.nytimes.com/2019/example.html",
    ) == 0


def test_suspicious_image_detector_distinguishes_movie_from_user_avatar() -> None:
    assert _suspicious_selected_image("https://analytics.example/pixel.gif")
    assert _suspicious_selected_image(
        "https://analytics.example/tracking-pixel-1x1.png?cache=1"
    )
    # ``pixel`` is also ordinary editorial prose in image slugs (for example,
    # Google Pixel coverage); that must not be treated as a tracking asset.
    assert not _suspicious_selected_image(
        "https://cdn4.i-scmp.com/sites/default/files/styles/980x551/public/"
        "2016/09/20/google-to-announce-new-pixel-phones-amazon-echo-"
        "competitor-details-on-october-4th_0.jpg?itok=b7ysJt5s"
    )
    assert _suspicious_selected_image(
        "https://media.example/authors/default-avatar.png"
    )
    assert not _suspicious_selected_image(
        "https://media.npr.org/assets/movies/2009/12/avatar/"
        "humanandavatar2-f44c267a.jpg"
    )
    assert not _suspicious_selected_image(
        "https://media.npr.org/assets/blogs/13.7/images/2009/12/"
        "avatar-blue_wide.jpg"
    )
    assert _suspicious_selected_image(
        "https://www.ft.com/__assets/creatives/brand-ft/icons/"
        "v2/open-graph.png"
    )
    assert _suspicious_selected_image(
        "https://www.zaobao.com.sg/themes/custom/zbsg2020/images/"
        "social-share.png"
    )
    assert _suspicious_selected_image(
        "https://www.aljazeera.com/wp-content/uploads/2015/09/"
        "445ed4f604cc49698f3836f370e3bd83_6.jpeg"
    )
    assert not _suspicious_selected_image(
        "https://www.aljazeera.com/wp-content/uploads/2015/11/"
        "412b24ead10a43f0aae365d7bbda1809_18.jpeg"
    )
    assert not _suspicious_selected_image(
        "https://media.npr.org/assets/img/2015/12/10/"
        "transparent_204_00647_wide-4703ef85e0e4fa056c3f19b9204070d151fa2584.jpg"
    )
    assert not _suspicious_selected_image(
        "https://media.npr.org/assets/bakertaylor/covers/i/"
        "icon/9781481425155_custom-8876aa5ad899201e6e17f23bd38d750f4ea8f0ea-s1200.jpg"
    )
    assert not _suspicious_selected_image(
        "https://static01.nyt.com/images/2020/03/26/us/"
        "onpolitics-2020-eyeballs-icon/"
        "onpolitics-2020-eyeballs-icon-videoSixteenByNineJumbo1600.jpg"
    )
    assert not _suspicious_selected_image(
        "https://static01.nyt.com/images/2020/01/10/multimedia/"
        "onpolitics-gavel-icon/"
        "onpolitics-gavel-videoSixteenByNineJumbo1600-v3.jpg"
    )
    assert not _suspicious_selected_image(
        "https://static01.nyt.com/images/2020/01/10/multimedia/"
        "onpolitics-gavel-icon/"
        "onpolitics-gavel-icon-superJumbo-v6.gif"
    )
    assert not _suspicious_selected_image(
        "https://www.aljazeera.com/wp-content/uploads/2024/08/"
        "2024-08-21T140803Z_769601242_RC2DK9AZISKK_RTRMADP_3_"
        "UKRAINE-CRISIS-RUSSIA-FIRE-ICON-1724250953.jpg"
    )
    assert not _suspicious_selected_image(
        "https://si.wsj.net/public/resources/images/"
        "B3-CT740_SPACER_M_20181228165849.jpg"
    )


def test_url_year_mismatch_detects_misdated_nyt_interactive() -> None:
    assert url_year_mismatch(
        "nyt",
        "https://www.nytimes.com/interactive/2016/obituaries/notable-deaths/x",
        2018,
    ) == 2016
    assert url_year_mismatch(
        "nyt",
        "https://www.nytimes.com/interactive/2018/world/example.html",
        2018,
    ) is None
    assert not _suspicious_selected_image(
        "https://media.npr.org/assets/news/2010/02/19/"
        "logo_custom-3257db8ff3898e2259e954abba1d1a766a03f557.jpg"
    )


def test_selects_only_active_qa_passing_complete_sample() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config VALUES (2010, 2, 'ap-parser/1', 3);
        INSERT INTO parser_validation_samples VALUES
          ('https://example.test/b', 2010, '02'),
          ('https://example.test/a', 2010, '01'),
          ('https://example.test/rejected', 2010, '00');
        INSERT INTO parser_validation_results VALUES
          ('https://example.test/b', 'ap', 2010, 'ap-parser/1', 3, 1),
          ('https://example.test/a', 'ap', 2010, 'ap-parser/1', 3, 1),
          ('https://example.test/rejected', 'ap', 2010, 'ap-parser/1', 3, 0);
        INSERT INTO captures VALUES
          ('https://example.test/b', 'complete', 'objects/b.gz'),
          ('https://example.test/a', 'complete', 'objects/a.gz'),
          ('https://example.test/rejected', 'complete', 'objects/r.gz');
        """
    )
    version, revision, urls = selected_validation_urls(
        connection,
        publisher="ap",
        year=2010,
        target=2,
    )
    assert version == "ap-parser/1"
    assert revision == 3
    assert urls == ["https://example.test/a", "https://example.test/b"]


def test_selects_sample_from_checkpoint_before_qa_revisions() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2018, 1, 'nyt-parser/legacy');
        INSERT INTO parser_validation_samples
          VALUES ('https://example.test/nyt', 2018, '01');
        INSERT INTO parser_validation_results VALUES (
          'https://example.test/nyt', 'nyt', 2018,
          'nyt-parser/legacy', 1
        );
        INSERT INTO captures VALUES (
          'https://example.test/nyt', 'complete', 'objects/nyt.gz'
        );
        """
    )

    version, revision, urls = selected_validation_urls(
        connection, publisher="nyt", year=2018, target=1
    )

    assert version == "nyt-parser/legacy"
    assert revision == 0
    assert urls == ["https://example.test/nyt"]


def test_rejects_incomplete_target() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config VALUES (2010, 2, 'ap-parser/1', 3);
        """
    )
    with pytest.raises(ValueError, match="has 0 rows, expected 2"):
        selected_validation_urls(
            connection,
            publisher="ap",
            year=2010,
            target=2,
        )


def test_partial_audit_selects_available_rows_without_lowering_target() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2017, 800, 'ft-parser/current', 0);
        INSERT INTO parser_validation_samples
          VALUES ('https://example.test/ft', 2017, '01');
        INSERT INTO parser_validation_results VALUES (
          'https://example.test/ft', 'ft', 2017,
          'ft-parser/current', 0, 1
        );
        INSERT INTO captures VALUES (
          'https://example.test/ft', 'complete', 'objects/ft.gz'
        );
        """
    )

    version, revision, urls = selected_validation_urls(
        connection,
        publisher="ft",
        year=2017,
        target=800,
        allow_partial=True,
    )

    assert version == "ft-parser/current"
    assert revision == 0
    assert urls == ["https://example.test/ft"]


def test_content_audit_rejects_complete_article_from_wrong_year(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://www.ft.com/content/00bd522e-2a38-11e0-b906-00144feab49a"
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        f"""
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2019, 1, 'ft-parser/test', 0);
        INSERT INTO parser_validation_samples VALUES ('{url}', 2019, '01');
        INSERT INTO parser_validation_results
          VALUES ('{url}', 'ft', 2019, 'ft-parser/test', 0, 1);
        INSERT INTO captures VALUES ('{url}', 'complete', 'objects/test.gz');
        """
    )
    connection.close()

    article = SimpleNamespace(
        quality=SimpleNamespace(
            status=SimpleNamespace(value="complete"),
            body_characters=240,
        ),
        content_type=SimpleNamespace(value="article"),
        published_at=datetime(2011, 1, 27, tzinfo=timezone.utc),
        headline="A complete archived review",
        plain_text="Substantive archived reporting. " * 10,
        extraction=SimpleNamespace(parser_version="ft-parser/test"),
        blocks=[SimpleNamespace(text="Substantive archived reporting.")],
        body_html="<p>Substantive archived reporting.</p>",
        images=[],
    )
    monkeypatch.setattr(
        content_audit,
        "completed_raw_capture",
        lambda *_args, **_kwargs: SimpleNamespace(
            published_at=datetime(2019, 9, 17, tzinfo=timezone.utc)
        ),
    )
    monkeypatch.setattr(
        content_audit,
        "_read_capture_html",
        lambda *_args, **_kwargs: b"<html></html>",
    )
    monkeypatch.setattr(
        content_audit,
        "_read_dependent_resources",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        content_audit,
        "parse_article",
        lambda *_args, **_kwargs: article,
    )

    result = content_audit.audit_content(
        state=state,
        archive_root=tmp_path,
        publisher="ft",
        year=2019,
        target=1,
        expected_parser_version="ft-parser/test",
    )

    assert result["formatVersion"] == "jojo-parser-validation-content-audit/6"
    assert result["passesHardChecks"] is False
    assert result["hardAnomalies"] == [
        {
            "type": "complete-publication-year-mismatch",
            "url": url,
            "detail": {
                "expectedYear": 2019,
                "publishedAt": "2011-01-27T00:00:00+00:00",
            },
        }
    ]


def test_content_audit_uses_capture_timezone_at_year_boundary(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = (
        "https://apnews.com/sports/san-antonio-spurs-boston-celtics-"
        "10bbf60fef7e320cf0be8e184da5b987"
    )
    state = tmp_path / "capture.sqlite3"
    connection = sqlite3.connect(state)
    connection.executescript(
        f"""
        CREATE TABLE parser_validation_config (
          sample_year INTEGER PRIMARY KEY,
          target_size INTEGER NOT NULL,
          parser_version TEXT NOT NULL,
          qa_revision INTEGER NOT NULL
        );
        CREATE TABLE parser_validation_samples (
          canonical_url TEXT PRIMARY KEY,
          sample_year INTEGER NOT NULL,
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
          raw_path TEXT
        );
        INSERT INTO parser_validation_config
          VALUES (2023, 1, 'ap-parser/test', 1);
        INSERT INTO parser_validation_samples VALUES ('{url}', 2023, '01');
        INSERT INTO parser_validation_results
          VALUES ('{url}', 'ap', 2023, 'ap-parser/test', 1, 1);
        INSERT INTO captures VALUES ('{url}', 'complete', 'objects/test.gz');
        """
    )
    connection.close()

    capture = SimpleNamespace(
        published_at=datetime(
            2023,
            12,
            31,
            22,
            37,
            tzinfo=timezone(timedelta(hours=-5)),
        )
    )
    article = SimpleNamespace(
        quality=SimpleNamespace(
            status=SimpleNamespace(value="complete"),
            body_characters=240,
        ),
        content_type=SimpleNamespace(value="article"),
        published_at=datetime(2024, 1, 1, 2, 25, tzinfo=timezone.utc),
        headline="NBA-leading Celtics beat the Spurs",
        plain_text="Substantive archived sports reporting. " * 10,
        extraction=SimpleNamespace(parser_version="ap-parser/test"),
        blocks=[SimpleNamespace(text="Substantive archived sports reporting.")],
        body_html="<p>Substantive archived sports reporting.</p>",
        images=[],
    )
    monkeypatch.setattr(
        content_audit,
        "completed_raw_capture",
        lambda *_args, **_kwargs: capture,
    )
    monkeypatch.setattr(
        content_audit,
        "_read_capture_html",
        lambda *_args, **_kwargs: b"<html></html>",
    )
    monkeypatch.setattr(
        content_audit,
        "_read_dependent_resources",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        content_audit,
        "parse_article",
        lambda *_args, **_kwargs: article,
    )

    result = content_audit.audit_content(
        state=state,
        archive_root=tmp_path,
        publisher="ap",
        year=2023,
        target=1,
        expected_parser_version="ap-parser/test",
    )

    assert result["formatVersion"] == "jojo-parser-validation-content-audit/6"
    assert result["passesHardChecks"] is True
    assert result["hardAnomalies"] == []
