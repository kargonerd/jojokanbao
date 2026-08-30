from __future__ import annotations

import json

import httpx

from tools.build_ap_wayback_yahoo_manifest import fetch_yahoo_month


def test_fetches_wayback_yahoo_month_as_partner_rows():
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
                    "20100104083044",
                    "http://news.yahoo.com:80/s/ap/20100101/"
                    "ap_en_ce/us_limbaugh_hospital",
                    "200",
                    "text/html",
                    "DIGEST",
                    "17216",
                ],
            ],
            request=request,
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    rows, attempts = fetch_yahoo_month(
        http_client,
        year=2010,
        month=1,
        limit=100_000,
        attempts=3,
    )

    assert attempts == 1
    assert rows == [
        {
            "timestamp": "20100104083044",
            "original": (
                "http://news.yahoo.com:80/s/ap/20100101/"
                "ap_en_ce/us_limbaugh_hospital"
            ),
            "statuscode": "200",
            "mimetype": "text/html",
            "digest": "DIGEST",
            "length": "17216",
        }
    ]
    query = requests[0].url.params
    assert query.get("url") == "news.yahoo.com/s/ap/201001*"
    assert query.get("collapse") == "urlkey"
    assert query.get_list("filter") == [
        "statuscode:200",
        "mimetype:text/html",
    ]
    assert json.loads(requests[0].content or b"null") is None
    http_client.close()


def test_rejects_malformed_wayback_cdx_table():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"not": "a table"}, request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        fetch_yahoo_month(
            http_client,
            year=2010,
            month=1,
            limit=10,
            attempts=1,
        )
    except RuntimeError as exc:
        assert "failed in both monthly and daily query modes" in str(exc)
    else:
        raise AssertionError("malformed CDX payload must fail closed")
    http_client.close()


def test_falls_back_to_daily_queries_when_month_payload_is_malformed():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        prefix = request.url.params["url"]
        if prefix == "news.yahoo.com/s/ap/201002*":
            return httpx.Response(
                200,
                json={"error": "query too large"},
                request=request,
            )
        if prefix == "news.yahoo.com/s/ap/20100201*":
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
                        "20100201120000",
                        "http://news.yahoo.com/s/ap/20100201/ap_story",
                        "200",
                        "text/html",
                        "DIGEST",
                        "1000",
                    ],
                ],
                request=request,
            )
        return httpx.Response(200, json=[], request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    rows, attempts = fetch_yahoo_month(
        http_client,
        year=2010,
        month=2,
        limit=100_000,
        attempts=1,
    )

    assert attempts == 29
    assert len(rows) == 1
    assert rows[0]["digest"] == "DIGEST"
    assert len(requests) == 29
    assert requests[-1].url.params["url"] == "news.yahoo.com/s/ap/20100228*"
    http_client.close()


def test_accepts_empty_wayback_result_table():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[], request=request)

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    rows, attempts = fetch_yahoo_month(
        http_client,
        year=2012,
        month=1,
        limit=10,
        attempts=1,
    )

    assert rows == []
    assert attempts == 1
    http_client.close()
