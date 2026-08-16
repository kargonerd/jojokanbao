from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials

from ..core.auth import bearer
from ..core.errors import ApiError
from .dependencies import get_feature_flag_repository
from .models import FeatureEvaluationResponse
from .repository import SupabaseFeatureFlagRepository


router = APIRouter(prefix="/features", tags=["features"])
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_.]{2,79}$")


def requested_keys(raw: str) -> tuple[str, ...]:
    keys = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    if not keys or len(keys) > 50 or any(not KEY_PATTERN.fullmatch(key) for key in keys):
        raise ApiError(422, "invalid_feature_keys", "Feature keys are invalid")
    return keys


@router.get("/evaluations", response_model=FeatureEvaluationResponse)
async def evaluations(
    request: Request,
    response: Response,
    keys: str = Query(..., min_length=3, max_length=2000),
    visitor_id: str | None = Header(default=None, alias="X-JOJO-Visitor-ID"),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    repository: SupabaseFeatureFlagRepository = Depends(get_feature_flag_repository),
) -> FeatureEvaluationResponse | Response:
    parsed_keys = requested_keys(keys)
    if visitor_id:
        try:
            visitor_id = str(UUID(visitor_id))
        except ValueError as error:
            raise ApiError(422, "invalid_visitor_id", "Visitor id is invalid") from error
    token = credentials.credentials if credentials and credentials.scheme.lower() == "bearer" else None
    decisions = await repository.evaluate(parsed_keys, access_token=token, visitor_id=visitor_id)
    flags = {key: False for key in parsed_keys}
    revisions: dict[str, int] = {key: 0 for key in parsed_keys}
    for decision in decisions:
        if decision.key in flags:
            flags[decision.key] = decision.enabled
            revisions[decision.key] = decision.revision
    revision = hashlib.sha256(
        json.dumps({"flags": flags, "revisions": revisions}, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]
    etag = f'"{revision}"'
    cache_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=30",
        "Vary": "Authorization, X-JOJO-Visitor-ID",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)
    for name, value in cache_headers.items():
        response.headers[name] = value
    return FeatureEvaluationResponse(
        revision=revision,
        flags=flags,
        expiresAt=datetime.now(timezone.utc) + timedelta(seconds=30),
    )
