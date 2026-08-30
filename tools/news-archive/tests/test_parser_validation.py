from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

import pytest

from jojo_news_archive.news_models import (
    CaptureCandidate,
    CaptureProvider,
    RawCapture,
)
from jojo_news_archive.parser_validation import (
    _has_generic_interface_noise,
    _has_publisher_interface_noise,
    _validation_article_identity,
    ensure_parser_validation_plan,
    failed_completed_parser_validation_files,
    initialize_parser_validation_schema,
    is_axios_internal_test_entry,
    parser_validation_target_reached,
    parser_validation_summary,
    pending_completed_parser_validation_files,
    pending_parser_validation_urls,
    record_parser_validation,
)
from jojo_news_archive.news_parser import _terminal_tandem_repeat_length


def test_terminal_tandem_repeat_requires_long_punctuated_exact_suffix():
    repeated = "开调查，同时删除包括页岩油、天然气、煤炭在内部分能源生产的限制。"
    damaged = "劳工部就签证计划遭滥用展" + repeated + repeated

    assert _terminal_tandem_repeat_length(damaged) == len(repeated)
    assert _terminal_tandem_repeat_length("大家说好，好，好。") == 0
    assert _terminal_tandem_repeat_length("这是一句正常报道，没有重复。") == 0


def test_generic_interface_noise_requires_standalone_trending_stories():
    assert _has_generic_interface_noise(["trending stories"])
    assert not _has_generic_interface_noise(
        [
            "many local newsrooms use social networks to monitor "
            "trending stories on social media."
        ]
    )
    assert _has_generic_interface_noise(["read more:"])
    assert not _has_generic_interface_noise(
        ["read more:"], allow_editorial_read_more=True
    )


def test_generic_interface_noise_does_not_match_editorial_share_sentence():
    assert _has_generic_interface_noise(["share this article"])
    assert not _has_generic_interface_noise(
        ["by the way, share this article. please."]
    )
from jojo_news_archive.raw_archive_capture import (
    completed_raw_capture,
    initialize_capture_schema,
    load_capture_manifest,
    pending_captures,
    record_capture_result,
    store_raw_html,
)


def test_publisher_interface_noise_detects_wsj_promo_sequences():
    assert _has_publisher_interface_noise(
        "wsj",
        [
            "buy side from wsj expert recommendations on products "
            "and services, independent from the wall street journal newsroom."
        ],
    )
    assert _has_publisher_interface_noise(
        "wsj",
        [
            "article reporting",
            "stay informed",
            "get a coronavirus briefing six days a week: sign up here.",
        ],
    )
    assert _has_publisher_interface_noise(
        "wsj",
        [
            "article reporting",
            "free resources",
            "live updates",
            "daily video briefing",
        ],
    )
    assert not _has_publisher_interface_noise(
        "wsj",
        ["the article discussed free resources and live updates."],
    )
    assert not _has_publisher_interface_noise(
        "wsj",
        [
            "substantive reporting about the deal. (sign up for our "
            "markets newsletter, a premarkets primer packed with news, "
            "trends and ideas.)"
        ],
    )


def test_axios_internal_fixture_detection_requires_known_slug_and_headline():
    assert is_axios_internal_test_entry(
        "https://www.axios.com/2017/12/16/axios-generate-test-1513388154",
        "Axios Generate test",
    )
    assert is_axios_internal_test_entry(
        "https://www.axios.com/2017/12/16/"
        "test-this-is-second-persons-post-1513388144",
        "TEST: This is second person's post",
    )
    assert not is_axios_internal_test_entry(
        "https://www.axios.com/2017/12/15/"
        "trump-crams-for-100-days-test-1513301779",
        "Trump crams for 100 Days test",
    )
    assert not is_axios_internal_test_entry(
        "https://www.axios.com/2017/12/16/axios-generate-test-1513388154",
        "Axios reports on a power generation test",
    )


def test_publisher_interface_noise_detects_ap_terminal_period_block():
    assert _has_publisher_interface_noise(
        "ap",
        ["substantive article reporting.", "."],
    )
    assert not _has_publisher_interface_noise(
        "ap",
        ["substantive article reporting."],
    )


def test_publisher_interface_noise_detects_bloomberg_promos():
    assert _has_publisher_interface_noise(
        "bloomberg",
        ["article reporting", "related stories:"],
    )
    assert _has_publisher_interface_noise(
        "bloomberg",
        ["watch this next"],
    )
    assert _has_publisher_interface_noise(
        "bloomberg",
        [
            "want to receive this post in your inbox every day? sign up "
            "for the terms of trade newsletter."
        ],
    )
    assert _has_publisher_interface_noise(
        "bloomberg",
        [
            "sign up to receive the green daily newsletter in your "
            "inbox every weekday."
        ],
    )
    assert _has_publisher_interface_noise(
        "bloomberg",
        [
            "for even more: subscribe to bloomberg all access for full "
            "global news coverage."
        ],
    )
    assert _has_publisher_interface_noise(
        "bloomberg",
        [
            "sign up to receive the brexit bulletin, a daily briefing "
            "on britain's departure from the eu."
        ],
    )
    assert not _has_publisher_interface_noise(
        "bloomberg",
        ["investors subscribe to several market-data services."],
    )


def test_publisher_interface_noise_detects_nyt_newsletter_embed():
    assert _has_publisher_interface_noise(
        "nyt",
        [
            "sign up for weekly updates on residential real estate news "
            "from the times."
        ],
    )
    assert not _has_publisher_interface_noise(
        "nyt",
        ["the article describes weekly updates on housing data."],
    )


def test_publisher_interface_noise_detects_reuters_legal_suffixes():
    assert _has_publisher_interface_noise(
        "reuters",
        [
            "article reporting",
            "(c) reuters 2010. all rights reserved. republication or "
            "redistribution ofreuters content is prohibited.",
        ],
    )
    assert _has_publisher_interface_noise(
        "reuters",
        ["copyright 2013, marketwire, all rights reserved."],
    )
    assert not _has_publisher_interface_noise(
        "reuters",
        ["the court reserved all rights while considering the appeal."],
    )
    long_press_release = "substantive reporting. " * 100
    assert not _has_publisher_interface_noise(
        "reuters",
        [
            long_press_release
            + "copyright protection exists. all rights reserved."
        ],
    )


def test_publisher_interface_noise_detects_ft_newsletter_promos():
    assert _has_publisher_interface_noise(
        "ft",
        [
            "how is coronavirus taking its toll on markets? stay "
            "briefed with our coronavirus newsletter"
        ],
    )
    assert _has_publisher_interface_noise(
        "ft",
        [
            "sign up to scoreboard, our new must-read weekly briefing "
            "on the business of sport."
        ],
    )
    assert not _has_publisher_interface_noise(
        "ft",
        ["the article analysed the business of sport."],
    )


def _capture_candidate(year: int, suffix: int) -> CaptureCandidate:
    return CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url=(
            f"https://web.archive.org/web/{year}01010000{suffix:02d}id_/"
            f"https://apnews.com/article/{year}-{suffix}"
        ),
        captured_at=datetime(year, 1, 1, tzinfo=timezone.utc),
        mime_type="text/html",
        status_code=200,
    )


def _state_with_years(
    tmp_path: Path,
    *,
    publisher: str = "ap",
) -> sqlite3.Connection:
    manifest = tmp_path / "manifest.jsonl"
    rows = []
    for year in (2020, 2021, 2022):
        for suffix in range(10):
            if publisher == "ap":
                canonical_url = (
                    f"https://apnews.com/article/{year}-{suffix}"
                )
            elif publisher == "bloomberg":
                canonical_url = (
                    "https://www.bloomberg.com/news/articles/"
                    f"{year}-01-{suffix + 1:02d}/sample-{suffix}"
                )
            elif publisher == "wsj":
                timestamp = int(
                    datetime(
                        year,
                        1,
                        1,
                        tzinfo=timezone.utc,
                    ).timestamp()
                )
                canonical_url = (
                    "https://www.wsj.com/articles/"
                    f"sample-{suffix}-{timestamp + suffix}"
                )
            elif publisher == "npr":
                canonical_url = (
                    f"https://www.npr.org/{year}/01/01/"
                    f"{year}{suffix:02d}/sample-{suffix}"
                )
            elif publisher == "caixin":
                canonical_url = (
                    f"https://www.caixin.com/{year}-01-01/"
                    f"sample-{suffix}.html"
                )
            else:
                raise AssertionError(f"unsupported fixture: {publisher}")
            candidate = CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=(
                    f"https://web.archive.org/web/"
                    f"{year}01010000{suffix:02d}id_/{canonical_url}"
                ),
                captured_at=datetime(year, 1, 1, tzinfo=timezone.utc),
                mime_type="text/html",
                status_code=200,
            )
            rows.append(
                {
                    "publisher": publisher,
                    "canonical_url": canonical_url,
                    "published_at": f"{year}-01-01T00:00:00Z",
                    "candidates": [
                        candidate.model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                    ],
                }
            )
    manifest.write_text(
        "".join(json.dumps(row, default=str) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher=publisher,
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher=publisher,
    )
    return connection


def test_validation_target_requires_qa_passes_and_keeps_replacement_pending(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )
    first_url, second_url = [
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            ORDER BY sample_priority
            """
        ).fetchall()
    ]
    parser_version = str(
        connection.execute(
            "SELECT parser_version FROM parser_validation_config "
            "WHERE sample_year=2020"
        ).fetchone()[0]
    )
    qa_revision = int(
        connection.execute(
            "SELECT qa_revision FROM parser_validation_config "
            "WHERE sample_year=2020"
        ).fetchone()[0]
    )
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url, publisher, sample_year, parser_version,
            qa_revision,
            extraction_status, qa_pass, body_characters, block_count,
            images_referenced, images_selected, duplicate_text_blocks,
            headline_present, published_at_present, source_link_preserved,
            warnings_json, issues_json, error, parsed_at, content_type,
            source_raw_sha256, source_capture_sha256
        ) VALUES (?, 'ap', 2020, ?, ?, 'partial', 0,
                  100, 1, 0, 0, 0, 1, 1, 1, '[]',
                  '["extraction-partial"]', NULL, '2026-01-01T00:00:00+00:00',
                  'article', ?, ?)
        """,
        (first_url, parser_version, qa_revision, "a" * 64, "b" * 64),
    )
    connection.commit()

    assert not parser_validation_target_reached(connection)
    assert pending_parser_validation_urls(
        connection,
        maximum=10,
        maximum_record_attempts=3,
    ) == [second_url]

    replacement = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )
    assert replacement["years"]["2020"]["qaPassed"] == 0
    assert replacement["years"]["2020"]["addedToPlan"] == 1


def test_holdout_plan_excludes_every_prior_cohort_url(tmp_path: Path):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=4,
        reserve_per_year=0,
        maximum_record_attempts=3,
        seed="first-cohort",
    )
    first_urls = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }
    connection.execute("DELETE FROM parser_validation_samples")
    connection.execute("DELETE FROM parser_validation_config")
    connection.executemany(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        )
        VALUES (?, 'validation-v1', '2026-07-28T00:00:00Z')
        """,
        ((url,) for url in first_urls),
    )
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=4,
        reserve_per_year=0,
        maximum_record_attempts=3,
        seed="holdout-v1",
    )
    holdout_urls = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }
    assert len(holdout_urls) == 4
    assert first_urls.isdisjoint(holdout_urls)


def test_holdout_plan_excludes_normalized_legacy_url_variants(tmp_path: Path):
    connection = _state_with_years(tmp_path, publisher="npr")
    initialize_parser_validation_schema(connection)
    canonical = str(
        connection.execute(
            "SELECT canonical_url FROM captures "
            "WHERE published_at >= '2020-01-01' "
            "ORDER BY canonical_url LIMIT 1"
        ).fetchone()[0]
    )
    path = canonical.removeprefix("https://www.npr.org")
    legacy_variant = f"http://npr.org{path}/?output=1"
    connection.execute(
        "UPDATE captures SET canonical_url=? WHERE canonical_url=?",
        (legacy_variant, canonical),
    )
    connection.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES (?, 'validation-v2', '2026-08-12T00:00:00Z')
        """,
        (canonical,),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="npr",
        from_year=2020,
        to_year=2020,
        target_per_year=9,
        reserve_per_year=0,
        maximum_record_attempts=3,
        seed="holdout-v1",
    )

    selected = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }
    assert legacy_variant not in selected
    assert len(selected) == 9


def test_axios_plan_deduplicates_trailing_hyphen_aliases(tmp_path: Path):
    manifest = tmp_path / "axios-manifest.jsonl"
    base = "https://www.axios.com/2019/01/11/example-story"
    rows = []
    for index, url in enumerate((base, base + "-", base + "--")):
        rows.append(
            {
                "publisher": "axios",
                "canonicalUrl": url,
                "publishedAt": "2019-01-11T12:00:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": (
                            "https://web.archive.org/web/"
                            f"2019011200000{index}id_/" + url
                        ),
                    }
                ],
            }
        )
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="axios",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="axios",
    )

    plan = ensure_parser_validation_plan(
        connection,
        publisher="axios",
        from_year=2019,
        to_year=2019,
        target_per_year=3,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = connection.execute(
        "SELECT canonical_url FROM parser_validation_samples"
    ).fetchall()
    # Manifest ingestion now collapses malformed aliases before planning, so
    # both the available pool and selected cohort count one article identity.
    assert plan["years"]["2019"]["available"] == 1
    assert len(selected) == 1


def test_axios_plan_skips_malformed_aliases_already_in_legacy_state():
    canonical = "https://www.axios.com/2025/01/20/example-story"
    malformed = canonical + "%5C"
    replacement = "https://www.axios.com/2025/01/20/replacement-story"
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="axios",
        authorization_reference="authorization:test",
    )
    for index, url in enumerate((canonical, malformed, replacement)):
        connection.execute(
            """
            INSERT INTO captures(
                canonical_url, article_id, publisher, published_at,
                candidates_json, updated_at
            ) VALUES (?, ?, 'axios', '2025-01-20T12:00:00Z', '[]', 'now')
            """,
            (url, f"axios:legacy:{index}"),
        )
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2025, 2, 'old', 'axios-parser/0.1.17', 3, 'now')
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2025, ?, 'now')
        """,
        [(canonical, "1"), (malformed, "2")],
    )

    ensure_parser_validation_plan(
        connection,
        publisher="axios",
        from_year=2025,
        to_year=2025,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }
    assert malformed not in selected
    assert selected == {canonical, replacement}


def test_wsj_plan_skips_encoded_whitespace_aliases_in_legacy_state():
    canonical = (
        "https://www.wsj.com/news/articles/"
        "SB10001424052702303281504579217850250721172"
    )
    malformed = canonical + "%20"
    replacement = (
        "https://www.wsj.com/news/articles/"
        "SB10001424052702303281504579219432023902124"
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    for index, url in enumerate((canonical, malformed, replacement)):
        connection.execute(
            """
            INSERT INTO captures(
                canonical_url, article_id, publisher, published_at,
                candidates_json, updated_at
            ) VALUES (?, ?, 'wsj', '2013-11-25T12:00:00Z', '[]', 'now')
            """,
            (url, f"wsj:legacy:{index}"),
        )
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2013, 2, 'old', 'wsj-parser/0.8.67', 5, 'now')
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2013, ?, 'now')
        """,
        [(canonical, "1"), (malformed, "2")],
    )

    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2013,
        to_year=2013,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }
    assert malformed not in selected
    assert selected == {canonical, replacement}


def test_wsj_embedded_article_id_rotates_slug_and_sb_alias_duplicate(
    tmp_path: Path,
):
    slug_url = (
        "https://www.wsj.com/articles/"
        "the-invasion-of-the-online-tutors-1384301976"
    )
    sb_url = (
        "https://www.wsj.com/news/articles/"
        "SB10001424052702303763804579186043194947628"
    )
    stable_id = "SB10001424052702303763804579186043194947628"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2013, 2, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2013, ?, 'now')
        """,
        [(slug_url, "1"), (sb_url, "2")],
    )
    reporting = " ".join(
        [
            "Tutoring companies connected students with instructors online "
            "while schools and families evaluated the service."
        ]
        * 8
    )
    html_by_url = {
        slug_url: f"""
          <html><head><meta property="og:title" content="Online Tutors">
          <meta property="article:published_time" content="2013-11-12T12:00:00Z">
          <script type="application/ld+json">
          {{"articleId":"{stable_id}","headline":"Online Tutors",
          "datePublished":"2013-11-12T12:00:00Z"}}
          </script></head><body><div id="wsj-article-wrap"
          itemprop="articleBody"><p>{reporting}</p></div></body></html>
        """.encode(),
        sb_url: f"""
          <html><head><meta property="og:title" content="Online Tutors">
          <meta property="article:published_time" content="2013-11-12T12:00:00Z">
          </head><body><div id="wsj-article-wrap" itemprop="articleBody"
          data-articleid="{stable_id}"><p>{reporting}</p></div></body></html>
        """.encode(),
    }
    results = []
    for index, canonical_url in enumerate((slug_url, sb_url)):
        capture = RawCapture(
            article_id="wsj:" + str(index) * 64,
            publisher="wsj",
            canonical_url=canonical_url,
            published_at=datetime(2013, 11, 12, tzinfo=timezone.utc),
            selected_candidate=CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=(
                    "https://web.archive.org/web/20131113000000id_/"
                    + canonical_url
                ),
            ),
            retrieved_at=datetime.now(timezone.utc),
            final_url=canonical_url,
            http_status=200,
            content_type="text/html",
            quality_score=100,
            raw_html=store_raw_html(tmp_path, html_by_url[canonical_url]),
        )
        results.append(
            record_parser_validation(
                connection,
                capture=capture,
                archive_root=tmp_path,
            )
        )

    assert results[0]["qaPass"] is True, results[0]
    assert results[1]["issues"] == ["nonarticle-desk"]
    assert connection.execute(
        "SELECT COUNT(DISTINCT article_identity) "
        "FROM parser_validation_results WHERE article_identity IS NOT NULL"
    ).fetchone()[0] == 1
    summary = parser_validation_summary(connection)
    assert summary["years"]["2013"]["evaluated"] == 1
    assert summary["years"]["2013"]["screenedNonArticles"] == 1


def test_scmp_article_identity_uses_numeric_id_across_slug_aliases():
    urls = (
        "https://www.scmp.com/news/hong-kong/article/1107758/"
        "cy-leung-rejects-city-developers-plea-property-tax-exemption",
        "https://www.scmp.com/news/hong-kong/article/1107758/"
        "leung-snubs-city-developers-plea-tax-exemption",
    )

    identities = {
        _validation_article_identity(
            "scmp",
            b"",
            url,
            "Substantive reporting that differs slightly between captures. "
            * 8,
        )
        for url in urls
    }

    assert identities == {"scmp:article:1107758"}


def test_ft_exact_article_duplicate_rotates_second_canonical_url(
    tmp_path: Path,
):
    urls = (
        "https://www.ft.com/content/38e84758-5566-11e6-9664-e0bdc13c3bef",
        "https://www.ft.com/content/c138e26c-4fd9-11e6-88c5-db83e98a590a",
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 2, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, ?, 'now')
        """,
        [(urls[0], "1"), (urls[1], "2")],
    )
    reporting = " ".join(
        [
            "The Financial Times report examines the campaign speech and "
            "the political strategy behind its language."
        ]
        * 12
    )
    results = []
    for index, canonical_url in enumerate(urls):
        html = f"""
          <html><head>
            <link rel="canonical" href="{canonical_url}">
            <meta property="og:title"
                  content="Donald Trump's Convention speech dissected">
            <meta property="article:published_time"
                  content="2016-07-22T08:21:30Z">
          </head><body><div class="article-body">
            <p>{reporting}</p>
          </div></body></html>
        """.encode()
        capture = RawCapture(
            article_id="ft:" + str(index) * 64,
            publisher="ft",
            canonical_url=canonical_url,
            published_at=datetime(2016, 7, 22, tzinfo=timezone.utc),
            selected_candidate=CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=(
                    "https://web.archive.org/web/20160723000000id_/"
                    + canonical_url
                ),
            ),
            retrieved_at=datetime.now(timezone.utc),
            final_url=canonical_url,
            http_status=200,
            content_type="text/html",
            quality_score=100,
            raw_html=store_raw_html(tmp_path, html),
        )
        results.append(
            record_parser_validation(
                connection,
                capture=capture,
                archive_root=tmp_path,
            )
        )

    assert results[0]["qaPass"] is True, results[0]
    assert results[1]["issues"] == ["nonarticle-desk"]
    summary = parser_validation_summary(connection)
    assert summary["years"]["2016"]["evaluated"] == 1
    assert summary["years"]["2016"]["screenedNonArticles"] == 1


def test_ft_wrong_parsed_publication_year_does_not_pass_qa(tmp_path: Path):
    canonical_url = (
        "https://www.ft.com/content/00bd522e-2a38-41e0-b906-00144feab49a"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
      <html><head>
        <meta property="og:title" content="The Walkmen in London">
        <meta property="article:published_time"
              content="2011-01-27T22:50:28Z">
      </head><body><div class="article-body">
        <p>The review describes the performance, arrangements and audience
        response in substantial editorial detail for readers of the paper.</p>
        <p>The critic then assesses the encore and the venue acoustics before
        reaching a measured conclusion about the concert.</p>
      </div></body></html>
    """
    capture = RawCapture(
        article_id="ft:" + "y" * 64,
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2019, 9, 17, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20190917191525id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["publication-year-mismatch"]
    assert summary["years"]["2019"]["evaluated"] == 0
    assert summary["years"]["2019"]["qaPassed"] == 0
    assert summary["years"]["2019"]["screenedNonArticles"] == 1


def test_ap_year_boundary_uses_capture_timezone_for_qa(tmp_path: Path):
    canonical_url = (
        "https://apnews.com/sports/san-antonio-spurs-boston-celtics-"
        "10bbf60fef7e320cf0be8e184da5b987"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2023, 1, 'test', 'ap-parser/0.6.27', 1, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2023, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
      <html><head>
        <meta property="og:title" content="NBA-leading Celtics beat Spurs">
        <meta property="article:published_time"
              content="2024-01-01T02:25:16Z">
      </head><body><main><article><div data-key="article">
        <p>SAN ANTONIO (AP) - The report describes the complete game,
        including the leading scorers and the decisive fourth quarter.</p>
        <p>The account also explains the standings and what both teams face
        in their next scheduled games after the holiday matchup.</p>
      </div></article></main></body></html>
    """
    capture = RawCapture(
        article_id="ap:" + "z" * 64,
        publisher="ap",
        canonical_url=canonical_url,
        published_at=datetime(
            2023,
            12,
            31,
            22,
            37,
            tzinfo=timezone(timedelta(hours=-5)),
        ),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.LIVE_ORIGIN,
            snapshot_url=canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )

    assert result["qaPass"] is True, result
    assert result["issues"] == []


def test_npr_plan_deduplicates_story_id_across_date_and_tracking_aliases(
    tmp_path: Path,
):
    manifest = tmp_path / "npr-manifest.jsonl"
    urls = (
        "https://www.npr.org/2010/11/16/131356105/original-slug",
        "https://www.npr.org/2010/12/02/131356105/updated-slug",
        "https://www.npr.org/2010/11/16/131356105/original-slug&sc=fb&cc=fp",
    )
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "npr",
                    "canonicalUrl": url,
                    "publishedAt": "2010-11-16T12:00:00Z",
                    "candidates": [
                        {
                            "provider": "wayback",
                            "snapshotUrl": (
                                "https://web.archive.org/web/20101117000000id_/"
                                + url
                            ),
                        }
                    ],
                }
            )
            + "\n"
            for url in urls
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(connection, manifest_path=manifest, publisher="npr")

    ensure_parser_validation_plan(
        connection,
        publisher="npr",
        from_year=2010,
        to_year=2010,
        target_per_year=3,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_samples"
    ).fetchone()[0] == 1
    assert connection.execute(
        "SELECT canonical_url FROM parser_validation_samples"
    ).fetchall() == [(urls[0],)]


def test_plan_prunes_reuters_non_article_endpoints(tmp_path: Path):
    manifest = tmp_path / "reuters-manifest.jsonl"
    invalid_url = (
        "https://www.reuters.com/article/comments/idUS12320140101"
    )
    malformed_url = (
        "https://www.reuters.com/article/idUSN0927394120090709%7C"
    )
    wrong_year_url = (
        "https://www.reuters.com/article/idUSTRES57D23Q20090816"
    )
    valid_url = "https://www.reuters.com/article/idUS12320140101"
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "reuters",
                    "canonical_url": url,
                    "published_at": "2014-01-01T00:00:00Z",
                    "candidates": [],
                }
            )
            + "\n"
            for url in (invalid_url, valid_url)
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="reuters",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="reuters",
    )
    initialize_parser_validation_schema(connection)
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2014, '0000', '2026-07-28T00:00:00Z')
        """,
        (
            (invalid_url,),
            (malformed_url,),
            (wrong_year_url,),
            (valid_url,),
        ),
    )
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url, publisher, sample_year, parser_version,
            extraction_status, content_type, qa_pass, warnings_json,
            issues_json, parsed_at
        ) VALUES (
            ?, 'reuters', 2014, 'reuters-parser/0.7.0',
            'unsupported', 'article', 0, '[]', '[]',
            '2026-07-28T00:00:00Z'
        )
        """,
        (invalid_url,),
    )

    ensure_parser_validation_plan(
        connection,
        publisher="reuters",
        from_year=2014,
        to_year=2014,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    assert connection.execute(
        """
        SELECT canonical_url FROM parser_validation_samples
        """
    ).fetchall() == [(valid_url,)]
    assert connection.execute(
        """
        SELECT COUNT(*) FROM parser_validation_results
        WHERE canonical_url=?
        """,
        (invalid_url,),
    ).fetchone()[0] == 0


def test_nikkei_plan_prunes_capture_year_misclassified_article_ids():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="nikkei",
        authorization_reference="authorization:test",
    )
    initialize_parser_validation_schema(connection)
    misplaced_url = (
        "https://www.nikkei.com/article/"
        "DGKDZO27658310Z20C11A4ML0000"
    )
    correct_url = (
        "https://www.nikkei.com/article/"
        "DGKKZO84200000Z20C15A4MM8000"
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2015, '0000', '2026-08-11T00:00:00Z')
        """,
        ((misplaced_url,), (correct_url,)),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="nikkei",
        from_year=2015,
        to_year=2015,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    assert connection.execute(
        "SELECT canonical_url FROM parser_validation_samples"
    ).fetchall() == [(correct_url,)]


def test_ft_plan_prunes_capture_year_misclassified_uuid1_articles():
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    initialize_parser_validation_schema(connection)
    misplaced_url = (
        "https://www.ft.com/content/0037ad8e-547f-11e4-b2ea-00144feab7de"
    )
    adjacent_draft_url = (
        "https://www.ft.com/content/00000000-0000-11e7-8000-000000000000"
    )
    correct_url = (
        "https://www.ft.com/content/016f4238-ad19-11e8-89a1-e5de165fa619"
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2018, '0000', '2026-08-30T00:00:00Z')
        """,
        ((misplaced_url,), (adjacent_draft_url,), (correct_url,)),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="ft",
        from_year=2018,
        to_year=2018,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    assert {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    } == {adjacent_draft_url, correct_url}


def test_ft_infini_samples_are_added_even_when_random_plan_is_full(
    tmp_path: Path,
):
    manifest = tmp_path / "ft-manifest.jsonl"
    rows = []
    for suffix in range(8):
        canonical_url = (
            "https://www.ft.com/content/"
            f"00000000-0000-0000-0000-{suffix:012d}"
        )
        candidates = [
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=(
                    "https://web.archive.org/web/20240328000000id_/"
                    + canonical_url
                ),
            )
        ]
        rows.append(
            {
                "publisher": "ft",
                "canonicalUrl": canonical_url,
                "publishedAt": "2024-03-28T00:00:00Z",
                "candidates": [
                    item.model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
                    for item in candidates
                ],
            }
        )
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="ft",
        from_year=2024,
        to_year=2024,
        target_per_year=4,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    initial_count = connection.execute(
        "SELECT COUNT(*) FROM parser_validation_samples"
    ).fetchone()[0]
    unsampled = connection.execute(
        """
        SELECT capture.canonical_url, capture.candidates_json
        FROM captures AS capture
        LEFT JOIN parser_validation_samples AS sample
          ON sample.canonical_url=capture.canonical_url
        WHERE sample.canonical_url IS NULL
        ORDER BY capture.canonical_url
        LIMIT 2
        """
    ).fetchall()
    for index, (canonical_url, candidates_json) in enumerate(unsampled):
        candidates = json.loads(candidates_json)
        candidates.insert(
            0,
            CaptureCandidate(
                provider=CaptureProvider.INFINI_NEWS,
                snapshot_url=(
                    "https://datasets-server.huggingface.co/rows?"
                    "dataset=ruggsea%2Finfini-news-corpus&"
                    "config=year_2024&split=train&"
                    f"offset={index}&length=1"
                ),
                source_url=canonical_url,
                expected_headline=(
                    f"A complete Financial Times article {index}"
                ),
                warc_filename=(
                    "CC-NEWS-20240328120000-00001.warc.gz"
                ),
            ).model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            ),
        )
        connection.execute(
            """
            UPDATE captures
            SET candidates_json=?
            WHERE canonical_url=?
            """,
            (
                json.dumps(candidates, separators=(",", ":")),
                canonical_url,
            ),
        )
    connection.commit()
    plan = ensure_parser_validation_plan(
        connection,
        publisher="ft",
        from_year=2024,
        to_year=2024,
        target_per_year=4,
        reserve_per_year=2,
        maximum_record_attempts=3,
    )
    direct_count = connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples AS sample
        JOIN captures AS capture
          ON capture.canonical_url=sample.canonical_url
        WHERE capture.candidates_json LIKE '%"provider":"infini-news"%'
        """
    ).fetchone()[0]
    pending = pending_parser_validation_urls(
        connection,
        maximum=2,
        maximum_record_attempts=3,
    )

    assert initial_count == 4
    assert plan["years"]["2024"]["addedDirectToPlan"] == 2
    assert direct_count == 2
    assert all(
        "infini-news"
        in connection.execute(
            "SELECT candidates_json FROM captures WHERE canonical_url=?",
            (url,),
        ).fetchone()[0]
        for url in pending
    )


def test_validation_plan_is_random_reproducible_and_balanced(tmp_path: Path):
    first = _state_with_years(tmp_path)
    plan = ensure_parser_validation_plan(
        first,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        first,
        retry_errors=False,
        maximum=6,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )
    selected_urls = [item.canonical_url for item in selected]

    second = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        second,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    repeated_urls = [
        item.canonical_url
        for item in pending_captures(
            second,
            retry_errors=False,
            maximum=6,
            maximum_record_attempts=3,
            prioritize_parser_validation=True,
        )
    ]

    assert plan["targetPerYear"] == 2
    assert selected_urls == repeated_urls
    assert len(selected_urls) == 6
    assert [item.published_at[:4] for item in selected] == [
        "2020",
        "2021",
        "2022",
        "2020",
        "2021",
        "2022",
    ]
    assert selected_urls != [
        f"https://apnews.com/article/{year}-{suffix}"
        for suffix in range(2)
        for year in (2020, 2021, 2022)
    ]


def test_validation_plan_counts_concurrently_leased_samples_as_actionable(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=2,
        maximum_record_attempts=3,
    )
    initial_samples = connection.execute(
        "SELECT COUNT(*) FROM parser_validation_samples WHERE sample_year=2020"
    ).fetchone()[0]
    connection.execute(
        """
        UPDATE captures
        SET status='downloading', attempts=attempts+1
        WHERE canonical_url IN (
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
        )
        """
    )
    connection.commit()

    plan = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=2,
        maximum_record_attempts=3,
    )

    assert initial_samples == 4
    assert plan["years"]["2020"]["actionableBeforePlanning"] == 4
    assert plan["years"]["2020"]["addedToPlan"] == 0
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_samples WHERE sample_year=2020"
    ).fetchone()[0] == initial_samples


def test_pending_validation_can_focus_on_one_year(tmp_path: Path):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=2,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
        validation_from_year=2021,
        validation_to_year=2021,
    )

    assert len(selected) == 2
    assert {item.published_at[:4] for item in selected} == {"2021"}


def test_validation_only_does_not_fill_batch_from_excluded_old_cohort(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="wsj")
    initialize_parser_validation_schema(connection)
    old_cohort_url = connection.execute(
        """
        SELECT canonical_url
        FROM captures
        WHERE published_at >= '2020-01-01'
          AND published_at < '2021-01-01'
        ORDER BY canonical_url
        LIMIT 1
        """
    ).fetchone()[0]
    connection.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES (?, 'validation-v2', '2026-08-10T00:00:00Z')
        """,
        (old_cohort_url,),
    )
    connection.commit()
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = pending_captures(
        connection,
        retry_errors=True,
        maximum=20,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
        parser_validation_only=True,
        validation_from_year=2020,
        validation_to_year=2020,
    )

    assert len(selected) == 1
    assert selected[0].canonical_url != old_cohort_url
    assert connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples
        WHERE canonical_url=?
        """,
        (selected[0].canonical_url,),
    ).fetchone()[0] == 1
    summary = parser_validation_summary(connection)
    assert summary["years"]["2020"]["eligibleCandidates"] == 9
    assert summary["years"]["2020"]["excludedCandidates"] == 1


def test_validation_capacity_deduplicates_exclusion_url_aliases(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES (?, 'validation-v2', '2026-08-10T00:00:00Z')
        """,
        ("http://www.apnews.com/article/2020-0/?utm_source=archive",),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    summary = parser_validation_summary(connection)
    assert summary["years"]["2020"]["eligibleCandidates"] == 9
    assert summary["years"]["2020"]["excludedCandidates"] == 1


def test_validation_capacity_excludes_terminal_capture_errors(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    terminal_url = "https://apnews.com/article/2020-0"
    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=3, last_error='reject-parser-unusable'
        WHERE canonical_url=?
        """,
        (terminal_url,),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    summary = parser_validation_summary(connection)
    assert summary["years"]["2020"]["eligibleCandidates"] == 9


def test_validation_capacity_ignores_nonarticle_desk_rows(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="caixin")
    manifest = tmp_path / "caixin-desks.jsonl"
    rows = [
        {
            "publisher": "caixin",
            "canonical_url": (
                "https://photos.caixin.com/2020-01-01/"
                "photo-only.html"
            ),
            "published_at": "2020-01-01T00:00:00Z",
            "candidates": [],
        },
        {
            "publisher": "caixin",
            "canonical_url": (
                "https://video.caixin.com/2020-01-01/"
                "video-only.html"
            ),
            "published_at": "2020-01-01T00:00:00Z",
            "candidates": [],
        },
    ]
    # The helper already loaded ten text-article rows for 2020; append two
    # non-text desks with a valid archive candidate so they are visible to
    # capacity accounting but remain ineligible for the article cohort.
    candidate = CaptureCandidate(
        provider=CaptureProvider.WAYBACK,
        snapshot_url="https://web.archive.org/web/20200101000000id_/"
        "https://photos.caixin.com/2020-01-01/photo-only.html",
        captured_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
        mime_type="text/html",
        status_code=200,
    )
    rows[0]["candidates"] = [
        candidate.model_dump(mode="json", by_alias=True, exclude_none=True)
    ]
    rows[1]["candidates"] = [
        candidate.model_copy(
            update={
                "snapshot_url": candidate.snapshot_url.replace(
                    "photos.caixin.com", "video.caixin.com"
                )
            }
        ).model_dump(mode="json", by_alias=True, exclude_none=True)
    ]
    manifest.write_text(
        "".join(json.dumps(row, default=str) + "\n" for row in rows),
        encoding="utf-8",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="caixin",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="caixin",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    summary = parser_validation_summary(connection)
    assert summary["years"]["2020"]["eligibleCandidates"] == 10
    assert summary["years"]["2020"]["planned"] == 2


def test_validation_only_requires_validation_prioritization(tmp_path: Path):
    connection = _state_with_years(tmp_path)

    with pytest.raises(
        ValueError,
        match="parser_validation_only requires prioritize_parser_validation",
    ):
        pending_captures(
            connection,
            retry_errors=False,
            maximum=1,
            maximum_record_attempts=3,
            parser_validation_only=True,
        )


def test_bloomberg_plan_randomly_prefers_exact_wayback_captures(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="bloomberg")
    exact_urls: set[str] = set()
    for year in (2020, 2021, 2022):
        rows = connection.execute(
            """
            SELECT canonical_url, candidates_json
            FROM captures
            WHERE published_at >= ? AND published_at < ?
            ORDER BY canonical_url
            LIMIT 3
            """,
            (f"{year}-01-01", f"{year + 1}-01-01"),
        ).fetchall()
        for canonical_url, candidates_json in rows:
            candidates = json.loads(candidates_json)
            candidates.insert(
                0,
                CaptureCandidate(
                    provider=CaptureProvider.WAYBACK,
                    snapshot_url=(
                        f"https://web.archive.org/web/{year}0201000000id_/"
                        f"{canonical_url}"
                    ),
                    captured_at=datetime(
                        year,
                        2,
                        1,
                        tzinfo=timezone.utc,
                    ),
                    digest=f"exact-{year}-{len(exact_urls)}",
                    mime_type="text/html",
                    status_code=200,
                ).model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_none=True,
                ),
            )
            connection.execute(
                """
                UPDATE captures
                SET candidates_json=?
                WHERE canonical_url=?
                """,
                (
                    json.dumps(candidates, separators=(",", ":")),
                    canonical_url,
                ),
            )
            exact_urls.add(canonical_url)
    connection.commit()

    plan = ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=6,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )

    assert all(item.canonical_url in exact_urls for item in selected)
    assert all(
        plan["years"][str(year)]["addedExactWaybackToPlan"] == 2
        for year in (2020, 2021, 2022)
    )


def test_parser_version_change_excludes_only_evaluated_samples(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="bloomberg")
    ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )
    original = {
        str(row[0])
        for row in connection.execute(
        """
        SELECT canonical_url
        FROM parser_validation_samples
        WHERE sample_year=2020
        """
        )
    }
    evaluated = sorted(original)[0]
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url,
            publisher,
            sample_year,
            parser_version,
            extraction_status,
            qa_pass,
            warnings_json,
            issues_json,
            parsed_at
        )
        VALUES (?, 'bloomberg', 2020, 'bloomberg-parser/old',
                'complete', 1, '[]', '[]', ?)
        """,
        (evaluated, datetime.now(timezone.utc).isoformat()),
    )
    connection.execute(
        """
        UPDATE parser_validation_config
        SET parser_version='bloomberg-parser/old'
        WHERE sample_year=2020
        """
    )
    connection.commit()

    refreshed = ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )
    replacement = {
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            """
        )
    }

    assert refreshed["years"]["2020"]["refreshedForParserVersion"] == 1
    assert evaluated not in replacement
    assert (original - {evaluated}) <= replacement
    assert connection.execute(
        """
        SELECT source_cohort
        FROM parser_validation_exclusions
        WHERE canonical_url=?
        """,
        (evaluated,),
    ).fetchone() == ("bloomberg:2020:bloomberg-parser/old",)
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_exclusions"
    ).fetchone() == (1,)


def test_validation_plan_prunes_legacy_reserve_only_exclusions(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="bloomberg")
    ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )
    selected = sorted(
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    )
    evaluated, reserve_only = selected
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url,
            publisher,
            sample_year,
            parser_version,
            extraction_status,
            qa_pass,
            warnings_json,
            issues_json,
            parsed_at
        )
        VALUES (?, 'bloomberg', 2020, 'bloomberg-parser/old',
                'complete', 1, '[]', '[]', ?)
        """,
        (evaluated, datetime.now(timezone.utc).isoformat()),
    )
    connection.executemany(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES (?, 'bloomberg:2020:bloomberg-parser/old', ?)
        """,
        (
            (url, datetime.now(timezone.utc).isoformat())
            for url in selected
        ),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )

    exclusions = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_exclusions"
        )
    }
    assert exclusions == {evaluated}
    assert reserve_only not in exclusions


def test_validation_plan_preserves_external_validation_v1_exclusions(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="bloomberg")
    initialize_parser_validation_schema(connection)
    excluded = str(
        connection.execute(
            "SELECT canonical_url FROM captures ORDER BY canonical_url LIMIT 1"
        ).fetchone()[0]
    )
    connection.execute(
        """
        INSERT INTO parser_validation_exclusions(
            canonical_url, source_cohort, excluded_at
        ) VALUES (?, 'validation-v1', ?)
        """,
        (excluded, datetime.now(timezone.utc).isoformat()),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="bloomberg",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=1,
        maximum_record_attempts=3,
    )

    assert connection.execute(
        """
        SELECT source_cohort
        FROM parser_validation_exclusions
        WHERE canonical_url=?
        """,
        (excluded,),
    ).fetchone() == ("validation-v1",)
    assert connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples
        WHERE canonical_url=?
        """,
        (excluded,),
    ).fetchone() == (0,)


def test_qa_revision_change_replays_without_replacing_cohort(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="wsj")
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    original = {
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            """
        )
    }
    previously_evaluated = sorted(original)[0]
    connection.execute(
        """
        UPDATE parser_validation_config
        SET qa_revision=0
        WHERE sample_year=2020
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url,
            publisher,
            sample_year,
            parser_version,
            qa_revision,
            extraction_status,
            qa_pass,
            warnings_json,
            issues_json,
            parsed_at
        )
        VALUES (?, 'wsj', 2020, 'wsj-parser/0.8.51', 0,
                'complete', 1, '[]', '[]', ?)
        """,
        (previously_evaluated, datetime.now(timezone.utc).isoformat()),
    )
    connection.commit()

    refreshed = ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    current = {
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            """
        )
    }
    pending = set(
        pending_parser_validation_urls(
            connection,
            maximum=None,
            maximum_record_attempts=3,
            from_year=2020,
            to_year=2020,
        )
    )

    assert refreshed["parserVersion"] == "wsj-parser/0.8.78"
    assert refreshed["qaRevision"] == 6
    assert refreshed["years"]["2020"]["evaluated"] == 0
    assert refreshed["years"]["2020"]["refreshedForParserVersion"] == 0
    assert current == original
    assert original <= pending
    assert connection.execute(
        "SELECT COUNT(*) FROM parser_validation_exclusions"
    ).fetchone() == (0,)


def test_validation_plan_expands_reserve_without_replacing_samples(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    original = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }

    expanded = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=2,
        reserve_per_year=3,
        maximum_record_attempts=3,
    )
    expanded_urls = {
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    }

    assert original < expanded_urls
    assert len(original) == 6
    assert len(expanded_urls) == 15
    assert expanded["reservePerYear"] == 3
    assert all(
        year["addedToPlan"] == 3
        for year in expanded["years"].values()
    )


def test_validation_plan_tries_fresh_samples_before_retrying_errors(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    samples = [
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            ORDER BY canonical_url
            """
        ).fetchall()
    ]
    error_url, pending_url = samples
    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=1
        WHERE canonical_url=?
        """,
        (error_url,),
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN '0000'
            ELSE 'ffff'
        END
        WHERE sample_year=2020
        """,
        (error_url,),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=1,
        maximum_record_attempts=3,
    )

    assert selected == [pending_url]


def test_nikkei_validation_replays_common_crawl_before_wayback(
    tmp_path: Path,
):
    manifest = tmp_path / "nikkei-manifest.jsonl"
    wayback_url = (
        "https://www.nikkei.com/article/"
        "DGKDASDG2003E_Q2A620C1CR8000"
    )
    common_crawl_url = (
        "https://www.nikkei.com/article/"
        "DGXNASDD020EN_S2A800C1TJ2000"
    )
    rows = [
        {
            "publisher": "nikkei",
            "canonicalUrl": wayback_url,
            "publishedAt": "2012-06-20T00:00:00+09:00",
            "candidates": [
                {
                    "provider": "wayback",
                    "snapshotUrl": (
                        "https://web.archive.org/web/20120625230643id_/"
                        f"{wayback_url}"
                    ),
                    "capturedAt": "2012-06-25T23:06:43Z",
                    "digest": "WAYBACK-DIGEST",
                }
            ],
        },
        {
            "publisher": "nikkei",
            "canonicalUrl": common_crawl_url,
            "publishedAt": "2012-08-02T00:00:00+09:00",
            "candidates": [
                {
                    "provider": "commoncrawl",
                    "snapshotUrl": (
                        "https://data.commoncrawl.org/crawl-data/"
                        "CC-MAIN-2013-20/sample.warc.gz"
                    ),
                    "capturedAt": "2013-05-24T12:05:35Z",
                    "warcFilename": (
                        "crawl-data/CC-MAIN-2013-20/sample.warc.gz"
                    ),
                    "warcOffset": 100,
                    "warcLength": 200,
                }
            ],
        },
    ]
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="nikkei",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="nikkei",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="nikkei",
        from_year=2012,
        to_year=2012,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
        seed="nikkei-source-priority",
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN '0000'
            ELSE 'ffff'
        END
        """,
        (wayback_url,),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=1,
        maximum_record_attempts=3,
    )

    assert selected == [common_crawl_url]


def test_npr_validation_replays_common_crawl_before_wayback(
    tmp_path: Path,
):
    manifest = tmp_path / "npr-manifest.jsonl"
    wayback_url = "https://www.npr.org/2013/01/01/123456789/wayback"
    common_crawl_url = "https://www.npr.org/2013/01/02/123456790/common-crawl"
    rows = [
        {
            "publisher": "npr",
            "canonicalUrl": wayback_url,
            "publishedAt": "2013-01-01T00:00:00Z",
            "candidates": [
                {
                    "provider": "wayback",
                    "snapshotUrl": (
                        "https://web.archive.org/web/20130102000000id_/"
                        f"{wayback_url}"
                    ),
                    "capturedAt": "2013-01-02T00:00:00Z",
                    "digest": "NPR-WAYBACK-DIGEST",
                }
            ],
        },
        {
            "publisher": "npr",
            "canonicalUrl": common_crawl_url,
            "publishedAt": "2013-01-02T00:00:00Z",
            "candidates": [
                {
                    "provider": "commoncrawl",
                    "snapshotUrl": (
                        "https://data.commoncrawl.org/crawl-data/"
                        "CC-MAIN-2013-20/npr.warc.gz"
                    ),
                    "capturedAt": "2013-05-24T12:05:35Z",
                    "warcFilename": (
                        "crawl-data/CC-MAIN-2013-20/npr.warc.gz"
                    ),
                    "warcOffset": 100,
                    "warcLength": 200,
                }
            ],
        },
    ]
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="npr",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="npr",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="npr",
        from_year=2013,
        to_year=2013,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
        seed="npr-source-priority",
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN '0000'
            ELSE 'ffff'
        END
        """,
        (wayback_url,),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=1,
        maximum_record_attempts=3,
    )

    assert selected == [common_crawl_url]


def test_validation_plan_retries_server_placeholder_before_fresh_sample(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    samples = [
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            ORDER BY canonical_url
            """
        ).fetchall()
    ]
    error_url, pending_url = samples
    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=1,
            last_error='reject-server-placeholder-shell'
        WHERE canonical_url=?
        """,
        (error_url,),
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN 'ffff'
            ELSE '0000'
        END
        WHERE sample_year=2020
        """,
        (error_url,),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=1,
        maximum_record_attempts=3,
    )

    assert selected == [error_url]
    assert selected != [pending_url]


def test_validation_plan_retries_wsj_article_for_amp_before_fresh_sample(
    tmp_path: Path,
):
    manifest = tmp_path / "wsj-amp-retry-manifest.jsonl"
    error_url = "https://www.wsj.com/articles/archived-amp-retry-1383088130"
    pending_url = "https://www.wsj.com/articles/fresh-preview-1383088131"
    rows = []
    for url in (error_url, pending_url):
        rows.append(
            {
                "publisher": "wsj",
                "canonicalUrl": url,
                "publishedAt": "2013-10-29T23:09:00Z",
                "candidates": [
                    {
                        "provider": "wayback",
                        "snapshotUrl": (
                            "https://web.archive.org/web/20131030000000id_/"
                            + url
                        ),
                        "capturedAt": "2013-10-30T00:00:00Z",
                        "statusCode": 200,
                        "mimeType": "text/html",
                    }
                ],
            }
        )
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2013,
        to_year=2013,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    connection.execute(
        """
        UPDATE captures
        SET status='error', attempts=1,
            last_error='reject-subscription-shell,wsj-parser-unusable'
        WHERE canonical_url=?
        """,
        (error_url,),
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN 'ffff'
            ELSE '0000'
        END
        """,
        (error_url,),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=1,
        maximum_record_attempts=3,
    )

    assert selected == [error_url]
    assert selected != [pending_url]


def test_validation_plan_prioritizes_high_yield_wsj_snapshots(
    tmp_path: Path,
):
    manifest = tmp_path / "wsj-manifest.jsonl"
    urls = {
        "small": "https://www.wsj.com/articles/small-shell-1472582355",
        "full": "https://www.wsj.com/articles/full-text-1472582356",
        "tpl": "https://www.wsj.com/articles/template-shell-1472582357",
    }
    candidates = {
        "small": CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20160830191501id_/"
                f"{urls['small']}"
            ),
            captured_at=datetime(2016, 8, 30, tzinfo=timezone.utc),
            mime_type="text/html",
            status_code=200,
            byte_count=18_000,
        ),
        "full": CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20160830192758id_/"
                f"{urls['full']}?mod=rss_opinion_main"
            ),
            captured_at=datetime(2016, 8, 30, tzinfo=timezone.utc),
            mime_type="text/html",
            status_code=200,
            byte_count=36_000,
        ),
        "tpl": CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20160830193539id_/"
                f"{urls['tpl']}?tpl=centralbanking"
            ),
            captured_at=datetime(2016, 8, 30, tzinfo=timezone.utc),
            mime_type="text/html",
            status_code=200,
            byte_count=40_000,
        ),
    }
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": urls[name],
                    "publishedAt": "2016-08-30T00:00:00Z",
                    "candidates": [
                        candidates[name].model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                    ],
                },
                default=str,
            )
            + "\n"
            for name in ("small", "full", "tpl")
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2016,
        to_year=2016,
        target_per_year=3,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    connection.execute(
        """
        UPDATE parser_validation_samples
        SET sample_priority=CASE canonical_url
            WHEN ? THEN '0000'
            WHEN ? THEN '1111'
            ELSE 'ffff'
        END
        """,
        (urls["small"], urls["tpl"]),
    )
    connection.commit()

    selected = pending_parser_validation_urls(
        connection,
        maximum=3,
        maximum_record_attempts=3,
    )

    assert selected == [urls["full"], urls["small"], urls["tpl"]]


def test_validation_plan_prioritizes_indexed_wsj_full_text_sources(
    tmp_path: Path,
):
    manifest = tmp_path / "wsj-indexed-manifest.jsonl"
    urls = {
        name: f"https://www.wsj.com/articles/{name}-indexed-1483518944"
        for name in ("wayback", "other", "arquivo", "infini")
    }
    candidate_lists = {
        "wayback": [
            {
                "provider": "wayback",
                "snapshotUrl": (
                    "https://web.archive.org/web/20170105000000id_/"
                    + urls["wayback"]
                ),
                "byteCount": 500_000,
            }
        ],
        "other": [
            {
                "provider": "other",
                "snapshotUrl": "https://partner.example/wsj-story",
                "expectedHeadline": "A validated partner story",
            }
        ],
        "arquivo": [
            {
                "provider": "arquivo-pt",
                "snapshotUrl": (
                    "https://arquivo.pt/noFrame/replay/20170105000000/"
                    + urls["arquivo"]
                ),
            }
        ],
        "infini": [
            {
                "provider": "infini-news",
                "snapshotUrl": (
                    "https://datasets-server.huggingface.co/rows?"
                    "dataset=ruggsea%2Finfini-news-corpus&"
                    "config=year_2017&split=train&offset=42&length=1"
                ),
                "sourceUrl": urls["infini"],
                "expectedHeadline": "A complete indexed WSJ story",
            }
        ],
    }
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": urls[name],
                    "publishedAt": "2017-01-04T00:00:00Z",
                    "candidates": candidate_lists[name],
                }
            )
            + "\n"
            for name in ("wayback", "other", "arquivo", "infini")
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2017,
        to_year=2017,
        target_per_year=4,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = pending_parser_validation_urls(
        connection,
        maximum=4,
        maximum_record_attempts=3,
    )

    assert selected == [
        urls["infini"],
        urls["arquivo"],
        urls["other"],
        urls["wayback"],
    ]


def test_ft_direct_plan_skips_infini_access_shell_titles(tmp_path: Path):
    manifest = tmp_path / "ft-infini-shells.jsonl"
    shell_url = "https://www.ft.com/content/00000000-0000-4000-8000-000000000001"
    article_url = "https://www.ft.com/content/00000000-0000-4000-8000-000000000002"

    def infini(url: str, offset: int, headline: str) -> dict[str, object]:
        return {
            "provider": "infini-news",
            "snapshotUrl": (
                "https://datasets-server.huggingface.co/rows?"
                "dataset=ruggsea%2Finfini-news-corpus&config=year_2017&"
                f"split=train&offset={offset}&length=1"
            ),
            "sourceUrl": url,
            "expectedHeadline": headline,
            "warcFilename": "CC-NEWS-20170101000000-00001.warc.gz",
        }

    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "ft",
                    "canonical_url": url,
                    "published_at": "2017-01-01T00:00:00Z",
                    "candidates": [candidate],
                }
            )
            + "\n"
            for url, candidate in (
                (
                    shell_url,
                    infini(
                        shell_url,
                        1,
                        "All the benefits of Premium Digital, plus:",
                    ),
                ),
                (
                    article_url,
                    infini(article_url, 2, "A real FT article headline"),
                ),
            )
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="ft",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="ft",
    )

    ensure_parser_validation_plan(
        connection,
        publisher="ft",
        from_year=2017,
        to_year=2017,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    assert connection.execute(
        "SELECT canonical_url FROM parser_validation_samples"
    ).fetchone()[0] == article_url


def test_validation_plan_prioritizes_large_modern_wsj_snapshots(
    tmp_path: Path,
):
    manifest = tmp_path / "wsj-modern-manifest.jsonl"
    sizes = {
        "largest": 250_000,
        "large": 150_000,
        "tesla": 80_000,
        "medium": 75_000,
        "legacy_shell": 40_000,
        "tpl": 250_000,
    }
    urls = {
        name: f"https://www.wsj.com/articles/{name}-modern-1580000000"
        for name in sizes
    }
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": urls[name],
                    "publishedAt": "2020-08-30T00:00:00Z",
                    "candidates": [
                        CaptureCandidate(
                            provider=CaptureProvider.WAYBACK,
                            snapshot_url=(
                                "https://web.archive.org/web/"
                                f"2020083019000{index}id_/{urls[name]}"
                                + (
                                    "?tesla=y"
                                    if name == "tesla"
                                    else (
                                        "?tpl=centralbanking"
                                        if name == "tpl"
                                        else ""
                                    )
                                )
                            ),
                            captured_at=datetime(
                                2020,
                                8,
                                30,
                                tzinfo=timezone.utc,
                            ),
                            mime_type="text/html",
                            status_code=200,
                            byte_count=sizes[name],
                        ).model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                    ],
                },
                default=str,
            )
            + "\n"
            for index, name in enumerate(sizes)
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=len(sizes),
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = pending_parser_validation_urls(
        connection,
        maximum=len(sizes),
        maximum_record_attempts=3,
    )

    assert selected == [
        urls["largest"],
        urls["large"],
        urls["tesla"],
        urls["medium"],
        urls["legacy_shell"],
        urls["tpl"],
    ]


def test_validation_plan_removes_misdated_wsj_samples(
    tmp_path: Path,
):
    manifest = tmp_path / "wsj-misdated-manifest.jsonl"
    wrong_year_url = (
        "https://www.wsj.com/articles/"
        "afghans-mourn-for-bombing-victims-1416846693"
    )
    current_year_url = (
        "https://www.wsj.com/articles/"
        "accenture-looks-to-boost-ai-capabilities-through-"
        "mergers-11592818200"
    )
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": url,
                    "publishedAt": "2020-06-22T00:00:00+00:00",
                    "candidates": [
                        CaptureCandidate(
                            provider=CaptureProvider.WAYBACK,
                            snapshot_url=(
                                "https://web.archive.org/web/"
                                f"20200622120000id_/{url}"
                            ),
                            captured_at=datetime(
                                2020,
                                6,
                                22,
                                tzinfo=timezone.utc,
                            ),
                            mime_type="text/html",
                            status_code=200,
                            byte_count=40_000,
                        ).model_dump(
                            mode="json",
                            by_alias=True,
                            exclude_none=True,
                        )
                    ],
                },
                default=str,
            )
            + "\n"
            for url in (wrong_year_url, current_year_url)
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2020, '0000', '2020-01-01T00:00:00+00:00')
        """,
        (wrong_year_url,),
    )
    connection.commit()

    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = {
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            """
        )
    }

    assert wrong_year_url not in selected
    assert selected == {current_year_url}


def test_validation_plan_can_add_previously_completed_raw_captures(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    connection.execute(
        """
        UPDATE captures
        SET status='complete',
            raw_path='objects/html/aa/already-captured.html.gz',
            raw_sha256=?,
            raw_bytes=1000,
            stored_bytes=500
        WHERE published_at >= '2020-01-01'
          AND published_at < '2021-01-01'
          AND canonical_url != 'https://apnews.com/article/2020-0'
        """,
        ("a" * 64,),
    )
    connection.commit()

    plan = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    planned = connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples
        WHERE sample_year=2020
        """
    ).fetchone()[0]
    completed_planned = connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples AS sample
        JOIN captures AS capture
          ON capture.canonical_url=sample.canonical_url
        WHERE sample.sample_year=2020
          AND capture.status='complete'
          AND capture.raw_path IS NOT NULL
        """
    ).fetchone()[0]

    assert plan["years"]["2020"]["addedCompletedToPlan"] == 2
    assert plan["years"]["2020"]["addedToPlan"] == 2
    assert planned == 2
    assert completed_planned == 2


def test_nyt_parser_upgrade_refreshes_plan_and_prefers_direct_copies(
    tmp_path: Path,
):
    manifest = tmp_path / "nyt-manifest.jsonl"
    rows = []
    for suffix in range(10):
        canonical_url = (
            "https://www.nytimes.com/2026/01/01/world/"
            f"sample-{suffix}.html"
        )
        if suffix < 5:
            candidates = [
                {
                    "provider": "other",
                    "snapshotUrl": (
                        "https://example.com/licensed/"
                        f"sample-{suffix}"
                    ),
                }
            ]
        else:
            candidates = [
                {
                    "provider": "wayback",
                    "snapshotUrl": (
                        "https://web.archive.org/web/20260102000000id_/"
                        + canonical_url
                    ),
                }
            ]
        rows.append(
            {
                "publisher": "nyt",
                "canonicalUrl": canonical_url,
                "publishedAt": "2026-01-01T00:00:00Z",
                "candidates": candidates,
            }
        )
    manifest.write_text(
        "".join(json.dumps(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="nyt",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="nyt",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="nyt",
        from_year=2026,
        to_year=2026,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    connection.execute(
        """
        UPDATE parser_validation_config
        SET parser_version='nyt-parser/0.7.0'
        WHERE sample_year=2026
        """
    )
    connection.execute("DELETE FROM parser_validation_samples")
    connection.executemany(
        """
        INSERT INTO parser_validation_samples(
            canonical_url,
            sample_year,
            sample_priority,
            selected_at
        ) VALUES (?, 2026, ?, '2026-01-01T00:00:00Z')
        """,
        (
            (
                f"https://www.nytimes.com/2026/01/01/world/sample-{suffix}.html",
                f"old-{suffix}",
            )
            for suffix in (8, 9)
        ),
    )
    connection.commit()

    plan = ensure_parser_validation_plan(
        connection,
        publisher="nyt",
        from_year=2026,
        to_year=2026,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=2,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )

    year_plan = plan["years"]["2026"]
    assert year_plan["refreshedForParserVersion"] == 1
    assert year_plan["addedDirectToPlan"] == 2
    assert len(selected) == 2
    assert all(
        item.candidates[0].provider == CaptureProvider.OTHER
        for item in selected
    )


def test_wsj_parser_upgrade_refreshes_plan_and_excludes_asset_urls(
    tmp_path: Path,
):
    valid_url = (
        "https://www.wsj.com/articles/"
        "a-valid-wsj-article-12345678"
    )
    asset_url = (
        "https://www.wsj.com/articles/"
        "B3-BY423_health_PREVIEW_20181003165352.jpg"
    )
    manifest = tmp_path / "wsj-manifest.jsonl"
    manifest.write_text(
        "".join(
            json.dumps(
                {
                    "publisher": "wsj",
                    "canonicalUrl": canonical_url,
                    "publishedAt": "2023-01-01T00:00:00Z",
                    "candidates": [
                        {
                            "provider": "wayback",
                            "snapshotUrl": (
                                "https://web.archive.org/web/"
                                "20230102000000id_/"
                                + canonical_url
                            ),
                        }
                    ],
                }
            )
            + "\n"
            for canonical_url in (valid_url, asset_url)
        ),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="wsj",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="wsj",
    )
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2023,
        to_year=2023,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    connection.execute(
        """
        UPDATE parser_validation_config
        SET parser_version='wsj-parser/0.4.0'
        WHERE sample_year=2023
        """
    )
    connection.execute("DELETE FROM parser_validation_samples")
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url,
            sample_year,
            sample_priority,
            selected_at
        ) VALUES (?, 2023, 'old', '2023-01-01T00:00:00Z')
        """,
        (asset_url,),
    )
    connection.commit()

    plan = ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2023,
        to_year=2023,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = connection.execute(
        """
        SELECT canonical_url
        FROM parser_validation_samples
        WHERE sample_year=2023
        """
    ).fetchall()

    assert plan["years"]["2023"]["refreshedForParserVersion"] == 1
    assert selected == [(valid_url,)]


def test_validation_plan_adds_completed_samples_to_an_existing_pending_plan(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    first = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    assert first["years"]["2020"]["addedCompletedToPlan"] == 0
    initially_planned = {
        str(row[0])
        for row in connection.execute(
            """
            SELECT canonical_url
            FROM parser_validation_samples
            WHERE sample_year=2020
            """
        ).fetchall()
    }
    placeholders = ",".join("?" for _ in initially_planned)
    connection.execute(
        f"""
        UPDATE captures
        SET status='complete',
            raw_path='objects/html/aa/already-captured.html.gz',
            raw_sha256=?,
            raw_bytes=1000,
            stored_bytes=500
        WHERE published_at >= '2020-01-01'
          AND published_at < '2021-01-01'
          AND canonical_url NOT IN ({placeholders})
        """,
        ("a" * 64, *sorted(initially_planned)),
    )
    connection.commit()

    second = ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=2,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    completed_planned = connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_samples AS sample
        JOIN captures AS capture
          ON capture.canonical_url=sample.canonical_url
        WHERE sample.sample_year=2020
          AND capture.status='complete'
          AND capture.raw_path IS NOT NULL
        """
    ).fetchone()[0]

    assert second["years"]["2020"]["addedCompletedToPlan"] == 2
    assert second["years"]["2020"]["addedToPlan"] == 2
    assert completed_planned == 2


def test_completed_validation_sample_records_parser_quality(tmp_path: Path):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )[0]
    body = " ".join(["Substantive reporting sentence."] * 30)
    html = f"""
    <!doctype html>
    <html lang="en">
      <head>
        <script type="application/ld+json">
          {{
            "@type": "NewsArticle",
            "headline": "A complete archived article",
            "datePublished": "2020-01-01T00:00:00Z"
          }}
        </script>
      </head>
      <body>
        <article>
          <p>{body}</p>
          <figure>
            <img
              src="https://dims.apnews.com/dims4/default/example.jpg"
              width="1200"
              height="800"
              alt="An editorial test image"
            />
          </figure>
        </article>
      </body>
    </html>
    """.encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=selected.article_id,
        publisher="ap",
        canonical_url=selected.canonical_url,
        published_at=datetime.fromisoformat(selected.published_at),
        selected_candidate=selected.candidates[0],
        candidates_considered=list(selected.candidates),
        retrieved_at=datetime.now(timezone.utc),
        final_url=selected.candidates[0].snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["sample"] is True
    assert result["status"] == "complete"
    assert result["qaPass"] is True
    result_hashes = connection.execute(
        """
        SELECT source_raw_sha256, source_capture_sha256
        FROM parser_validation_results
        WHERE canonical_url=?
        """,
        (selected.canonical_url,),
    ).fetchone()
    assert result_hashes[0] == blob.sha256
    assert len(result_hashes[1]) == 64
    changed_capture = capture.model_copy(
        update={
            "selected_candidate": CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=capture.selected_candidate.snapshot_url,
            )
        }
    )
    record_parser_validation(
        connection,
        capture=changed_capture,
        archive_root=tmp_path,
    )
    changed_hashes = connection.execute(
        """
        SELECT source_raw_sha256, source_capture_sha256
        FROM parser_validation_results
        WHERE canonical_url=?
        """,
        (selected.canonical_url,),
    ).fetchone()
    assert changed_hashes[0] == result_hashes[0]
    assert changed_hashes[1] != result_hashes[1]
    assert summary["years"]["2020"]["evaluated"] == 1
    assert summary["years"]["2020"]["complete"] == 1
    assert summary["years"]["2020"]["qaPassed"] == 1
    assert summary["years"]["2020"]["planned"] == 1
    assert summary["years"]["2020"]["imagesReferenced"] == 1
    assert summary["years"]["2020"]["imagesSelected"] == 1
    assert summary["years"]["2020"]["articlesWithImagesReferenced"] == 1
    assert summary["years"]["2020"]["articlesWithImagesSelected"] == 1
    assert summary["years"]["2020"]["imageSelectionRate"] == 1.0
    assert summary["years"]["2020"]["issueCounts"] == {}
    assert summary["years"]["2020"]["failureExamples"] == []


def test_nontext_interactive_is_not_a_false_article_body_failure(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/interactive/2020/10/25/"
        "us/politics/example.html"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        )
                VALUES (2020, 1, 'test', 'nyt-parser/0.8.158', 9, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        )
        VALUES (?, 2020, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html>
      <head>
        <meta property="og:title" content="Interactive election result">
        <meta property="article:published_time"
              content="2020-10-25T00:00:00Z">
      </head>
      <body><main data-interactive-root="result"></main></body>
    </html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="nyt:" + ("a" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(2020, 10, 25, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20201026000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "unsupported"
    assert result["qaPass"] is True
    assert result["issues"] == []
    assert summary["years"]["2020"]["nonTextContent"] == 1
    assert summary["years"]["2020"]["qaPassed"] == 1
    assert summary["years"]["2020"]["unsupported"] == 1


def test_nyt_short_partial_interactive_shell_is_screened(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/interactive/2020/11/04/us/elections/"
        "paths-to-victory-biden-trump.html"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2020, 1, 'test', 'nyt-parser/0.8.158', 9, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2020, 'priority', 'now')
        """,
        (canonical_url,),
    )
    blob = store_raw_html(
        tmp_path,
        b"""
        <html><head>
          <meta property="og:title" content="Paths to Victory">
          <meta property="article:published_time"
            content="2020-11-04T12:00:00Z">
        </head><body><main class="interactive-body"></main></body></html>
        """,
    )
    capture = RawCapture(
        article_id="nyt:" + ("p" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(2020, 11, 4, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20201105000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2020"]["evaluated"] == 0
    assert summary["years"]["2020"]["screenedNonArticles"] == 1


def test_wsj_legacy_preview_roadblock_is_screened_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/legacy-preview-1413317966"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2014, 1, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2014, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html>
      <head>
        <title>Legacy Preview - WSJ</title>
        <meta property="og:title" content="Legacy Preview">
        <meta property="article:published_time"
              content="2014-10-14T16:19:00Z">
      </head>
      <body>
        <article>
          <p>Companies are getting particular about where their data is stored.</p>
          <p>The partners said they would deliver software over the Internet.</p>
          <p>Get The Full Story</p>
          <p>Subscribe or Log In</p>
        </article>
        <p>Copyright &copy;2014 Dow Jones &amp; Company, Inc.</p>
      </body>
    </html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="wsj:" + ("w" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2014, 10, 14, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20141230152138id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2014"]["evaluated"] == 0
    assert summary["years"]["2014"]["screenedNonArticles"] == 1


@pytest.mark.parametrize(
    "canonical_url,html,sample_year",
    [
        (
            "https://www.nytimes.com/2014/06/15/opinion/editorial-cartoon.html",
            b"""
            <html><head>
              <title>Opinion | Editorial Cartoon - The New York Times</title>
              <meta property="og:title" content="Opinion | Editorial Cartoon">
              <meta property="article:published_time" content="2014-06-15T20:40:04Z">
              <meta property="og:image" content="https://static01.nyt.com/cartoon.jpg">
            </head><body><article><p>Promises of universal suffrage for Hong Kong.</p>
              <img src="https://static01.nyt.com/cartoon.jpg"></article></body></html>
            """,
            2014,
        ),
        (
            "https://www.nytimes.com/2020/11/20/us/politics/biden-transgender-day-of-remembrance.html",
            b"""
            <html><head>
              <meta property="og:title" content="On Transgender Day of Remembrance">
              <meta property="article:published_time" content="2020-11-20T17:47:29Z">
              <script type="application/ld+json">
                {"@type":"LiveBlogPosting","headline":"On Transgender Day of Remembrance"}
              </script>
            </head><body><article><h1>On Transgender Day of Remembrance</h1></article></body></html>
            """,
            2020,
        ),
        (
            "https://www.nytimes.com/2022/07/26/arts/television/tony-dow-dead.html",
            b"""
            <html><head>
              <title>Editors' Note - The New York Times</title>
              <meta property="og:title" content="Editors' Note">
              <meta property="og:description" content="An obituary was published in error.">
              <meta property="article:published_time" content="2022-07-26T17:20:43Z">
            </head><body><article><h1>Editors' Note</h1></article></body></html>
            """,
            2022,
        ),
        (
            "https://www.nytimes.com/2014/04/27/opinion/us-caught-up-in-islands-dispute.html",
            b"""
            <html><head>
              <meta property="og:title" content="U.S. Caught Up in Islands Dispute">
              <meta property="article:published_time" content="2014-04-27T12:00:00Z">
            </head><body>
              <section name="articleBody" class="meteredContent">
                <div class="StoryBodyCompanionColumn">
                  <p>The rising international racket over islands in the South China Sea.</p>
                </div>
              </section>
            </body></html>
            """,
            2014,
        ),
        (
            "https://www.nytimes.com/interactive/2023/us/"
            "fannin-texas-covid-cases.html",
            b"""
            <html><head>
              <meta property="og:title"
                    content="Tracking Coronavirus in Fannin County, Texas">
              <meta property="article:published_time"
                    content="2023-03-23T12:00:00Z">
            </head><body>
              <section name="articleBody">
                <p>This page reports local coronavirus cases, hospitalizations,
                deaths and vaccination trends for Fannin County residents.</p>
                <p>The charts use public health data and explain changes in the
                weekly reporting methodology across the county.</p>
              </section>
            </body></html>
            """,
            2023,
        ),
    ],
)
def test_nyt_nonarticle_packages_are_screened(
    tmp_path: Path,
    canonical_url: str,
    html: bytes,
    sample_year: int,
):
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (?, 1, 'test', 'nyt-parser/0.8.158', 9, 'now')
        """,
        (sample_year,),
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, ?, 'priority', 'now')
        """,
        (canonical_url, sample_year),
    )
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="nyt:" + ("n" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(sample_year, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20240101000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"][str(sample_year)]["evaluated"] == 0
    assert summary["years"][str(sample_year)]["screenedNonArticles"] == 1


def test_nyt_empty_story_shell_is_screened_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.nytimes.com/2022/08/26/opinion/sweat-benefits.html"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'nyt-parser/0.8.158', 9, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Opinion | In Praise of Sweat">
      <meta property="article:published_time"
            content="2022-08-26T23:00:06.000Z">
    </head><body>
      <article id="story"></article>
      <p class="author-bio">Mona Chalabi is an illustrator and data journalist.</p>
    </body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="nyt:" + ("s" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(2022, 8, 26, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20220902000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] in {"unsupported", "partial"}
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2022"]["evaluated"] == 0
    assert summary["years"]["2022"]["screenedNonArticles"] == 1


def test_short_aljazeera_liveblog_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.aljazeera.com/news/liveblog/2022/11/29/example"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'aljazeera-parser/0.1.21', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = (
        "<html><head>"
        "<script type='application/ld+json'>"
        + json.dumps(
            {
                "@type": "LiveBlogPosting",
                "headline": "World Cup live",
                "datePublished": "2022-11-29T00:00:00Z",
            }
        )
        + "</script></head><body><main><article>"
        "<h1>World Cup live</h1><p>This blog is now closed.</p>"
        "</article></main></body></html>"
    ).encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="aljazeera:" + ("a" * 64),
        publisher="aljazeera",
        canonical_url=canonical_url,
        published_at=datetime(2022, 11, 29, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20221130000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2022"]["evaluated"] == 0
    assert summary["years"]["2022"]["screenedNonArticles"] == 1
    connection.execute(
        """
        INSERT INTO parser_validation_results(
            canonical_url, publisher, sample_year, parser_version,
            qa_revision, extraction_status, content_type, qa_pass,
            body_characters, block_count, warnings_json, issues_json,
            parsed_at
        ) VALUES (?, 'aljazeera', 2022, 'aljazeera-parser/0.1.21', 6,
                  'complete', 'article', 1, 1200, 3, '[]', '[]', 'now')
        """,
        ("https://www.aljazeera.com/news/2022/11/29/regular-article",),
    )
    summary = parser_validation_summary(connection)
    assert summary["years"]["2022"]["evaluated"] == 1
    assert summary["years"]["2022"]["qaPassed"] == 1
    assert summary["years"]["2022"]["screenedNonArticles"] == 1


def test_aljazeera_hold_alias_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.aljazeera.com/economy/2022/4/6/"
        "hold-has-indias-central-bank-avoided-tackling-high-inflation"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'aljazeera-parser/0.1.21', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Has India avoided inflation?">
      <meta property="article:published_time" content="2022-04-06T00:00:00Z">
    </head><body><article>
      <p>This is a complete staging copy of the published article body.</p>
      <p>It must be retained raw but excluded from the independent sample.</p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="aljazeera:" + ("h" * 64),
        publisher="aljazeera",
        canonical_url=canonical_url,
        published_at=datetime(2022, 4, 6, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20220407000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2022"]["evaluated"] == 0
    assert summary["years"]["2022"]["screenedNonArticles"] == 1


def test_short_aljazeera_interactive_handoff_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.aljazeera.com/news/2011/1/11/"
        "algeria-a-timeline-of-discontent"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2011, 1, 'test', 'aljazeera-parser/0.1.21', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2011, 'priority', 'now')
        """
        ,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Algeria: A timeline of discontent">
      <meta property="article:published_time" content="2011-01-11T00:00:00Z">
    </head><body><main><article>
      <h1>Algeria: A timeline of discontent</h1>
      <p>View the historical context for the latest uprising in Algeria.</p>
    </article></main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="aljazeera:" + ("b" * 64),
        publisher="aljazeera",
        canonical_url=canonical_url,
        published_at=datetime(2011, 1, 11, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20250317223512id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2011"]["evaluated"] == 0
    assert summary["years"]["2011"]["screenedNonArticles"] == 1


def test_short_aljazeera_legacy_teaser_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.aljazeera.com/news/2010/8/1/"
        "washingtons-gift-to-pakistan"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2010, 1, 'test', 'aljazeera-parser/0.1.21', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2010, 'priority', 'now')
        """
        ,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Washington's gift to Pakistan">
      <meta property="article:published_time" content="2010-08-01T00:00:00Z">
    </head><body><main><article>
      <h1>Washington's gift to Pakistan</h1>
      <p>The views expressed do not necessarily reflect Al Jazeera's editorial policy.</p>
    </article></main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="aljazeera:" + ("c" * 64),
        publisher="aljazeera",
        canonical_url=canonical_url,
        published_at=datetime(2010, 8, 1, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20100802000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2010"]["evaluated"] == 0
    assert summary["years"]["2010"]["screenedNonArticles"] == 1


def test_ft_subscribe_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/0872c199-8078-4742-8d53-093911c1fc0d"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """
        ,
        (canonical_url,),
    )
    html = b"""
    <html><head><title>Subscribe to read | Financial Times</title>
      <meta property="og:title" content="Subscribe to read">
      <meta property="article:published_time" content="2022-01-01T00:00:00Z">
    </head><body><main>
      <p>Become an FT subscriber to read this article.</p>
      <nav>Financial Times Subscribe Sign In Search the FT</nav>
    </main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="ft:" + ("c" * 64),
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2022, 1, 1, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20220730084044id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert result["qaPass"] is False
    assert summary["years"]["2022"]["evaluated"] == 0
    assert summary["years"]["2022"]["screenedNonArticles"] == 1


def test_ft_recovered_article_with_subscribe_document_title_is_evaluated(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/f2373c9c-c48b-421f-9a99-a52dcd9b2e01"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head><title>Subscribe to read | Financial Times</title>
      <meta property="og:title" content="Investors Chronicle company report">
      <meta property="article:published_time" content="2022-08-15T00:00:00Z">
    </head><body><main><article>
      <h1>Investors Chronicle company report</h1>
      <p>The report examines company earnings, dividends and the outlook for investors across several listed businesses.</p>
      <p>Analysts also assess balance sheets, changing interest rates and management plans in substantive original reporting.</p>
    </article></main></body></html>
    """
    capture = RawCapture(
        article_id="ft:" + ("e" * 64),
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2022, 8, 15, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20220815080150id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "complete"
    assert result["issues"] == []
    assert result["qaPass"] is True
    assert summary["years"]["2022"]["evaluated"] == 1
    assert summary["years"]["2022"]["screenedNonArticles"] == 0


def test_ft_content_url_redirected_to_video_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/05ccefff-e4f8-38f0-9a78-a67b40f7c46c"
    video_url = "https://www.ft.com/video/05ccefff-e4f8-38f0-9a78-a67b40f7c46c"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="A Financial Times video report">
      <meta property="article:published_time" content="2022-01-21T00:00:00Z">
      <meta property="og:image" content="https://www.ft.com/video-poster.jpg">
    </head><body><main><video controls></video></main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="ft:" + ("d" * 64),
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2022, 1, 21, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20220121213641id_/" + video_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=(
            "http://web.archive.org/web/20220121213641id_/" + video_url
        ),
        http_status=200,
        content_type="text/html",
        quality_score=85,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "unsupported"
    assert result["issues"] == ["nonarticle-desk"]
    assert result["qaPass"] is False
    assert summary["years"]["2022"]["evaluated"] == 0
    assert summary["years"]["2022"]["screenedNonArticles"] == 1


@pytest.mark.parametrize(
    ("headline", "body", "extra_html"),
    [
        (
            "Bad weather umbrella",
            "A man with an umbrella walks alongside the river Spree on a rainy winter day in Berlin, Germany, Tuesday",
            "<a href='/photo-diary'>FT Photo Diary</a>",
        ),
        (
            "FT Weekend Quiz solutions",
            "Round on the Links. The link was the band Queen. Mercury. Deacon. May.",
            "",
        ),
    ],
)
def test_ft_non_news_caption_and_quiz_packages_are_screened(
    tmp_path: Path,
    headline: str,
    body: str,
    extra_html: str,
):
    canonical_url = "https://www.ft.com/content/" + ("a" * 36)
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = f"""
    <html><head><title>{headline}</title>
      <meta property='og:title' content='{headline}'>
      <meta property='article:published_time' content='2016-01-12T00:00:00Z'>
    </head><body><article><h1>{headline}</h1><p>{body}</p></article>
      {extra_html}</body></html>
    """.encode()
    capture = RawCapture(
        article_id="ft:" + ("f" * 64),
        publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2016, 1, 12, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20160112000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert result["qaPass"] is False
    assert summary["years"]["2016"]["evaluated"] == 0
    assert summary["years"]["2016"]["screenedNonArticles"] == 1


def test_ft_short_article_without_photo_diary_marker_remains_evaluated(
    tmp_path: Path,
):
    canonical_url = "https://www.ft.com/content/" + ("b" * 36)
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 1, 'test', 'ft-parser/0.8.69', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head><title>Brief market update</title>
      <meta property='og:title' content='Brief market update'>
      <meta property='article:published_time' content='2016-01-12T00:00:00Z'>
    </head><body><article><h1>Brief market update</h1>
      <p>Markets rose after the central bank announcement and investors welcomed the revised outlook.</p>
      <p>Trading remained orderly through the close.</p>
    </article></body></html>
    """
    capture = RawCapture(
        article_id="ft:" + ("1" * 64), publisher="ft",
        canonical_url=canonical_url,
        published_at=datetime(2016, 1, 12, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20160112000000id_/" + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc), final_url=canonical_url,
        http_status=200, content_type="text/html", quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(connection, capture=capture, archive_root=tmp_path)

    assert result["issues"] == []
    assert result["qaPass"] is True


@pytest.mark.parametrize(
    ("canonical_url", "final_url", "html"),
    [
        (
            "https://www.zaobao.com.sg/news/singapore/"
            "story20260810-9494116",
            "https://web.archive.org/web/20260811015845id_/"
            "https://interactive.zaobao.com.sg/2026/sg61-national-day-parade-2026-moments/",
            b"<html><head><title>Interactive package</title>"
            b"<meta property='og:title' content='Interactive package'>"
            b"<meta property='article:published_time' content='2026-08-10T00:00:00Z'>"
            b"</head>"
            b"<body><main>Interactive package</main></body></html>",
        ),
        (
            "https://www.zaobao.com.sg/horse-racing/race-results/"
            "story20260526-9105820",
            "https://www.zaobao.com.sg/horse-racing/race-results/"
            "story20260526-9105820",
            b"<html><head><title>Race results</title>"
            b"<meta property='og:title' content='Race results'>"
            b"<meta property='article:published_time' content='2026-05-26T00:00:00Z'>"
            b"</head>"
            b"<body><article><p>Race results.</p></article></body></html>",
        ),
        (
            "https://www.zaobao.com.sg/forum/paradigm/"
            "story20160107-568087",
            "https://www.zaobao.com.sg/forum/paradigm/"
            "story20160107-568087",
            b"<html><head><meta property='article:published_time' "
            b"content='2016-01-07T00:00:00Z'></head>"
            b"<body><div id='navigation-shell'>Forum</div></body></html>",
        ),
        (
            "https://www.zaobao.com.sg/forum/views/opinion/"
            "story20160206-579360",
            "https://www.zaobao.com.sg/forum/views/opinion/"
            "story20160206-579360",
            b"<html><head><meta property='article:published_time' "
            b"content='2016-02-06T00:00:00Z'></head>"
            b"<body><article><p>A short forum teaser survives this replay."
            b"</p></article></body></html>",
        ),
        (
            "https://www.zaobao.com.sg/news/singapore/"
            "story20221017-1323482",
            "https://www.zaobao.com.sg/news/singapore/"
            "story20221017-1323482",
            b"<html><head><meta property='og:title' content='A shell'>"
            b"</head><body><h1>A shell</h1></body></html>",
        ),
        (
            "https://www.zaobao.com.sg/entertainment/story20220107-1230493",
            "https://www.zaobao.com.sg/entertainment/story20220107-1230493",
            "<html><head><meta property='og:title' content='A video teaser'>"
            "</head><body><article><p>快点击视频观看！</p></article>"
            "</body></html>".encode("utf-8"),
        ),
        (
            "https://www.zaobao.com.sg/shorts/story20250321-6045580",
            "https://www.zaobao.com.sg/shorts/story20250321-6045580",
            "<html><head><meta property='og:title' content='A video short'>"
            "</head><body><article><h1>A video short</h1>"
            "<div class='articleBody'><div>延伸阅读</div>"
            "<img src='https://cassette.sphdigital.com.sg/image/zaobao/poster'>"
            "</div><video controls></video></article></body></html>"
            .encode("utf-8"),
        ),
    ],
)
def test_zaobao_non_article_desks_are_screened_from_parser_cohort(
    tmp_path: Path,
    canonical_url: str,
    final_url: str,
    html: bytes,
):
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2026, 1, 'test', 'zaobao-parser/0.1.22', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2026, 'priority', 'now')
        """,
        (canonical_url,),
    )
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="zaobao:" + ("a" * 64),
        publisher="zaobao",
        canonical_url=canonical_url,
        published_at=datetime(2026, 5, 26, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20260626000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=final_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    expected_issues = ["nonarticle-desk"]
    if "/forum/" in canonical_url:
        expected_issues.append("missing-headline")
    assert result["issues"] == expected_issues
    assert summary["years"]["2026"]["evaluated"] == 0
    assert summary["years"]["2026"]["screenedNonArticles"] == 1


def test_zaobao_short_forum_shell_with_headline_is_screened(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.zaobao.com.sg/forum/views/opinion/"
        "story20201213-1108366"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2020, 1, 'test', 'zaobao-parser/0.1.22', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2020, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = """
    <html><head>
      <meta property="og:title" content="论坛观点导读">
      <meta property="article:published_time" content="2020-12-13T00:00:00Z">
    </head><body><article><p>这是一段很短的论坛导读。</p></article></body></html>
    """.encode("utf-8")
    capture = RawCapture(
        article_id="zaobao:" + ("f" * 64),
        publisher="zaobao",
        canonical_url=canonical_url,
        published_at=datetime(2020, 12, 13, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20210413044609id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2020"]["evaluated"] == 0
    assert summary["years"]["2020"]["screenedNonArticles"] == 1


def test_zaobao_validation_rejects_surviving_intrablock_tandem_repeat(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.zaobao.com.sg/news/world/story20161122-693351"
    )
    repeated = "开调查，同时删除包括页岩油、天然气、煤炭在内部分能源生产的限制。"
    html = f"""
    <html><head>
      <meta property="og:title" content="特朗普公布施政方向">
      <meta property="article:published_time" content="2016-11-22T00:00:00Z">
    </head><body><article>
      <p>第一段提供足够的新闻背景和事件说明，以构成完整的历史报道正文。</p>
      <p><strong>政策：</strong>劳工部就签证计划遭滥用展{repeated}{repeated}</p>
    </article></body></html>
    """.encode("utf-8")
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 1, 'test', 'zaobao-parser/0.1.22', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, 'priority', 'now')
        """,
        (canonical_url,),
    )
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="zaobao:" + ("r" * 64),
        publisher="zaobao",
        canonical_url=canonical_url,
        published_at=datetime(2016, 11, 22, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20161123000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["repeated-text-within-block"]
    assert summary["years"]["2016"]["evaluated"] == 1
    assert summary["years"]["2016"]["qaPassed"] == 0


def test_scmp_access_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.scmp.com/business/article/2126031/"
        "could-co-living-be-the-future"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2018, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2018, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Could co-living be the future?">
      <meta property="article:published_time" content="2018-01-02T00:00:00Z">
    </head><body><article>
      <h1>Could co-living be the future?</h1>
      <p>READ FULL ARTICLE</p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="scmp:" + ("s" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2018, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20180103000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2018"]["evaluated"] == 0
    assert summary["years"]["2018"]["screenedNonArticles"] == 1


def test_scmp_short_live_package_is_retained_as_nontext_editorial_content(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.scmp.com/sport/article/3041121/"
        "follow-pandaland-crossfit-sanctional-day-two-live"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <title>Follow Pandaland CrossFit Challenge day two as it happened | SCMP</title>
      <meta property="og:title" content="Follow Pandaland CrossFit Challenge day two as it happened">
      <meta name="cse_articletype" content="Live">
      <meta property="article:published_time" content="2019-12-08T09:37:58+08:00">
    </head><body><article class="live-article__body">
      <p>Day two of Pandaland in Chengdu is underway and a spot at the CrossFit Games is up for grabs</p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="scmp:" + ("l" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2019, 12, 8, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.COMMON_CRAWL,
            snapshot_url="https://data.commoncrawl.org/example.warc.gz",
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "complete"
    assert result["qaPass"] is True
    assert result["issues"] == []
    assert summary["years"]["2019"]["evaluated"] == 1
    assert summary["years"]["2019"]["screenedNonArticles"] == 0


@pytest.mark.parametrize(
    ("canonical_url", "body_html"),
    (
        (
            "https://www.scmp.com/announcements/article/3127792/"
            "chinas-population",
            "<main><h1>Understanding China's population</h1></main>",
        ),
        (
            "https://www.scmp.com/about-us/article/2178269/"
            "south-china-morning-post-graduate-and-intern-programmes",
            "<main><h1>Graduate and intern programmes</h1>"
            "<div class='article-body'><p>"
            + (
                "The programme gives graduates practical experience across "
                "the publishing company and explains each application stage. "
                * 12
            )
            + "</p><p>-------------------------------------------------------"
            "---------------------------------------------</p></div></main>",
        ),
        (
            "https://www.scmp.com/yp/discover/entertainment/movies/article/"
            "3073544/remembering-bruce-lee",
            "<main><div class='ArticleContent__StyledBody-sc-1d7by8a-2'>"
            "</div><article><h2>Recommendation card</h2></article></main>",
        ),
        (
            "https://www.scmp.com/coronavirus/article/3087525/"
            "sars-hero-zhong-nanshan-scmp-series",
            "<main><p class='subheadline'>SCMP Series</p>"
            "<h1>Sars hero Zhong Nanshan</h1>"
            "<div class='banner-content-body'><p>A collection introduction.</p>"
            "</div></main>",
        ),
        (
            "https://www.scmp.com/news/china/article/1062009/"
            "xi-jinping-mourns-chinas-great-friend-sihanouk",
            "<main><h1 id='page-title' class='title'>Sorry...</h1>"
            "<p>As a result the site will be unavailable for a short period.</p>"
            "<p>We apologise for any inconvenience caused.</p></main>",
        ),
        (
            "https://www.scmp.com/yp/learn/learning-resources/"
            "listening-scripts/article/3072638/listening-answers-trip",
            "<main><h1>LISTENING ANSWERS: A WONDERFUL TRIP</h1>"
            "<div class='ArticleContent__StyledBody-sc-1d7by8a-2'>"
            "<p>1. b</p><p>2. d</p><p>3. a</p></div></main>",
        ),
        (
            "https://www.scmp.com/yp/learn/learning-resources/article/"
            "3128311/news-quiz-answers-april-6-2021",
            "<main><h1>NEWS QUIZ ANSWERS [April 6, 2021]</h1>"
            "<div class='ArticleContent__StyledBody-sc-1d7by8a-2'>"
            "<p>1. D</p><p>2. B</p><p>3. A</p></div></main>",
        ),
        (
            "https://www.scmp.com/yp/article/3071184/"
            "turbo-english-answers-january-27-2020",
            "<main><h1>Turbo English answers [January 27, 2020]</h1>"
            "<div class='ArticleContent__StyledBody-sc-1d7by8a-2'>"
            "<p>1. C</p><p>2. A</p><p>3. D</p></div></main>",
        ),
        (
            "https://www.scmp.com/yp/discover/news/article/3114431/"
            "quiz-answers-december-22-2020",
            "<main><h1>Quiz answers [December 22, 2020]</h1>"
            "<div class='ArticleContent__StyledBody-sc-1d7by8a-2'>"
            "<p>1. B</p><p>2. C</p><p>3. A</p></div></main>",
        ),
    ),
)
def test_scmp_unrecoverable_nonarticle_desks_are_screened(
    tmp_path: Path,
    canonical_url: str,
    body_html: str,
):
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2020, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2020, 'priority', 'now')
        """,
        (canonical_url,),
    )
    fixture_headline = re.search(r"<h1[^>]*>(.*?)</h1>", body_html)
    metadata_headline = (
        fixture_headline.group(1) if fixture_headline else "Archived SCMP item"
    )
    html = (
        f"<html><head><meta property='og:title' content='{metadata_headline}'>"
        "<meta property='article:published_time' "
        "content='2020-01-02T00:00:00Z'></head><body>"
        + body_html
        + "</body></html>"
    ).encode()
    capture = RawCapture(
        article_id="scmp:" + hashlib.sha256(canonical_url.encode()).hexdigest(),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2020, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20210101000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2020"]["evaluated"] == 0
    assert summary["years"]["2020"]["screenedNonArticles"] == 1


def test_scmp_subscription_campaign_redirect_is_screened(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.scmp.com/about-us/article/3136739/"
        "scmpcom-subscribe-get-expert-coverage-hong-kong-news"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2021, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2021, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <title>SCMP.com | Subscribe to Get Expert Coverage on Hong Kong News</title>
      <meta property="og:title"
            content="SCMP.com | Subscribe to Get Expert Coverage on Hong Kong News">
      <meta property="og:type" content="website">
      <meta property="article:published_time" content="2021-06-11T00:00:00Z">
    </head><body>
      <h1>Your Hong Kong, Your SCMP</h1>
      <p>Join SCMP's mission and enjoy uninterrupted access.</p>
      <p>Subscribe to the journalism that Hong Kong deserves.</p>
    </body></html>
    """
    capture = RawCapture(
        article_id="scmp:" + hashlib.sha256(canonical_url.encode()).hexdigest(),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2021, 6, 11, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20210611033743id_/"
            "https://subscribe.scmp.com/your-hong-kong",
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url="https://web.archive.org/web/20210611033743id_/"
        "https://subscribe.scmp.com/your-hong-kong",
        http_status=200,
        content_type="text/html",
        quality_score=85,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2021"]["evaluated"] == 0
    assert summary["years"]["2021"]["screenedNonArticles"] == 1


def test_scmp_infographic_and_gallery_pages_are_excluded_from_article_cohort(
    tmp_path: Path,
):
    urls = (
        "https://www.scmp.com/infographics/article/1916541/infographic-sharing-pie",
        "https://www.scmp.com/sport/article/1995065/rio-olympics-2016-gallery",
        "https://www.scmp.com/sport/article/1995063/rio-olympics-2016-stars",
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 3, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    for url in urls:
        connection.execute(
            """
            INSERT INTO parser_validation_samples(
                canonical_url, sample_year, sample_priority, selected_at
            ) VALUES (?, 2016, 'priority', 'now')
            """,
            (url,),
        )
        blob = store_raw_html(
            tmp_path,
            b"<html><head><meta property='og:title' content='SCMP visual'>"
            b"</head><body><article><h1>SCMP visual</h1>"
            b"<p>Loading the visual package.</p></article>"
            b"<script>window.__SCMP={\"carousel_slideshow_items\":\"12\"};</script>"
            b"</body></html>",
        )
        capture = RawCapture(
            article_id="scmp:" + ("g" * 64),
            publisher="scmp",
            canonical_url=url,
            published_at=datetime(2016, 1, 2, tzinfo=timezone.utc),
            selected_candidate=CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url="https://web.archive.org/web/20160103000000id_/"
                + url,
            ),
            retrieved_at=datetime.now(timezone.utc),
            final_url=url,
            http_status=200,
            content_type="text/html",
            quality_score=100,
            raw_html=blob,
        )
        result = record_parser_validation(
            connection,
            capture=capture,
            archive_root=tmp_path,
        )
        assert result["issues"] == ["nonarticle-desk"]

    summary = parser_validation_summary(connection)
    assert summary["years"]["2016"]["evaluated"] == 0
    assert summary["years"]["2016"]["screenedNonArticles"] == 3


def test_scmp_young_post_infographic_with_source_credit_is_excluded(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.scmp.com/yp/discover/advice/living/article/3068970/"
        "50-human-foods-your-dog-can-and-cant-eat"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="50 human foods your dog can and can't eat">
      <meta property="article:published_time" content="2019-11-20T06:11:00+08:00">
    </head><body>
      <div class="ArticleContent__StyledBody-sc-1d7by8a-2 body">
        <p><a href="https://www.cyberpet.com/human-food-for-dog/">
          <img src="https://cdn.i-scmp.com/human-food-for-dogs.jpg"
               alt="50 human foods your dog can and cannot eat">
        </a></p>
        <p>All information from
          <a href="https://www.cyberpet.com/human-food-for-dog/">
            www.cyberpet.com/human-food-for-dog/
          </a>.
        </p>
      </div>
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"apolloState":{"article":{"summary":
        "This infographic from Cyberpet explains it all"}}}}
      </script>
    </body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="scmp:" + ("i" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2019, 11, 20, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20200420000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2019"]["evaluated"] == 0
    assert summary["years"]["2019"]["screenedNonArticles"] == 1


def test_scmp_apollo_image_only_slideshow_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.scmp.com/news/article/3116952/"
        "why-chinas-gen-z-are-touching-fish-elderly-influencers-and-more"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2021, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2021, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Why China's Gen Z are touching fish">
      <meta property="article:published_time" content="2021-01-08T00:00:00Z">
      <script>window.__APOLLO_STATE__={"displaySlideShow":true};</script>
    </head><body><article><h1>Why China's Gen Z are touching fish</h1>
      <p><img src="https://cdn.i-scmp.com/cover.jpg"></p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="scmp:" + ("m" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2021, 1, 8, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20210109000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2021"]["evaluated"] == 0
    assert summary["years"]["2021"]["screenedNonArticles"] == 1


def test_scmp_static_report_landing_passes_interactive_qa(tmp_path: Path):
    canonical_url = (
        "https://www.scmp.com/news/china/article/3146059/"
        "china-internet-report-2021-redirection"
    )
    multimedia_url = (
        "https://multimedia.scmp.com/infographics/china-internet-2021"
    )
    reporting = " ".join(
        [
            "The report examines regulation, competition, investment and "
            "technology trends across China's internet economy."
        ]
        * 12
    )
    html = f"""
    <html><head>
      <meta property="og:title" content="China Internet Report">
      <meta property="og:url" content="{multimedia_url}">
      <meta property="og:image" content="{multimedia_url}/img/og_img.jpg">
      <meta property="article:published_time" content="2021-08-15T12:00:00Z">
    </head><body><main id="main">
      <section id="section__1" class="section"><p>{reporting}</p></section>
      <section id="section__2" class="section"><p>{reporting}</p>
        <form><input type="email"><button>Download</button></form>
      </section>
    </main></body></html>
    """.encode()
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2021, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2021, 'priority', 'now')
        """,
        (canonical_url,),
    )
    capture = RawCapture(
        article_id="scmp:" + ("r" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2021, 8, 15, 12, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20210906105754id_/"
                + multimedia_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=multimedia_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is True
    assert result["issues"] == []
    assert result["status"] == "complete"
    assert connection.execute(
        "SELECT content_type FROM parser_validation_results "
        "WHERE canonical_url=?",
        (canonical_url,),
    ).fetchone() == ("interactive",)
    assert summary["ready"] is True
    assert summary["years"]["2021"]["evaluated"] == 1


@pytest.mark.parametrize(
    ("canonical_url", "final_url", "html"),
    (
        (
            "https://www.scmp.com/week-asia/asia-buzz/article/2023371/"
            "asia-gone-mad-graphic",
            "https://www.scmp.com/week-asia/asia-buzz/article/2023371/"
            "asia-gone-mad-graphic",
            b"""
            <html><head>
              <meta property="og:title" content="Asia gone MAD: graphic">
              <meta property="article:published_time"
                    content="2016-09-28T08:00:00+08:00">
            </head><body><div class="article-body clearfix">
              <p><a class="colorbox" href="/full.jpg">
                <img src="/graphic.jpg" width="486" height="778"
                     title="Nuclear bombs around the world: Click to enlarge">
              </a></p>
            </div></body></html>
            """,
        ),
        (
            "https://www.scmp.com/native/lifestyle/topics/"
            "local-vision-hong-kong/article/2186136/"
            "local-vision-life-hong-kong-citys",
            "https://multimedia.scmp.com/native/infographics/article/"
            "2186136/local-vision-life-hong-kong-citys/",
            b"""
            <html><head>
              <meta property="og:title"
                    content="Local vision: life in Hong Kong">
              <meta property="og:image"
                    content="https://advertising.scmp.com/social.jpg">
            </head><body><main></main></body></html>
            """,
        ),
        (
            "https://www.scmp.com/special-reports/article/3040499/"
            "luxehomes-2019-annual-edition",
            "https://web.archive.org/web/20210906190650id_/"
            "https://www.scmp.com/topics/luxehomes-2019-annual-edition",
            b"""
            <html><head>
              <title>LuxeHomes 2019 Annual Edition | SCMP</title>
              <meta property="og:type" content="website">
              <meta property="og:title"
                    content="LuxeHomes 2019 Annual Edition | SCMP">
            </head><body>
              <main class="topic-view">
                <div class="topic-content"></div>
              </main>
            </body></html>
            """,
        ),
        (
            "https://www.scmp.com/presented/lifestyle/health-wellness/"
            "topics/exercise-your-health-knowledge/article/3113855/how",
            "https://multimedia.scmp.com/native/infographics/article/"
            "3113855/how-healthy-are-you/",
            b"""
            <html><head>
              <meta property="og:title" content="How healthy are you?">
            </head><body><main><h1>How healthy are you?</h1></main></body></html>
            """,
        ),
        (
            "https://www.scmp.com/article/1063281/"
            "topic-controversies-surrounding-yasukuni-shrine",
            "https://web.archive.org/web/20121025145356id_/"
            "http://www.scmp.com/topics/yasukuni-shrine",
            b"""
            <html class="section-topics"><head>
              <title>Yasukuni Shrine | South China Morning Post</title>
              <meta property="og:type" content="article">
            </head><body>
              <main class="panel-content-topic">
                <h2>Yasukuni Shrine</h2>
                <p>Trending topics</p>
                <div class="view-display-id-topics_by_count"></div>
              </main>
            </body></html>
            """,
        ),
    ),
)
def test_scmp_short_visual_packages_are_excluded_from_text_article_cohort(
    tmp_path: Path,
    canonical_url: str,
    final_url: str,
    html: bytes,
):
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    capture = RawCapture(
        article_id="scmp:" + ("v" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2019, 1, 2, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20200103000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=final_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    expected_issues = ["nonarticle-desk"]
    if b'property="og:title"' not in html:
        expected_issues.append("missing-headline")
    assert result["issues"] == expected_issues
    assert summary["years"]["2019"]["evaluated"] == 0
    assert summary["years"]["2019"]["screenedNonArticles"] == 1


def test_npr_short_audio_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.npr.org/2014/11/28/366815412/short-audio-segment"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
            ) VALUES (2014, 1, 'test', 'npr-parser/0.1.59', 1, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2014, 'priority', 'now')
        """
        ,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="NPR audio story">
      <meta property="article:published_time" content="2014-11-28T00:00:00Z">
    </head><body class="is-DACS-only no-transcript">
      <div id="storytext"><p>A short audio introduction.</p></div>
    </body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="npr:" + ("n" * 64),
        publisher="npr",
        canonical_url=canonical_url,
        published_at=datetime(2014, 11, 28, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20141129000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2014"]["evaluated"] == 0
    assert summary["years"]["2014"]["screenedNonArticles"] == 1


def test_wsj_media_unsupported_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = "https://www.wsj.com/articles/media-shell-1515668290"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2018, 1, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2018, 'priority', 'now')
        """
        ,
        (canonical_url,),
    )
    html = b"""
    <html><head><meta property="og:title" content="Media package"></head>
    <body><article><p>Article Not Supported</p>
      <p>To Read the Full Story Subscribe Sign In</p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="wsj:" + ("w" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2018, 1, 11, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.INFINI_NEWS,
            snapshot_url="https://datasets-server.huggingface.co/rows?offset=1",
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2018"]["evaluated"] == 0
    assert summary["years"]["2018"]["screenedNonArticles"] == 1


def test_wsj_full_article_with_hidden_unsupported_notice_remains_eligible(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/articles/china-weighs-zero-covid-exit-11667826209"
    )
    reporting = " ".join(
        [
            "The report contains recovered facts, quotations and policy context."
        ]
        * 18
    )
    html = f"""
    <html><head>
      <meta property="og:title" content="China Weighs Zero-Covid Exit">
      <meta property="article:published_time" content="2022-11-10T00:00:00Z">
    </head><body>
      <div hidden>Article Not Supported. To Read the Full Story, subscribe.</div>
      <article><div class="articleBody"><p>{reporting}</p></div></article>
    </body></html>
    """.encode("utf-8")
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2022, 1, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2022, 'priority', 'now')
        """,
        (canonical_url,),
    )
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="wsj:" + ("f" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2022, 11, 10, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.INFINI_NEWS,
            snapshot_url="https://datasets-server.huggingface.co/rows?offset=2",
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is True
    assert result["issues"] == []
    assert summary["years"]["2022"]["evaluated"] == 1
    assert summary["years"]["2022"]["qaPassed"] == 1


def test_wsj_legacy_subscriber_panel_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.wsj.com/article/"
        "0,,BT-CO-20130131-711145,00.html"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2013, 1, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2013, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <title>Towerstream and Others Price Stock Offerings - WSJ.com</title>
      <meta property="article:published_time" content="2013-01-31T15:05:00Z">
    </head><body>
      <div id="articleTabs_panel_article" class="mastertextCenter">
        <div class="articleHeadlineBox"><h1>Towerstream and Others Price
        Stock Offerings</h1></div>
        <img id="artSnippetControl" src="/static_html_files/artSnippetControl.gif">
        <div class="headlineSummary"><h3>Available to WSJ.com Subscribers</h3>
          <p>Subscriber Content Read Preview Panetta: Iranian Threat Spreads</p>
          <p>Subscriber Content Read Preview Markets Await the Jobs Report</p>
        </div>
        <div class="emailConfScrim"><p>Your email has been sent.</p>
          <p>An error has occured and your email has not been sent.</p></div>
      </div>
    </body></html>
    """
    capture = RawCapture(
        article_id="wsj:" + ("p" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2013, 1, 31, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20130204010557id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2013"]["evaluated"] == 0
    assert summary["years"]["2013"]["screenedNonArticles"] == 1


def test_wsj_short_video_shell_is_excluded_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = "https://www.wsj.com/articles/legacy-video-1469663359"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 1, 'test', 'wsj-parser/0.8.78', 6, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="A Legacy WSJ Video">
      <meta property="article:published_time" content="2016-07-27T00:00:00Z">
    </head><body><article>
      <div id="masterVideoCenter"></div>
      <div id="videoPlayerDescription"><p>Watch the video.</p></div>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="wsj:" + ("v" * 64),
        publisher="wsj",
        canonical_url=canonical_url,
        published_at=datetime(2016, 7, 27, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20160728000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "complete"
    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2016"]["evaluated"] == 0
    assert summary["years"]["2016"]["screenedNonArticles"] == 1


def test_scmp_short_infographic_handoff_is_excluded(tmp_path: Path):
    canonical_url = (
        "https://www.scmp.com/sport/racing/article/1927468/"
        "infographic-once-lifetime-race-hong-kong-derby"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2016, 1, 'test', 'scmp-parser/0.1.53', 19, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2016, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="INFOGRAPHIC: Once in a lifetime race, the Hong Kong Derby">
      <meta property="og:description" content="Click to view the full-size infographic in high resolution.">
      <meta property="og:image" content="https://cdn.i-scmp.com/derby-infographic.jpg">
      <meta property="article:published_time" content="2016-03-18T00:00:00Z">
    </head><body><main><article>
      <p>Click to view the full-size infographic in high resolution.</p>
    </article></main></body></html>
    """
    capture = RawCapture(
        article_id="scmp:" + ("i" * 64),
        publisher="scmp",
        canonical_url=canonical_url,
        published_at=datetime(2016, 3, 18, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20170414225126id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=store_raw_html(tmp_path, html),
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "partial"
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2016"]["evaluated"] == 0
    assert summary["years"]["2016"]["screenedNonArticles"] == 1


def test_empty_axios_video_does_not_fill_article_validation_target(
    tmp_path: Path,
):
    canonical_url = "https://www.axios.com/2019/06/11/example-video"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'axios-parser/0.1.13', 2, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Axios on HBO interview">
      <meta property="article:published_time" content="2019-06-11T00:00:00Z">
      <meta property="og:type" content="video.other">
      <meta property="og:image" content="https://images.axios.com/poster.jpg">
    </head><body><main></main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("b" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2019, 6, 11, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20190612000000id_/" + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )

    assert connection.execute(
        "SELECT content_type FROM parser_validation_results WHERE canonical_url=?",
        (canonical_url,),
    ).fetchone()[0] == "video"
    assert result["qaPass"] is False
    assert result["issues"] == [
        "empty-nontext-content",
        "nonarticle-desk",
    ]


def test_axios_subscription_confirmation_does_not_fill_article_target(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.axios.com/2019/07/30/thank-you-for-subscribing"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2019, 1, 'test', 'axios-parser/0.1.33', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2019, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Thank you for subscribing">
      <meta property="article:published_time" content="2019-07-30T00:00:00Z">
    </head><body><main>
      <p>Thanks for subscribing to Axios newsletters.</p>
    </main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("s" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2019, 7, 30, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20190731000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2019"]["evaluated"] == 0
    assert summary["years"]["2019"]["screenedNonArticles"] == 1


def test_axios_special_report_landing_page_is_screened_from_article_cohort(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.axios.com/2021/06/14/"
        "hospitals-predatory-medical-billing"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2021, 1, 'test', 'axios-parser/0.1.33', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2021, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title"
            content="How America's top hospitals send patient costs soaring">
      <meta property="article:published_time"
            content="2021-06-14T00:00:00Z">
    </head><body><main>
      <p>Special report: How America's top hospitals send patient costs soaring</p>
      <a href="https://www.axios.com/special-report">Read the story</a>
    </main></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("a" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2021, 6, 14, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.COMMON_CRAWL,
            snapshot_url="https://data.commoncrawl.org/example.warc",
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2021"]["evaluated"] == 0
    assert summary["years"]["2021"]["screenedNonArticles"] == 1


def test_axios_short_partial_legacy_cms_shell_is_screened(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.axios.com/2017/12/16/fox-test-1513388151"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2017, 1, 'test', 'axios-parser/0.1.33', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2017, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <title>Fox test</title>
      <meta property="og:title" content="Fox test">
      <meta property="article:published_time"
            content="2017-12-16T00:00:00Z">
    </head><body><article><p>Day 91</p></article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("x" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2017, 12, 16, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20171217000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert result["issues"] == ["nonarticle-desk"]
    assert summary["years"]["2017"]["evaluated"] == 0
    assert summary["years"]["2017"]["screenedNonArticles"] == 1


def test_axios_internal_fixture_does_not_fill_article_validation_target(
    tmp_path: Path,
):
    canonical_url = (
        "https://www.axios.com/2017/12/16/"
        "axios-generate-test-1513388154"
    )
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2017, 1, 'test', 'axios-parser/0.1.33', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2017, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Axios Generate test">
      <meta property="article:published_time" content="2017-04-28T19:34:20Z">
    </head><body><article><p>test test test</p><p>fin</p></article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("e" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2017, 4, 28, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20170429000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert "nonarticle-desk" in result["issues"]
    assert summary["years"]["2017"]["evaluated"] == 0
    assert summary["years"]["2017"]["screenedNonArticles"] == 1
    assert summary["ready"] is False


def test_malformed_axios_url_alias_does_not_fill_validation_target(
    tmp_path: Path,
):
    canonical_url = "https://www.axios.com/2025/01/20/example-story%5C"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
        ) VALUES (2025, 1, 'test', 'axios-parser/0.1.33', 7, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2025, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="A complete Axios report">
      <meta property="article:published_time" content="2025-01-20T12:00:00Z">
    </head><body><article>
      <p>The report contains substantial original reporting about a policy
      decision and its consequences for readers across the country.</p>
      <p>A second paragraph records the response from officials and experts.</p>
    </article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="axios:" + ("f" * 64),
        publisher="axios",
        canonical_url=canonical_url,
        published_at=datetime(2025, 1, 20, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                "https://web.archive.org/web/20250121000000id_/"
                + canonical_url
            ),
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert "nonarticle-desk" in result["issues"]
    assert summary["years"]["2025"]["evaluated"] == 0
    assert summary["years"]["2025"]["screenedNonArticles"] == 1


def test_caixin_photo_desk_does_not_fill_article_validation_target(
    tmp_path: Path,
):
    canonical_url = "https://photos.caixin.com/2010-10-27/100192874.html"
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
            ) VALUES (2010, 1, 'test', 'caixin-parser/0.1.15', 1, 'now')
        """
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, 2010, 'priority', 'now')
        """,
        (canonical_url,),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Caixin photo">
      <meta property="article:published_time" content="2010-10-27T00:00:00Z">
      <meta property="og:image" content="http://img.caixin.com/photo.jpg">
    </head><body><div class="photoShow"><img src="http://img.caixin.com/photo.jpg"></div></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="caixin:" + ("c" * 64),
        publisher="caixin",
        canonical_url=canonical_url,
        published_at=datetime(2010, 10, 27, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20101028000000id_/" + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert "nonarticle-desk" in result["issues"]
    assert summary["years"]["2010"]["evaluated"] == 0
    assert summary["years"]["2010"]["screenedNonArticles"] == 1
    assert summary["years"]["2010"]["qaPassed"] == 0
    assert summary["ready"] is False


def test_caixin_validation_plan_skips_photo_and_video_desks(
    tmp_path: Path,
):
    manifest = tmp_path / "caixin-validation-manifest.jsonl"
    text_url = "https://china.caixin.com/2010-01-01/100100001.html"
    photo_url = "https://photos.caixin.com/2010-01-01/100100002.html"
    video_url = "https://video.caixin.com/2010-01-01/100100003.html"
    rows = []
    for url in (text_url, photo_url, video_url):
        rows.append(
            {
                "publisher": "caixin",
                "canonical_url": url,
                "published_at": "2010-01-01T00:00:00Z",
                "candidates": [
                    CaptureCandidate(
                        provider=CaptureProvider.WAYBACK,
                        snapshot_url=(
                            "https://web.archive.org/web/20100102000000id_/"
                            + url
                        ),
                        captured_at=datetime(
                            2010,
                            1,
                            2,
                            tzinfo=timezone.utc,
                        ),
                        mime_type="text/html",
                        status_code=200,
                    ).model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
                ],
            }
        )
    manifest.write_text(
        "".join(json.dumps(row, default=str) + "\n" for row in rows),
        encoding="utf-8",
    )
    connection = sqlite3.connect(":memory:")
    initialize_capture_schema(
        connection,
        publisher="caixin",
        authorization_reference="authorization:test",
    )
    load_capture_manifest(
        connection,
        manifest_path=manifest,
        publisher="caixin",
    )

    ensure_parser_validation_plan(
        connection,
        publisher="caixin",
        from_year=2010,
        to_year=2010,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )

    selected = [
        str(row[0])
        for row in connection.execute(
            "SELECT canonical_url FROM parser_validation_samples"
        )
    ]
    assert selected == [text_url]


@pytest.mark.parametrize(
    "canonical_url,sample_year",
    [
        (
            "https://www.nytimes.com/2019/09/01/pageoneplus/"
            "corrections-september-2-2019.html",
            2019,
        ),
        (
            "https://www.nytimes.com/2019/08/04/todayspaper/"
            "quotation-of-the-day-a-short-card.html",
            2019,
        ),
        (
            "https://www.nytimes.com/2012/12/12/pageoneplus/"
            "quotation-of-the-day-for-wednesday-dec-12-2012.html",
            2012,
        ),
        (
            "https://www.nytimes.com/2018/03/03/admin/"
            "our-10-most-popular-recipes-right-now.html",
            2018,
        ),
        (
            "https://www.nytimes.com/interactive/2018/03/04/admin/"
            "05oscarsRedCarpetPromo.html",
            2018,
        ),
    ],
)
def test_nyt_print_utility_entry_is_screened_from_article_cohort(
    tmp_path: Path,
    canonical_url: str,
    sample_year: int,
):
    connection = sqlite3.connect(":memory:")
    initialize_parser_validation_schema(connection)
    connection.execute(
        """
        INSERT INTO parser_validation_config(
            sample_year, target_size, seed, parser_version, qa_revision,
            updated_at
                ) VALUES (?, 1, 'test', 'nyt-parser/0.8.158', 9, 'now')
        """,
        (sample_year,),
    )
    connection.execute(
        """
        INSERT INTO parser_validation_samples(
            canonical_url, sample_year, sample_priority, selected_at
        ) VALUES (?, ?, 'priority', 'now')
        """,
        (canonical_url, sample_year),
    )
    html = b"""
    <html><head>
      <meta property="og:title" content="Print utility card">
      <meta property="article:published_time" content="2019-09-01T00:00:00Z">
    </head><body><article><p>A short notice.</p></article></body></html>
    """
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id="nyt:" + ("d" * 64),
        publisher="nyt",
        canonical_url=canonical_url,
        published_at=datetime(sample_year, 9, 1, tzinfo=timezone.utc),
        selected_candidate=CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url="https://web.archive.org/web/20190902000000id_/"
            + canonical_url,
        ),
        retrieved_at=datetime.now(timezone.utc),
        final_url=canonical_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["qaPass"] is False
    assert "nonarticle-desk" in result["issues"]
    assert summary["years"][str(sample_year)]["evaluated"] == 0
    assert summary["years"][str(sample_year)]["screenedNonArticles"] == 1


def test_validation_rejects_interface_noise_inside_complete_body(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )[0]
    body = " ".join(["Substantive archived reporting sentence."] * 30)
    html = f"""
    <html><head>
      <script type="application/ld+json">{{
        "@type": "NewsArticle",
        "headline": "A report contaminated by a recommendation module",
        "datePublished": "2020-01-01T00:00:00Z"
      }}</script>
    </head><body><article>
      <p>{body}</p>
      <aside><p>From Around the Web Promoted by Taboola</p></aside>
    </article></body></html>
    """.encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=selected.article_id,
        publisher="ap",
        canonical_url=selected.canonical_url,
        published_at=datetime.fromisoformat(selected.published_at),
        selected_candidate=selected.candidates[0],
        candidates_considered=list(selected.candidates),
        retrieved_at=datetime.now(timezone.utc),
        final_url=selected.candidates[0].snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "complete"
    assert result["qaPass"] is False
    assert result["issues"] == ["interface-noise-in-body"]
    assert summary["years"]["2020"]["issueCounts"] == {
        "interface-noise-in-body": 1
    }
    assert summary["gates"]["minimumQaPassRate"] == 1.0
    assert summary["ready"] is False


def test_validation_accepts_wsj_business_wire_source_attribution(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path, publisher="wsj")
    ensure_parser_validation_plan(
        connection,
        publisher="wsj",
        from_year=2020,
        to_year=2020,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )[0]
    body = " ".join(
        ["Substantive archived earnings-release sentence."] * 30
    )
    html = f"""
    <html><head>
      <script type="application/ld+json">{{
        "@type": "NewsArticle",
        "headline": "A complete company earnings release",
        "datePublished": "2020-01-01T00:00:00Z"
      }}</script>
    </head><body><article>
      <p>{body}</p>
      <p>SOURCE: Example Company Copyright Business Wire 2020</p>
    </article></body></html>
    """.encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=selected.article_id,
        publisher="wsj",
        canonical_url=selected.canonical_url,
        published_at=datetime.fromisoformat(selected.published_at),
        selected_candidate=selected.candidates[0],
        candidates_considered=list(selected.candidates),
        retrieved_at=datetime.now(timezone.utc),
        final_url=selected.candidates[0].snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    summary = parser_validation_summary(connection)

    assert result["status"] == "complete"
    assert result["qaPass"] is True
    assert result["issues"] == []
    assert summary["formatVersion"] == "jojo-parser-validation/2"
    assert summary["years"]["2020"]["qaRevision"] == 6
    assert summary["years"]["2020"]["qaPassed"] == 1
    assert summary["years"]["2020"]["issueCounts"] == {}


def test_validation_keeps_catalog_year_when_parsed_publication_year_differs(
    tmp_path: Path,
):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )[0]
    body = " ".join(["Cross-year reporting sentence."] * 30)
    html = f"""
    <html>
      <head>
        <script type="application/ld+json">
          {{
            "@type": "NewsArticle",
            "headline": "A cross-year archived article",
            "datePublished": "2021-06-15T00:00:00Z"
          }}
        </script>
      </head>
      <body><article><p>{body}</p></article></body>
    </html>
    """.encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=selected.article_id,
        publisher="ap",
        canonical_url=selected.canonical_url,
        published_at=datetime.fromisoformat(selected.published_at),
        selected_candidate=selected.candidates[0],
        candidates_considered=list(selected.candidates),
        retrieved_at=datetime.now(timezone.utc),
        final_url=selected.candidates[0].snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )

    result = record_parser_validation(
        connection,
        capture=capture,
        archive_root=tmp_path,
    )
    stored_year = connection.execute(
        """
        SELECT sample_year
        FROM parser_validation_results
        WHERE canonical_url=?
        """,
        (selected.canonical_url,),
    ).fetchone()[0]

    assert result["plannedYear"] == 2020
    assert result["year"] == 2020
    assert stored_year == 2020


def test_completed_sample_can_be_replayed_from_capture_state(tmp_path: Path):
    connection = _state_with_years(tmp_path)
    ensure_parser_validation_plan(
        connection,
        publisher="ap",
        from_year=2020,
        to_year=2022,
        target_per_year=1,
        reserve_per_year=0,
        maximum_record_attempts=3,
    )
    selected = pending_captures(
        connection,
        retry_errors=False,
        maximum=1,
        maximum_record_attempts=3,
        prioritize_parser_validation=True,
    )[0]
    body = " ".join(["Replayable reporting sentence."] * 40)
    html = f"""
    <html>
      <head>
        <script type="application/ld+json">
          {{
            "@type": "NewsArticle",
            "headline": "A replayed archived article",
            "datePublished": "2020-01-01T00:00:00Z"
          }}
        </script>
      </head>
      <body><article><p>{body}</p></article></body>
    </html>
    """.encode()
    blob = store_raw_html(tmp_path, html)
    capture = RawCapture(
        article_id=selected.article_id,
        publisher="ap",
        canonical_url=selected.canonical_url,
        published_at=datetime.fromisoformat(selected.published_at),
        selected_candidate=selected.candidates[0],
        candidates_considered=list(selected.candidates),
        retrieved_at=datetime.now(timezone.utc),
        final_url=selected.candidates[0].snapshot_url,
        http_status=200,
        content_type="text/html",
        quality_score=100,
        raw_html=blob,
    )
    record_capture_result(
        connection,
        {
            "canonicalUrl": selected.canonical_url,
            "status": "complete",
            "capture": capture,
            "recordPath": None,
            "error": None,
        },
    )

    pending = pending_completed_parser_validation_files(
        connection,
        maximum=10,
    )
    restored = completed_raw_capture(
        connection,
        canonical_url=selected.canonical_url,
    )
    result = record_parser_validation(
        connection,
        capture=restored,
        archive_root=tmp_path,
    )

    assert pending == [(selected.canonical_url, blob.path)]
    assert restored == capture
    assert result["qaPass"] is True
    assert pending_completed_parser_validation_files(
        connection,
        maximum=10,
    ) == []
    connection.execute(
        """
        UPDATE parser_validation_results
        SET qa_pass=0
        WHERE canonical_url=?
        """,
        (selected.canonical_url,),
    )
    assert failed_completed_parser_validation_files(
        connection,
        maximum=10,
    ) == [(selected.canonical_url, blob.path)]
    connection.execute(
        """
        UPDATE captures
        SET raw_sha256=?
        WHERE canonical_url=?
        """,
        ("b" * 64, selected.canonical_url),
    )
    initialize_parser_validation_schema(connection)
    assert connection.execute(
        """
        SELECT COUNT(*)
        FROM parser_validation_results
        WHERE canonical_url=?
        """,
        (selected.canonical_url,),
    ).fetchone()[0] == 0
