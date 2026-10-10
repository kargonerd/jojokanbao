import time
from unittest.mock import patch

import jwt
import pytest
from flask import Flask, jsonify

from admin_auth import ACCESS_COOKIE, REFRESH_COOKIE, AdminAuthError, install_admin_auth


def make_app():
    app = Flask(__name__)
    install_admin_auth(app)
    for path in ("/api/content/jobs", "/api/es-repair/status", "/api/moderation/comments", "/api/agent/credentials/status", "/api/content/import-paths"):
        app.add_url_rule(path, path, lambda: jsonify(success=True), methods=["GET", "POST"])
    return app


@pytest.fixture(autouse=True)
def no_ambient_jwt_configuration(monkeypatch):
    # Keep auth tests hermetic even when the developer's root .env configures a JWT secret.
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.delenv("VITE_SUPABASE_URL", raising=False)


def local_token(roles, secret="jwt-secret", **claims):
    now = int(time.time())
    payload = {
        "iss": "https://project.supabase.co/auth/v1",
        "aud": "authenticated",
        "sub": "staff-1",
        "email": "staff@example.invalid",
        "exp": now + 600,
        "iat": now,
        "app_metadata": {"jojo_roles": roles},
    }
    payload.update(claims)
    return jwt.encode(payload, secret, algorithm="HS256")


def configure_local_verification(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "jwt-secret")
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://project.supabase.co")


def staff(roles=None):
    return {"id":"staff", "email":"staff@example.invalid", "app_metadata":{"jojo_roles":roles or ["admin"]}}


@pytest.mark.parametrize("roles,allowed", [(["admin"], [True]*5), (["librarian"], [True,False,False,False,False]), (["moderator"],[False,False,True,False,False])])
def test_staff_cannot_call_other_roles_operations(roles, allowed):
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE, "session")
    with patch("admin_auth.auth_request", return_value=staff(roles)):
        for path, permitted in zip(("/api/content/jobs", "/api/es-repair/status", "/api/moderation/comments", "/api/agent/credentials/status", "/api/content/import-paths"), allowed):
            assert client.get(path).status_code == (200 if permitted else 403)


def test_missing_session_and_user_editable_roles_cannot_enter():
    client = make_app().test_client()
    assert client.get("/api/content/jobs").status_code == 401
    client.set_cookie(ACCESS_COOKIE, "session")
    with patch("admin_auth.auth_request", return_value={"id":"reader", "user_metadata":{"jojo_roles":["admin"]}}):
        assert client.get("/api/content/jobs").status_code == 403


def test_login_keeps_tokens_in_http_only_cookies_and_returns_permissions():
    client = make_app().test_client()
    session = {"access_token":"access-secret", "refresh_token":"refresh-secret", "user": staff(["librarian"])}
    with patch("admin_auth.auth_request", return_value=session) as request:
        response = client.post("/api/auth/login", json={"email":"staff@example.invalid","password":"password-secret"}, headers={"Origin":"http://localhost:5000"})
    assert response.status_code == 200
    assert response.json["user"]["permissions"] == ["library"]
    assert "secret" not in response.text
    assert all("HttpOnly" in value and "SameSite=Strict" in value for value in response.headers.getlist("Set-Cookie"))
    assert request.call_count == 1


def test_foreign_origin_and_dns_rebinding_are_rejected_before_auth():
    client = make_app().test_client()
    with patch("admin_auth.auth_request") as request:
        assert client.post("/api/auth/login",json={},headers={"Origin":"https://evil.example"}).status_code == 403
        assert client.get("/api/content/jobs",headers={"Host":"evil.example"}).status_code == 403
        assert client.get("/api/content/jobs",headers={"Sec-Fetch-Site":"cross-site"}).status_code == 403
        assert client.post("/api/content/jobs",json={}).status_code == 403
    request.assert_not_called()


def test_expired_session_refreshes_and_checks_current_role():
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE,"expired")
    client.set_cookie(REFRESH_COOKIE,"refresh")
    with patch("admin_auth.auth_request", side_effect=[AdminAuthError("expired"), {"access_token":"new", "refresh_token":"rotated"}, staff()]):
        response = client.get("/api/auth/session")
    assert response.status_code == 200
    assert any("rotated" in value for value in response.headers.getlist("Set-Cookie"))
    with patch("admin_auth.auth_request", return_value={"id":"staff","app_metadata":{"jojo_roles":[]}}):
        assert client.get("/api/content/jobs").status_code == 403


def test_logout_clears_only_the_current_session():
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE,"access")
    with patch("admin_auth.auth_request", return_value={}) as request:
        response = client.post("/api/auth/logout",headers={"Origin":"http://localhost:5000"})
    assert response.status_code == 200
    assert request.call_args.args[1] == "logout?scope=local"
    assert all("Max-Age=0" in value for value in response.headers.getlist("Set-Cookie"))


def test_local_jwt_verification_resolves_the_session_without_remote_calls(monkeypatch):
    configure_local_verification(monkeypatch)
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE, local_token(["librarian"]))
    with patch("admin_auth.auth_request", side_effect=AssertionError("remote calls are not expected")):
        response = client.get("/api/auth/session")
    assert response.status_code == 200
    assert response.json["user"]["permissions"] == ["library"]


def test_expired_local_token_refreshes_into_a_verifiable_session(monkeypatch):
    configure_local_verification(monkeypatch)
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE, local_token(["admin"], exp=int(time.time()) - 60))
    client.set_cookie(REFRESH_COOKIE, "refresh")
    refreshed = {"access_token": local_token(["admin"]), "refresh_token": "rotated"}
    with patch("admin_auth.auth_request", return_value=refreshed) as request:
        response = client.get("/api/auth/session")
    assert response.status_code == 200
    assert any("rotated" in value for value in response.headers.getlist("Set-Cookie"))
    assert request.call_count == 1


def test_local_tokens_with_unknown_signatures_are_rejected(monkeypatch):
    configure_local_verification(monkeypatch)
    client = make_app().test_client()
    client.set_cookie(ACCESS_COOKIE, local_token(["admin"], secret="attacker-secret"))
    with patch("admin_auth.auth_request", side_effect=AssertionError("remote calls are not expected")):
        response = client.get("/api/content/jobs")
    assert response.status_code == 401
