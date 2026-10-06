from __future__ import annotations

import time

import jwt
from fastapi.testclient import TestClient

from app.core.auth import decode_access_token, get_current_user
from app.core.config import Settings, get_settings
from app.core.errors import AuthenticationError, ConfigurationError
from app.core.models import CurrentUser
from app.main import app


client = TestClient(app, raise_server_exceptions=False)

SECRET = "test-secret"


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "allowed_origins": ("https://reader.jojokanbao.cn",),
        "supabase_url": "https://project.supabase.co",
        "supabase_publishable_key": "publishable-key",
        "auth_timeout_seconds": 1.0,
        "supabase_jwt_secret": SECRET,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def make_token(**claim_overrides: object) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "iss": "https://project.supabase.co/auth/v1",
        "aud": "authenticated",
        "sub": "user-789",
        "email": "editor@example.com",
        "role": "authenticated",
        "exp": now + 600,
        "iat": now,
        "app_metadata": {"jojo_roles": ["librarian"]},
        "user_metadata": {"display_name": "Editor"},
    }
    claims.update(claim_overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


def expect_authentication_error(token: str, **overrides: object) -> None:
    try:
        decode_access_token(token, settings(**overrides))
    except AuthenticationError as error:
        assert error.code == "unauthorized"
    else:
        raise AssertionError("AuthenticationError was not raised")


def test_decode_maps_supabase_claims_to_current_user() -> None:
    user = decode_access_token(make_token(), settings())

    assert user.id == "user-789"
    assert user.email == "editor@example.com"
    assert user.role == "authenticated"
    assert user.aud == "authenticated"
    assert user.app_metadata == {"jojo_roles": ["librarian"]}
    assert user.user_metadata == {"display_name": "Editor"}


def test_decode_rejects_expired_token() -> None:
    expect_authentication_error(make_token(exp=int(time.time()) - 120))


def test_decode_rejects_wrong_audience() -> None:
    expect_authentication_error(make_token(aud="anon"))


def test_decode_rejects_wrong_issuer() -> None:
    expect_authentication_error(make_token(iss="https://evil.example.com/auth/v1"))


def test_decode_rejects_unsigned_token() -> None:
    now = int(time.time())
    claims = {
        "iss": "https://project.supabase.co/auth/v1",
        "aud": "authenticated",
        "sub": "user-789",
        "exp": now + 600,
    }
    expect_authentication_error(jwt.encode(claims, key=None, algorithm="none"))


def test_decode_rejects_tampered_signature() -> None:
    token = make_token()
    head, body, signature = token.split(".")
    tampered = signature[:-2] + ("aa" if signature[-2:] != "aa" else "bb")
    expect_authentication_error(f"{head}.{body}.{tampered}")


def test_decode_requires_configured_secret() -> None:
    try:
        decode_access_token(make_token(), settings(supabase_jwt_secret=None))
    except ConfigurationError as error:
        assert error.code == "service_not_configured"
    else:
        raise AssertionError("ConfigurationError was not raised")


def test_get_current_user_verifies_token_locally_when_secret_configured() -> None:
    app.dependency_overrides[get_settings] = lambda: settings()
    try:
        response = client.get("/v1/me", headers={"Authorization": f"Bearer {make_token()}"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "user-789"
    assert body["email"] == "editor@example.com"
    assert body["app_metadata"] == {"jojo_roles": ["librarian"]}


def test_get_current_user_falls_back_to_remote_without_secret(monkeypatch) -> None:
    seen: dict[str, str] = {}

    class StubClient:
        def __init__(self, _settings: Settings) -> None:
            pass

        async def get_user(self, access_token: str) -> CurrentUser:
            seen["token"] = access_token
            return CurrentUser(id="remote-user", email="press@example.com")

    monkeypatch.setattr("app.core.auth.SupabaseAuthClient", StubClient)
    app.dependency_overrides[get_settings] = lambda: settings(supabase_jwt_secret=None)
    try:
        response = client.get("/v1/me", headers={"Authorization": "Bearer remote-token"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["id"] == "remote-user"
    assert seen["token"] == "remote-token"
