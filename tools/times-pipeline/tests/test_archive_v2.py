from __future__ import annotations

from datetime import datetime, timezone

from archive_v2 import (
    _browser_failure_reason,
    _capture_failure_reason,
    _capture_result,
    _merge_capture_attempts,
    _needs_extraction_retry,
)
from times_pipeline.feeds import Article, Source
from times_pipeline.webarchive import ArticleCapture, HttpExchange


NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc).isoformat()
SOURCE = Source("example", "Example", "en", None, "https://example.test/feed", "summary-only")


def _capture(body: bytes, *, status: int = 403, error: str | None = "HTTPStatus403") -> ArticleCapture:
    value = Article(
        id="example:one",
        title="Example article",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://example.test/one",
        published_at=NOW,
        source=SOURCE,
    )
    exchange = HttpExchange(
        source_id=SOURCE.id,
        article_id=value.id,
        canonical_url=value.url,
        title=value.title,
        captured_at=NOW,
        request_url=value.url,
        request_headers=(),
        status_code=status,
        reason_phrase="Rendered DOM",
        response_headers=(("Content-Type", "text/html"), ("X-JOJO-Rendered-DOM", "true")),
        body=body,
        is_page=True,
    )
    return ArticleCapture(value.id, SOURCE.id, value.url, value.title, (exchange,), 10, error)


def test_valid_rendered_article_body_wins_over_original_403_status() -> None:
    paragraphs = [
        f"This is complete rendered article paragraph {index} with enough meaningful text. " * 5
        for index in range(3)
    ]
    capture = _capture(
        f"<html><article>{''.join(f'<p>{paragraph}</p>' for paragraph in paragraphs)}</article></html>".encode()
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body is not None
    assert body.count("<p>") == 3


def test_403_challenge_page_is_not_treated_as_full_text() -> None:
    succeeded, body = _capture_result(_capture(b"<html><main><p>Access denied.</p></main></html>"))

    assert succeeded is False
    assert body is None


def test_bloomberg_preview_does_not_use_unrelated_document_paragraphs() -> None:
    preview = "This is only the short blurred preview of a Bloomberg story. " * 4
    unrelated = "Unrelated footer, recommendation, and privacy content outside the article. " * 10
    capture = _capture(
        (
            "<html><body>"
            f"<div class='body-content'><p>{preview}</p><p>{preview}</p></div>"
            f"<footer><p>{unrelated}</p><p>{unrelated}</p><p>{unrelated}</p></footer>"
            "</body></html>"
        ).encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "bloomberg",
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body is None


def test_bloomberg_uses_structured_next_data_when_bpc_dom_is_still_a_preview() -> None:
    paragraphs = [
        "Treasury yields reflect several independent market forces that cannot be changed with a single policy lever. " * 4,
        "Investors are pricing fiscal supply, inflation expectations, and term premium into longer-dated government debt. " * 4,
        "The administration can influence expectations, but global demand ultimately determines the clearing yield. " * 4,
    ]
    payload = {
        "props": {"pageProps": {"story": {"body": {"content": [
            {"type": "inline-newsletter", "data": {"title": "Newsletter promotion that is not article text"}},
            {"type": "paragraph", "content": [{"type": "text", "value": paragraphs[0]}]},
            {"type": "paragraph", "content": [
                {"type": "text", "value": paragraphs[1][:150]},
                {"type": "entity", "data": {"href": "https://example.test"}, "content": [
                    {"type": "text", "value": paragraphs[1][150:]},
                ]},
            ]},
            {"type": "ad", "data": {"title": "Advertisement that must be ignored"}},
            {"type": "heading", "content": [{"type": "text", "value": paragraphs[2]}]},
        ]}}}}
    }
    preview = "This is only the short Bloomberg preview shown before BPC reconstructs the article. " * 3
    capture = _capture(
        (
            "<html><body>"
            f"<div class='body-content'><p>{preview}</p><p>{preview}</p></div>"
            '<script type="application/ld+json">{"isAccessibleForFree":false}</script>'
            f"<script id='__NEXT_DATA__' type='application/json'>{__import__('json').dumps(payload)}</script>"
            "</body></html>"
        ).encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "bloomberg",
        800,
        3,
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body is not None
    assert body.count("<p>") == 3
    assert "global demand" in body
    assert "Newsletter promotion" not in body
    assert "Advertisement" not in body


def test_nikkei_uses_structured_next_data_instead_of_preview_paywall() -> None:
    article_html = "".join(
        f"<p>Complete Nikkei article paragraph {index} contains reporting context, market detail, and analysis. {'More detail. ' * 25}</p>"
        for index in range(5)
    )
    payload = {"props": {"pageProps": {"data": {"body": article_html}}}}
    capture = _capture(
        (
            "<html><body><div id='article-body-preview'><div><p>Short preview only.</p></div></div>"
            "<div id='paywall-offer'>Subscribe to continue</div>"
            f"<script id='__NEXT_DATA__' type='application/json'>{__import__('json').dumps(payload)}</script>"
            "</body></html>"
        ).encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "nikkei",
        1000,
        5,
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body is not None
    assert body.count("<p>") == 5
    assert "market detail" in body
    assert "Subscribe to continue" not in body


def test_parser_specific_container_can_publish_short_non_paragraph_text() -> None:
    capture = _capture(
        "<html><div id='detail'><span>新华社短讯正文完整但很短，正文并不一定使用段落标签。</span></div></html>".encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "xinhua",
        20,
        1,
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body == "<p>新华社短讯正文完整但很短，正文并不一定使用段落标签。</p>"


def test_cls_telegraph_uses_structured_next_data_instead_of_comments() -> None:
    content = "财联社电，记者从有关部门了解到，本着稳妥可靠原则，经综合研判后任务不满足发射条件，不能在今年预定窗口实施。"
    payload = {
        "props": {
            "pageProps": {
                "articleDetail": {
                    "content": content,
                },
            },
        },
    }
    capture = _capture(
        (
            "<html><body><div class='new-comment'><p>这只是很长的用户评论，不应被当作正文。</p></div>"
            f"<script id='__NEXT_DATA__' type='application/json'>{__import__('json').dumps(payload)}</script>"
            "</body></html>"
        ).encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "cls",
        40,
        1,
    )

    succeeded, body = _capture_result(capture)

    assert succeeded is True
    assert body == f"<p>{content}</p>"
    assert "用户评论" not in body


def test_extraction_failure_is_retried_and_attempts_are_preserved() -> None:
    article = Article(
        id="example:one",
        title="Example article",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://example.test/one",
        published_at=NOW,
        source=SOURCE,
    )
    first = _capture(b"<html><article><p>Shell only</p></article></html>", status=200, error=None)
    full_paragraph = "Complete article paragraph with enough meaningful text. " * 20
    retry = _capture(
        f"<html><article>{''.join(f'<p>{full_paragraph}{index}</p>' for index in range(3))}</article></html>".encode(),
        status=200,
        error=None,
    )

    assert _needs_extraction_retry(article, first) is True
    merged = _merge_capture_attempts(first, retry)
    assert len(merged.exchanges) == 2
    assert merged.elapsed_ms == 20
    assert _needs_extraction_retry(article, merged) is False


def test_suspected_hard_paywall_is_retried_before_terminal_classification() -> None:
    article = Article(
        id="example:one",
        title="Example article",
        summary="Summary",
        body="Summary",
        content_status="summary",
        url="https://example.test/one",
        published_at=NOW,
        source=SOURCE,
    )
    capture = _capture(
        b'<html><div class="paywall">Subscribe to continue</div></html>',
        status=200,
        error=None,
    )

    assert _needs_extraction_retry(article, capture) is True


def test_reuters_fusion_content_wins_over_paywall_boilerplate() -> None:
    fusion = {
        "statusCode": 200,
        "message": "Success",
        "result": {
            "word_count": 42,
            "content_elements": [
                {"type": "paragraph", "content": "The first complete Reuters paragraph contains the actual report and enough words for validation."},
                {"type": "list", "items": [
                    {"type": "paragraph", "content": "The second Reuters paragraph is nested inside a structured list element and remains part of the story."},
                    {"type": "paragraph", "content": "The final Reuters paragraph completes the article with independently verifiable reporting details."},
                ]},
            ],
        },
    }
    body = (
        "<html><script>Fusion.globalContent="
        + __import__("json").dumps(fusion)
        + ";Fusion.globalContentConfig={};</script>"
        + '<div class="paywall"><p>The Reuters Daily Briefing newsletter provides all the news.</p></div></html>'
    ).encode()
    capture = _capture(body, status=200, error=None)
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "reuters",
    )

    succeeded, extracted = _capture_result(capture)

    assert succeeded is True
    assert extracted is not None
    assert extracted.count("<p>") == 3
    assert "Daily Briefing" not in extracted


def test_reuters_dom_boilerplate_is_not_misclassified_as_full_text() -> None:
    paragraphs = [
        "The Reuters Daily Briefing newsletter provides all the news you need to start your day.",
        "Reporting by Example Reporter and Editing by Example Editor. " * 8,
        "Our Standards: The Thomson Reuters Trust Principles. " * 8,
        "Based in Toronto, Bhargav reports on breaking news across the United States and Canada. " * 8,
    ]
    capture = _capture(
        f"<html><div data-testid='Body'>{''.join(f'<p>{paragraph}</p>' for paragraph in paragraphs)}</div></html>".encode(),
        status=200,
        error=None,
    )
    capture = ArticleCapture(
        capture.article_id,
        capture.source_id,
        capture.canonical_url,
        capture.title,
        capture.exchanges,
        capture.elapsed_ms,
        capture.error,
        "reuters",
    )

    _succeeded, extracted = _capture_result(capture)

    assert extracted is None


def test_original_page_body_wins_when_rendered_dom_loses_the_article() -> None:
    full_paragraph = "Complete article paragraph with enough meaningful text. " * 20
    original = _capture(
        f"<html><article>{''.join(f'<p>{full_paragraph}{index}</p>' for index in range(3))}</article></html>".encode(),
        status=200,
        error=None,
    )
    rendered_shell = _capture(b"<html><main><p>Access denied.</p></main></html>", status=403, error=None)
    combined = ArticleCapture(
        original.article_id,
        original.source_id,
        original.canonical_url,
        original.title,
        (*original.exchanges, *rendered_shell.exchanges),
        original.elapsed_ms + rendered_shell.elapsed_ms,
        None,
    )

    succeeded, extracted = _capture_result(combined)

    assert succeeded is True
    assert extracted is not None
    assert extracted.count("<p>") == 3


def test_structured_metered_metadata_alone_is_not_a_hard_paywall() -> None:
    capture = _capture(
        b'<html><script type="application/ld+json">{"isAccessibleForFree":false}</script>'
        b'<script>{"contentAccess":{"isMetered":true}}</script><article><p>Short preview.</p></article></html>',
        status=200,
        error=None,
    )

    assert _browser_failure_reason(capture.final_exchange) == "extraction-failed"


def test_rendered_dom_classification_wins_over_original_paywall_marker() -> None:
    original = _capture(
        b'<html><div class="paywall">Subscribe to continue</div></html>',
        status=200,
        error=None,
    ).final_exchange
    rendered = _capture(
        b"<html><article><p>Rendered shell without a terminal paywall marker.</p></article></html>",
        status=200,
        error=None,
    ).final_exchange
    assert original is not None
    assert rendered is not None
    capture = ArticleCapture(
        "example:one",
        SOURCE.id,
        "https://example.test/one",
        "Example article",
        (original, rendered),
        20,
        None,
    )

    assert _capture_failure_reason(capture) == "extraction-failed"
