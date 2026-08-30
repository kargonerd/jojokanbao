from tools.probe_alternate_archive_sources import (
    classify_response,
    source_url,
)


CANONICAL_URL = "https://www.wsj.com/articles/example-1483563379"


def test_archive_today_requires_snapshot_redirect():
    blocked, available, evidence = classify_response(
        "archive-today",
        CANONICAL_URL,
        status=200,
        final_url="https://archive.ph/AbC12",
        content=b"<html><article>" + (b"full text " * 300) + b"</article></html>",
    )

    assert blocked is False
    assert available is True
    assert evidence == "snapshot-replay"


def test_archive_today_rejects_captcha_even_on_snapshot_url():
    blocked, available, evidence = classify_response(
        "archive-today",
        CANONICAL_URL,
        status=200,
        final_url="https://archive.ph/AbC12",
        content=b"<html>Security verification CAPTCHA</html>",
    )

    assert blocked is True
    assert available is False
    assert evidence == "blocked-or-http-error"


def test_jina_reader_rejects_subscription_shell():
    blocked, available, evidence = classify_response(
        "jina-reader",
        CANONICAL_URL,
        status=200,
        final_url=source_url("jina-reader", CANONICAL_URL),
        content=b"WSJ subscription: Sign in to continue reading" + (b" " * 3000),
    )

    assert blocked is False
    assert available is False
    assert evidence == "reader-shell"


def test_ghostarchive_requires_matching_archive_link():
    blocked, available, evidence = classify_response(
        "ghostarchive",
        CANONICAL_URL,
        status=200,
        final_url=source_url("ghostarchive", CANONICAL_URL),
        content=(
            f'<html><a href="/archive/AbC123">{CANONICAL_URL}</a></html>'
        ).encode(),
    )

    assert blocked is False
    assert available is True
    assert evidence == "matching-archive-link"
