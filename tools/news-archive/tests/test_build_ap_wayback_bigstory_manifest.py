from __future__ import annotations

import httpx

from tools.build_ap_wayback_bigstory_manifest import fetch_bigstory_prefix


def test_fetches_wayback_bigstory_prefix_rows():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=[
                [
                    "timestamp",
                    "original",
                    "statuscode",
                    "mimetype",
                    "digest",
                    "length",
                ],
                [
                    "20120706031558",
                    "http://bigstory.ap.org/article/"
                    "aaron-scores-23-and-milwaukee-wins",
                    "200",
                    "text/html",
                    "DIGEST",
                    "10093",
                ],
            ],
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    rows, attempts = fetch_bigstory_prefix(
        http_client,
        prefix="a",
        from_year=2012,
        to_year=2012,
        limit=100_000,
        attempts=3,
    )

    assert attempts == 1
    assert rows[0]["digest"] == "DIGEST"
    query = requests[0].url.params
    assert query.get("url") == "bigstory.ap.org/article/a*"
    assert query.get("from") == "2012"
    assert query.get("to") == "2012"
    assert query.get("collapse") == "urlkey"
    http_client.close()


def test_rejects_invalid_bigstory_prefix():
    http_client = httpx.Client(transport=httpx.MockTransport(lambda request: None))
    try:
        fetch_bigstory_prefix(
            http_client,
            prefix="*",
            from_year=2012,
            to_year=2012,
            limit=10,
            attempts=1,
        )
    except ValueError as exc:
        assert "slug prefix" in str(exc)
    else:
        raise AssertionError("invalid prefix must fail closed")
    http_client.close()
