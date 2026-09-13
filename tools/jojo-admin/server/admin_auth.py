"""JOJO account sessions for the local admin workbench."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv
from flask import Blueprint, g, jsonify, request


auth_blueprint = Blueprint("admin_auth", __name__)
ACCESS_COOKIE = "jojo_admin_access"
REFRESH_COOKIE = "jojo_admin_refresh"
DEFAULT_ORIGINS = {
    "http://127.0.0.1:4174", "http://localhost:4174",
    "http://127.0.0.1:5000", "http://localhost:5000",
}
ROLE_PERMISSIONS = {
    "admin": {"library", "moderation", "operations", "agent"},
    "librarian": {"library"},
    "moderator": {"moderation"},
}


def permissions_for(user):
    metadata = user.get("app_metadata") if isinstance(user, dict) else None
    roles = metadata.get("jojo_roles") if isinstance(metadata, dict) else None
    if not isinstance(roles, list):
        return set()
    return set().union(*(ROLE_PERMISSIONS.get(role, set()) for role in roles if isinstance(role, str)))


def public_user(user):
    return {"id": user["id"], "email": user.get("email", ""), "permissions": sorted(permissions_for(user))}


def required_permission(path):
    if path == "/api/content/import-paths":
        return "operations"
    if path.startswith("/api/content/"):
        return "library"
    if path.startswith("/api/moderation/"):
        return "moderation"
    if path.startswith("/api/agent/"):
        return "agent"
    if path == "/api/auth/session":
        return None
    return "operations"


class AdminAuthError(Exception):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


def auth_request(method: str, path: str, *, token: str = "", body=None):
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    base = os.getenv("VITE_SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not base or not key:
        raise AdminAuthError("请配置 Supabase 账号服务。", 503)
    try:
        response = requests.request(method, f"{base}/auth/v1/{path}",
            headers={"apikey": key, **({"Authorization": f"Bearer {token}"} if token else {})},
            json=body, timeout=10)
        if response.status_code in (400, 401, 403, 422):
            raise AdminAuthError("登录已失效或账号密码不正确，请重新登录。")
        if response.status_code == 429:
            raise AdminAuthError("登录尝试过于频繁，请稍后重试。", 429)
        if not response.ok:
            raise AdminAuthError("账号服务暂时不可用，请稍后重试。", 503)
        return response.json() if response.content else {}
    except (requests.RequestException, ValueError) as error:
        raise AdminAuthError("无法连接账号服务，请稍后重试。", 503) from error


def require_admin_user(user):
    if not isinstance(user, dict) or not isinstance(user.get("id"), str):
        raise AdminAuthError("账号服务返回了无效数据。", 503)
    if not permissions_for(user):
        raise AdminAuthError("这个账号没有管理台权限。", 403)
    return user


def validate_admin_session():
    token = request.cookies.get(ACCESS_COOKIE, "")
    refresh = request.cookies.get(REFRESH_COOKIE, "")
    try:
        if not token:
            raise AdminAuthError("请先登录管理台。")
        user = auth_request("GET", "user", token=token)
    except AdminAuthError as error:
        if error.status != 401 or not refresh:
            raise
        session = auth_request("POST", "token?grant_type=refresh_token", body={"refresh_token": refresh})
        token = session.get("access_token", "")
        if not token or not session.get("refresh_token"):
            raise AdminAuthError("账号服务返回了无效数据。", 503)
        # Always verify the live role, including after a session refresh.
        user = auth_request("GET", "user", token=token)
        g.admin_new_session = session
    g.admin_user = require_admin_user(user)
    g.admin_access_token = token


def _allowed_origins():
    configured = os.getenv("JOJO_ADMIN_ORIGIN", "").strip().rstrip("/")
    return {configured} if configured else DEFAULT_ORIGINS


def install_admin_auth(app):
    app.register_blueprint(auth_blueprint)

    @app.before_request
    def protect_admin_api():
        if not request.path.startswith("/api/") or request.path == "/api/health":
            return None
        # Reject foreign origins for every API method, including local file reads
        # and actions implemented by existing GET routes. No CORS is enabled.
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in _allowed_origins():
            return jsonify(success=False, message="请求来源不受信任。"), 403
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(success=False, message="请从管理台页面发起操作。"), 403
        if request.method not in {"GET", "HEAD", "OPTIONS"} and not origin:
            return jsonify(success=False, message="管理操作需要有效的页面来源。"), 403
        # An unexpected Host must never authorize a DNS-rebound local endpoint.
        host = urlsplit(request.host_url).hostname
        allowed_hosts = {urlsplit(value).hostname for value in _allowed_origins()}
        if host not in allowed_hosts:
            return jsonify(success=False, message="管理台访问地址无效。"), 403
        if request.path in {"/api/auth/login", "/api/auth/logout"}:
            return None
        try:
            validate_admin_session()
            permission = required_permission(request.path)
            if permission and permission not in permissions_for(g.admin_user):
                raise AdminAuthError("你的账号没有执行这项操作的权限。", 403)
        except AdminAuthError as error:
            return jsonify(success=False, message=str(error)), error.status
        return None

    @app.after_request
    def session_headers(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "private, no-store"
        session = getattr(g, "admin_new_session", None)
        if session:
            for cookie, field in ((ACCESS_COOKIE, "access_token"), (REFRESH_COOKIE, "refresh_token")):
                response.set_cookie(cookie, session[field], httponly=True, secure=request.is_secure,
                    samesite="Strict", path="/api", max_age=30 * 24 * 3600)
        if getattr(g, "admin_clear_session", False):
            response.delete_cookie(ACCESS_COOKIE, path="/api")
            response.delete_cookie(REFRESH_COOKIE, path="/api")
        return response


@auth_blueprint.post("/api/auth/login")
def login():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("email"), str) or not isinstance(body.get("password"), str):
        return jsonify(success=False, message="请输入邮箱和密码。"), 400
    if not 3 <= len(body["email"]) <= 254 or not 1 <= len(body["password"]) <= 1024:
        return jsonify(success=False, message="请输入有效的邮箱和密码。"), 400
    try:
        session = auth_request("POST", "token?grant_type=password", body={
            "email": body["email"].strip(), "password": body["password"],
        })
        token = session.get("access_token")
        if not token or not session.get("refresh_token"):
            raise AdminAuthError("账号服务返回了无效数据。", 503)
        user = require_admin_user(auth_request("GET", "user", token=token))
        g.admin_new_session = session
        return jsonify(success=True, user=public_user(user))
    except AdminAuthError as error:
        g.admin_clear_session = True
        return jsonify(success=False, message=str(error)), error.status


@auth_blueprint.get("/api/auth/session")
def session():
    return jsonify(success=True, user=public_user(g.admin_user))


@auth_blueprint.post("/api/auth/logout")
def logout():
    token = request.cookies.get(ACCESS_COOKIE)
    if token:
        try:
            auth_request("POST", "logout?scope=local", token=token)
        except AdminAuthError:
            pass
    g.admin_clear_session = True
    return jsonify(success=True)
