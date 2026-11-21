"""Same-origin Supabase proxy for readers on filtered mobile networks.

Mainland mobile carriers reset TLS to `*.supabase.co`, so browsers on those
networks cannot reach Auth or PostgREST at all. The reader origin forwards those
calls from the Shanghai cloud function, whose egress is not filtered.

Auth calls are re-signed with the project secret key. Supabase only honours
`Sb-Forwarded-For` for secret keys, and that header is what keeps GoTrue's
per-address rate limit meaningful instead of bucketing every reader behind the
function's single address. PostgREST calls keep the caller's publishable key and
JWT: re-signing them would run every request as `service_role` and disable row
level security.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
from typing import Mapping

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response

from ..core.config import Settings, get_settings

logger = logging.getLogger("jojo.platform_api.proxy")
router = APIRouter(tags=["proxy"])

AUTH_PREFIX = "auth/v1/"
# GoTrue's admin namespace is the only part of Auth that acts with service
# rights. Re-signing it would let any reader create or delete accounts.
AUTH_ADMIN_PREFIX = "auth/v1/admin"
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
UPSTREAM_TIMEOUT = httpx.Timeout(20.0, connect=5.0)

# Framing headers are rebuilt by httpx and Starlette; the body arrives decoded,
# so forwarding the original length or encoding would corrupt the message.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
})
# Only the address header stamped below may reach the project. Anything a
# reader sends here would let them pick their own rate-limit bucket.
_ADDRESS_HEADERS = frozenset({
    "sb-forwarded-for", "eo-connecting-ip", "x-forwarded-for", "x-real-ip",
})
# CORS and cookies belong to the reader origin; the body is already decoded.
_UPSTREAM_ONLY_RESPONSE = frozenset({
    "content-encoding", "content-length", "set-cookie",
    "access-control-allow-origin", "access-control-allow-credentials",
    "access-control-allow-headers", "access-control-allow-methods",
    "access-control-expose-headers", "access-control-max-age",
})


def client_ip(request: Request) -> str | None:
    """Return the address EdgeOne stamped, or None when it is unusable.

    Only the edge header is trusted. `X-Forwarded-For` keeps whatever the
    caller sent, so reading it would let a reader choose their own bucket.
    None is safe: the request then counts against the function's address.
    """
    candidate = request.headers.get("eo-connecting-ip")
    try:
        return str(ipaddress.ip_address((candidate or "").strip()))
    except ValueError:
        return None


def upstream_headers(request: Request, *, secret: str | None) -> dict[str, str]:
    headers = {
        name: value
        for name, value in request.headers.items()
        if name.lower() not in _HOP_BY_HOP and name.lower() not in _ADDRESS_HEADERS
    }
    if secret is None:
        return headers
    headers["apikey"] = secret
    ip = client_ip(request)
    if ip:
        headers["sb-forwarded-for"] = ip
    return headers


def browser_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP and name.lower() not in _UPSTREAM_ONLY_RESPONSE
    }


@router.get("/supabase/__probe/fast404", include_in_schema=False)
async def probe_fast404() -> Response:
    return Response(status_code=404, content=b"not found")


@router.get("/supabase/__probe/slow404", include_in_schema=False)
async def probe_slow404() -> Response:
    await asyncio.sleep(2)
    return Response(status_code=404, content=b"not found")


@router.get("/supabase/__probe/upstream404", include_in_schema=False)
async def probe_upstream404(settings: Settings = Depends(get_settings)) -> Response:
    upstream = await _send(
        "GET", f"{settings.supabase_url}/auth/v1/nope",
        headers={"apikey": settings.supabase_secret_key or ""}, content=None, params=[],
    )
    return Response(status_code=404, content=b"not found")


@router.get("/supabase/__probe/echo404", include_in_schema=False)
async def probe_echo404(settings: Settings = Depends(get_settings)) -> Response:
    upstream = await _send(
        "GET", f"{settings.supabase_url}/auth/v1/nope",
        headers={"apikey": settings.supabase_secret_key or ""}, content=None, params=[],
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=browser_headers(upstream.headers),
    )


@router.api_route("/supabase/{path:path}", methods=METHODS, include_in_schema=False)
async def proxy_supabase(
    path: str,
    request: Request,
    settings: Settings = Depends(get_settings),
) -> Response:
    is_auth = path.startswith(AUTH_PREFIX)
    if path.startswith(AUTH_ADMIN_PREFIX):
        # Answer exactly like a missing route: the proxy exists to be invisible,
        # and the caller has no legitimate reason to learn that it has a key.
        logger.warning("Rejected admin proxy request: %s /%s", request.method, path)
        return _error(404, "Not found")
    if not settings.supabase_url or (is_auth and not settings.supabase_secret_key):
        return _error(503, "账号服务尚未配置，请稍后重试。")
    try:
        upstream = await _send(
            request.method,
            f"{settings.supabase_url}/{path}",
            headers=upstream_headers(
                request,
                secret=settings.supabase_secret_key if is_auth else None,
            ),
            content=await request.body() or None,
            params=list(request.query_params.multi_items()),
        )
    except httpx.HTTPError:
        logger.warning("Supabase proxy request failed: %s /%s", request.method, path, exc_info=True)
        return _error(502, "暂时无法连接账号服务，请检查网络后重试。")
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=browser_headers(upstream.headers),
    )


async def _send(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    content: bytes | None,
    params: list[tuple[str, str]],
) -> httpx.Response:
    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT) as client:
        return await client.request(method, url, headers=headers, content=content, params=params)


def _error(status: int, message: str) -> JSONResponse:
    """GoTrue's error shape, so supabase-js surfaces the message verbatim."""
    return JSONResponse(
        {"code": status, "error_code": "proxy_unavailable", "msg": message},
        status_code=status,
    )
