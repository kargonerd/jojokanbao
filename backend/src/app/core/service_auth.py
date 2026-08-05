from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from collections.abc import Mapping
from threading import Lock
from typing import Any

from fastapi import Request

from .config import Settings
from .errors import AuthenticationError, ConfigurationError


SIGNATURE_VERSION = "jojo-agent-service-v1"
MAX_CLOCK_SKEW_SECONDS = 60
TIMESTAMP_HEADER = "X-JOJO-Service-Timestamp"
NONCE_HEADER = "X-JOJO-Service-Nonce"
SIGNATURE_HEADER = "X-JOJO-Service-Signature"
CONVERSATION_HEADER = "Makers-Conversation-Id"

_consumed_nonces: dict[str, int] = {}
_nonce_lock = Lock()


def _base64_url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def _payload(
    *,
    body: Any,
    conversation_id: str,
    method: str,
    nonce: str,
    timestamp: str,
) -> bytes:
    body_digest = _base64_url(hashlib.sha256(_canonical_json(body).encode()).digest())
    return "\n".join(
        (
            SIGNATURE_VERSION,
            timestamp,
            nonce,
            method.upper(),
            conversation_id,
            body_digest,
        )
    ).encode()


def create_service_headers(
    *,
    body: Any,
    conversation_id: str,
    method: str,
    secret: str,
    now: float | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    timestamp = str(int(now if now is not None else time.time()))
    resolved_nonce = nonce or uuid.uuid4().hex
    signature = hmac.new(
        secret.encode(),
        _payload(
            body=body,
            conversation_id=conversation_id,
            method=method,
            nonce=resolved_nonce,
            timestamp=timestamp,
        ),
        hashlib.sha256,
    ).digest()
    return {
        TIMESTAMP_HEADER: timestamp,
        NONCE_HEADER: resolved_nonce,
        SIGNATURE_HEADER: _base64_url(signature),
        CONVERSATION_HEADER: conversation_id,
    }


def _consume_nonce(nonce: str, now: int) -> bool:
    with _nonce_lock:
        expired = [value for value, expires_at in _consumed_nonces.items() if expires_at <= now]
        for value in expired:
            _consumed_nonces.pop(value, None)
        if nonce in _consumed_nonces:
            return False
        _consumed_nonces[nonce] = now + MAX_CLOCK_SKEW_SECONDS * 2
        return True


async def authorize_service_request(
    request: Request,
    settings: Settings,
    body: Mapping[str, Any],
) -> None:
    try:
        secret = settings.require_agent_service_secret()
    except RuntimeError as error:
        raise ConfigurationError(str(error)) from error

    timestamp = request.headers.get(TIMESTAMP_HEADER, "")
    nonce = request.headers.get(NONCE_HEADER, "")
    encoded_signature = request.headers.get(SIGNATURE_HEADER, "")
    conversation_id = request.headers.get(CONVERSATION_HEADER, "")
    try:
        timestamp_seconds = int(timestamp)
        signature = base64.urlsafe_b64decode(
            encoded_signature + "=" * (-len(encoded_signature) % 4)
        )
    except (ValueError, TypeError):
        raise AuthenticationError("Trusted service authentication required") from None

    now = int(time.time())
    if (
        abs(now - timestamp_seconds) > MAX_CLOCK_SKEW_SECONDS
        or re.fullmatch(r"[0-9A-Za-z_-]{22,64}", nonce) is None
        or not conversation_id
    ):
        raise AuthenticationError("Trusted service authentication required")

    expected = hmac.new(
        secret.encode(),
        _payload(
            body=body,
            conversation_id=conversation_id,
            method=request.method,
            nonce=nonce,
            timestamp=timestamp,
        ),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected) or not _consume_nonce(nonce, now):
        raise AuthenticationError("Trusted service authentication required")
