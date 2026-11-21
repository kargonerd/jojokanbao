from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import app.proxy.router as proxy
from app.application import create_app
from app.core.config import Settings, get_settings


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "allowed_origins": ("https://reader.jojokanbao.cn",),
        "supabase_url": "https://project.supabase.co",
        "supabase_publishable_key": "publishable-key",
        "supabase_secret_key": "secret-key",
        "auth_timeout_seconds": 1.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def client(**overrides: object) -> TestClient:
    app = create_app()
    configured = settings(**overrides)
    app.dependency_overrides[get_settings] = lambda: configured
    return TestClient(app, raise_server_exceptions=False)


def capture(monkeypatch, response: httpx.Response | None = None) -> dict:
    seen: dict = {}

    async def send(method, url, *, headers, content, params):
        seen.update(method=method, url=url, headers=headers, content=content, params=params)
        return response or httpx.Response(200, content=b"{}", headers={"content-type": "application/json"})

    monkeypatch.setattr(proxy, "_send", send)
    return seen


def test_auth_calls_are_resigned_and_carry_the_edge_address(monkeypatch) -> None:
    seen = capture(monkeypatch)

    response = client().post(
        "/supabase/auth/v1/signup?redirect_to=https%3A%2F%2Freader.jojokanbao.cn",
        headers={
            "apikey": "publishable-key",
            "authorization": "Bearer reader-jwt",
            "sb-forwarded-for": "1.1.1.1",
            "eo-connecting-ip": "203.0.113.9",
        },
        content=b'{"email":"reader@example.com"}',
    )

    assert response.status_code == 200
    assert seen["method"] == "POST"
    assert seen["url"] == "https://project.supabase.co/auth/v1/signup"
    assert seen["params"] == [("redirect_to", "https://reader.jojokanbao.cn")]
    assert seen["content"] == b'{"email":"reader@example.com"}'
    assert seen["headers"]["apikey"] == "secret-key"
    assert seen["headers"]["sb-forwarded-for"] == "203.0.113.9"
    assert seen["headers"]["authorization"] == "Bearer reader-jwt"
    # The reader's own claim about their address never reaches the project.
    assert "1.1.1.1" not in seen["headers"].values()
    assert "eo-connecting-ip" not in seen["headers"]


def test_rest_calls_keep_the_caller_credentials(monkeypatch) -> None:
    seen = capture(monkeypatch)

    response = client().get(
        "/supabase/rest/v1/profiles?select=id",
        headers={"apikey": "publishable-key", "authorization": "Bearer reader-jwt"},
    )

    assert response.status_code == 200
    assert seen["url"] == "https://project.supabase.co/rest/v1/profiles"
    assert seen["headers"]["apikey"] == "publishable-key"
    assert seen["headers"]["authorization"] == "Bearer reader-jwt"
    assert "sb-forwarded-for" not in seen["headers"]


@pytest.mark.parametrize("address", ["", "not-an-ip", "1.2.3.4, 5.6.7.8"])
def test_only_a_parseable_address_is_forwarded(monkeypatch, address: str) -> None:
    seen = capture(monkeypatch)

    client().post(
        "/supabase/auth/v1/token",
        headers={"apikey": "publishable-key", "eo-connecting-ip": address},
    )

    # Falling back to the function's own address is safe: it tightens the
    # bucket instead of letting an unparsed value widen it.
    assert "sb-forwarded-for" not in seen["headers"]


def test_edge_address_wins_over_a_forwarded_chain() -> None:
    request = httpx.Request("GET", "https://reader.jojokanbao.cn/supabase/auth/v1/user")
    request.headers["x-forwarded-for"] = "203.0.113.9, 10.0.0.1"
    request.headers["eo-connecting-ip"] = "198.51.100.7"

    assert proxy.client_ip(request) == "198.51.100.7"


def test_forwarded_chain_is_never_trusted() -> None:
    request = httpx.Request("GET", "https://reader.jojokanbao.cn/supabase/auth/v1/user")
    request.headers["x-forwarded-for"] = "1.1.1.1, 198.51.100.7"

    # A caller controls this header; only the edge may name the bucket.
    assert proxy.client_ip(request) is None


def test_upstream_cors_and_cookies_stay_upstream(monkeypatch) -> None:
    capture(
        monkeypatch,
        httpx.Response(
            401,
            content=b'{"message":"bad"}',
            headers={
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "set-cookie": "__cf_bm=1; Domain=supabase.co",
                "transfer-encoding": "chunked",
            },
        ),
    )

    response = client().get("/supabase/auth/v1/user")

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/json"
    assert "access-control-allow-origin" not in response.headers
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("path", ["auth/v1/admin/users", "auth/v1/admin/generate_link"])
def test_admin_namespace_never_reaches_the_project(monkeypatch, path: str) -> None:
    seen = capture(monkeypatch)

    response = client().post(f"/supabase/{path}")

    # The proxy holds a service key; exposing GoTrue's admin namespace would
    # let any reader create or delete accounts through it. The reply matches a
    # missing route so the namespace stays indistinguishable.
    assert response.status_code == 410
    assert "代理" not in response.json()["msg"]
    assert seen == {}


def test_auth_calls_stop_looking_like_a_browser(monkeypatch) -> None:
    seen = capture(monkeypatch)

    client().post(
        "/supabase/auth/v1/token?grant_type=password",
        headers={
            "apikey": "publishable-key",
            "user-agent": "Mozilla/5.0 (Macintosh) Chrome/131.0",
        },
    )

    # Supabase rejects its own secret key when the caller claims to be a
    # browser, so the proxy must present a server identity.
    assert seen["headers"]["user-agent"] == proxy.PROXY_USER_AGENT
    assert seen["headers"]["apikey"] == "secret-key"


def test_rest_calls_keep_the_caller_user_agent(monkeypatch) -> None:
    seen = capture(monkeypatch)

    client().get("/supabase/rest/v1/profiles", headers={"user-agent": "reader/1.0"})

    assert seen["headers"]["user-agent"] == "reader/1.0"


def test_missing_upstream_path_answers_gone(monkeypatch) -> None:
    capture(monkeypatch, httpx.Response(404, content=b"404 page not found"))

    response = client().get("/supabase/auth/v1/nope")

    # The edge stalls a proxied 404; 410 is the closest delivered status.
    assert response.status_code == 410
    assert response.json()["msg"] == "Not found"


def test_auth_proxy_without_a_secret_is_unavailable(monkeypatch) -> None:
    seen = capture(monkeypatch)

    response = client(supabase_secret_key=None).post("/supabase/auth/v1/signup")

    assert response.status_code == 503
    assert response.json()["msg"].startswith("账号服务尚未配置")
    assert seen == {}


def test_unreachable_project_is_reported_in_supabase_shape(monkeypatch) -> None:
    async def send(*_args, **_kwargs):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(proxy, "_send", send)

    response = client().post("/supabase/auth/v1/signup")

    assert response.status_code == 502
    assert response.json()["msg"].startswith("暂时无法连接账号服务")


def test_preflight_allows_the_supabase_key_header(monkeypatch) -> None:
    # CORS is configured when the app is built, so it reads the process env.
    monkeypatch.setenv("JOJO_ALLOWED_ORIGINS", "https://reader.jojokanbao.cn")
    get_settings.cache_clear()
    try:
        response = client().options(
            "/supabase/auth/v1/token",
            headers={
                "origin": "https://reader.jojokanbao.cn",
                "access-control-request-method": "POST",
                "access-control-request-headers": "apikey,authorization,content-type",
            },
        )

        assert response.status_code == 200
        assert "apikey" in response.headers["access-control-allow-headers"]
    finally:
        get_settings.cache_clear()

