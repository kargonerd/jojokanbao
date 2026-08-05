from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlsplit


VALID_ENVIRONMENTS = frozenset({"development", "preview", "production", "test"})
DEFAULT_LOCAL_ORIGINS = (
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8081",
    "http://localhost:8080",
    "http://localhost:8081",
)


def _origins(value: str | None) -> tuple[str, ...]:
    if value is None:
        return DEFAULT_LOCAL_ORIGINS
    origins = tuple(dict.fromkeys(origin.strip().rstrip("/") for origin in value.split(",") if origin.strip()))
    for origin in origins:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            raise RuntimeError(f"Invalid JOJO_ALLOWED_ORIGINS entry: {origin}")
    return origins


def _positive_float(value: str | None, default: float, name: str) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a number") from error
    if parsed <= 0:
        raise RuntimeError(f"{name} must be greater than zero")
    return parsed


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str
    allowed_origins: tuple[str, ...]
    supabase_url: str | None
    supabase_publishable_key: str | None
    auth_timeout_seconds: float
    agent_internal_url: str | None = None
    agent_service_secret: str | None = None
    agent_timeout_seconds: float = 120.0
    rag_document_path: str | None = None
    rag_document_url: str | None = None
    rag_document_title: str = "革命造反年代：上海文革运动史稿 I"

    @classmethod
    def from_env(cls) -> Settings:
        environment = os.getenv("JOJO_ENV", "development").strip() or "development"
        if environment not in VALID_ENVIRONMENTS:
            raise RuntimeError(f"JOJO_ENV must be one of: {', '.join(sorted(VALID_ENVIRONMENTS))}")
        configured_origins = os.getenv("JOJO_ALLOWED_ORIGINS")
        if environment == "production" and not configured_origins:
            raise RuntimeError("JOJO_ALLOWED_ORIGINS is required in production")

        return cls(
            environment=environment,
            allowed_origins=_origins(configured_origins),
            supabase_url=(os.getenv("VITE_SUPABASE_URL") or "").strip().rstrip("/") or None,
            supabase_publishable_key=(os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY") or "").strip() or None,
            auth_timeout_seconds=_positive_float(
                os.getenv("JOJO_AUTH_TIMEOUT_SECONDS"),
                default=5.0,
                name="JOJO_AUTH_TIMEOUT_SECONDS",
            ),
            agent_internal_url=(os.getenv("JOJO_AGENT_INTERNAL_URL") or "").strip() or None,
            agent_service_secret=(os.getenv("JOJO_AGENT_SERVICE_SECRET") or "").strip() or None,
            agent_timeout_seconds=_positive_float(
                os.getenv("JOJO_AGENT_TIMEOUT_SECONDS"),
                default=120.0,
                name="JOJO_AGENT_TIMEOUT_SECONDS",
            ),
            rag_document_path=(os.getenv("JOJO_RAG_DOCUMENT_PATH") or "").strip() or None,
            rag_document_url=(os.getenv("JOJO_RAG_DOCUMENT_URL") or "").strip() or None,
            rag_document_title=(
                os.getenv("JOJO_RAG_DOCUMENT_TITLE")
                or "革命造反年代：上海文革运动史稿 I"
            ).strip(),
        )

    def require_supabase(self) -> tuple[str, str]:
        if not self.supabase_url or not self.supabase_publishable_key:
            raise RuntimeError("Supabase authentication is not configured")
        return self.supabase_url, self.supabase_publishable_key

    def require_agent(self) -> tuple[str, str]:
        if not self.agent_internal_url:
            raise RuntimeError("JOJO_AGENT_INTERNAL_URL is not configured")
        return self.agent_internal_url, self.require_agent_service_secret()

    def require_agent_service_secret(self) -> str:
        if not self.agent_service_secret or len(self.agent_service_secret) < 32:
            raise RuntimeError("JOJO_AGENT_SERVICE_SECRET must contain at least 32 characters")
        return self.agent_service_secret


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
