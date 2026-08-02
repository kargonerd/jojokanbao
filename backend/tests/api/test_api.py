from __future__ import annotations

import asyncio

import httpx
from fastapi.testclient import TestClient

from app.core.auth import SupabaseAuthClient, get_current_user
from app.core.config import Settings
from app.core.errors import AuthenticationError, ConfigurationError
from app.core.models import CurrentUser
from app.main import app


client = TestClient(app, raise_server_exceptions=False)


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "allowed_origins": ("https://reader.jojokanbao.cn",),
        "supabase_url": "https://project.supabase.co",
        "supabase_publishable_key": "publishable-key",
        "auth_timeout_seconds": 1.0,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_settings_reuse_root_supabase_environment(monkeypatch) -> None:
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://project.supabase.co/")
    monkeypatch.setenv("VITE_SUPABASE_PUBLISHABLE_KEY", " publishable-key ")

    configured = Settings.from_env()

    assert configured.supabase_url == "https://project.supabase.co"
    assert configured.supabase_publishable_key == "publishable-key"


def test_health_returns_stable_service_metadata_and_request_id() -> None:
    response = client.get("/v1/health", headers={"X-Request-ID": "health-check-1"})

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "jojo-platform-api",
    }
    assert response.headers["x-request-id"] == "health-check-1"
    assert response.headers["cache-control"] == "no-store"


def test_invalid_request_id_is_not_reflected() -> None:
    response = client.get("/v1/health", headers={"X-Request-ID": "bad request id!"})

    assert response.status_code == 200
    assert response.headers["x-request-id"] != "bad request id!"
    assert len(response.headers["x-request-id"]) == 32


def test_cors_preflight_allows_configured_local_origin() -> None:
    response = client.options(
        "/v1/me",
        headers={
            "Origin": "http://localhost:8081",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:8081"
    assert "access-control-allow-credentials" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"]


def test_unknown_routes_use_the_stable_error_envelope() -> None:
    response = client.get("/v1/missing", headers={"X-Request-ID": "missing-1"})

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "Resource not found",
            "request_id": "missing-1",
        }
    }
    assert response.headers["x-request-id"] == "missing-1"


def test_unexpected_errors_keep_cors_and_response_headers() -> None:
    async def fail() -> CurrentUser:
        raise RuntimeError("boom")

    app.dependency_overrides[get_current_user] = fail
    try:
        response = client.get(
            "/v1/me",
            headers={"Origin": "http://localhost:8081", "X-Request-ID": "failure-1"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert response.json()["error"]["request_id"] == "failure-1"
    assert response.headers["access-control-allow-origin"] == "http://localhost:8081"
    assert response.headers["x-request-id"] == "failure-1"
    assert response.headers["cache-control"] == "no-store"


def test_me_requires_bearer_token() -> None:
    response = client.get("/v1/me")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["error"]["code"] == "unauthorized"
    assert response.json()["error"]["request_id"] == response.headers["x-request-id"]


def test_me_returns_sanitized_current_user() -> None:
    async def fake_current_user() -> CurrentUser:
        return CurrentUser(
            id="user-123",
            email="reader@example.com",
            role="authenticated",
            aud="authenticated",
            app_metadata={"provider": "email"},
            user_metadata={"display_name": "Reader"},
        )

    app.dependency_overrides[get_current_user] = fake_current_user
    try:
        response = client.get("/v1/me")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {
        "id": "user-123",
        "email": "reader@example.com",
        "role": "authenticated",
        "aud": "authenticated",
        "app_metadata": {"provider": "email"},
        "user_metadata": {"display_name": "Reader"},
    }


def test_supabase_client_validates_access_token_remotely() -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://project.supabase.co/auth/v1/user"
        assert request.headers["apikey"] == "publishable-key"
        assert request.headers["authorization"] == "Bearer valid-token"
        return httpx.Response(
            200,
            json={
                "id": "user-456",
                "email": "press@example.com",
                "role": "authenticated",
                "unexpected_secret": "not returned",
            },
        )

    auth = SupabaseAuthClient(settings(), transport=httpx.MockTransport(upstream))
    user = asyncio.run(auth.get_user("valid-token"))

    assert user.id == "user-456"
    assert user.email == "press@example.com"
    assert not hasattr(user, "unexpected_secret")


def test_supabase_client_rejects_expired_token() -> None:
    transport = httpx.MockTransport(lambda _request: httpx.Response(401, json={"message": "expired"}))
    auth = SupabaseAuthClient(settings(), transport=transport)

    try:
        asyncio.run(auth.get_user("expired-token"))
    except AuthenticationError as error:
        assert error.code == "unauthorized"
    else:
        raise AssertionError("AuthenticationError was not raised")


def test_supabase_configuration_is_required_only_for_protected_routes() -> None:
    missing = settings(supabase_url=None, supabase_publishable_key=None)

    try:
        SupabaseAuthClient(missing)
    except ConfigurationError as error:
        assert error.code == "service_not_configured"
    else:
        raise AssertionError("ConfigurationError was not raised")


def test_production_requires_explicit_cors_origins(monkeypatch) -> None:
    monkeypatch.setenv("JOJO_ENV", "production")
    monkeypatch.delenv("JOJO_ALLOWED_ORIGINS", raising=False)

    try:
        Settings.from_env()
    except RuntimeError as error:
        assert str(error) == "JOJO_ALLOWED_ORIGINS is required in production"
    else:
        raise AssertionError("RuntimeError was not raised")


def test_settings_reject_invalid_environment_and_origin(monkeypatch) -> None:
    monkeypatch.setenv("JOJO_ENV", "prod")
    try:
        Settings.from_env()
    except RuntimeError as error:
        assert "JOJO_ENV must be one of" in str(error)
    else:
        raise AssertionError("RuntimeError was not raised")

    monkeypatch.setenv("JOJO_ENV", "production")
    monkeypatch.setenv("JOJO_ALLOWED_ORIGINS", "reader.jojokanbao.cn/path")
    try:
        Settings.from_env()
    except RuntimeError as error:
        assert str(error) == "Invalid JOJO_ALLOWED_ORIGINS entry: reader.jojokanbao.cn/path"
    else:
        raise AssertionError("RuntimeError was not raised")
