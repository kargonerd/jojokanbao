from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class FeatureDecision(BaseModel):
    key: str
    enabled: bool
    revision: int = Field(ge=0)


class FeatureEvaluationResponse(BaseModel):
    revision: str
    flags: dict[str, bool]
    expiresAt: datetime
