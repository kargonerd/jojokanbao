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
    rsshub_url: str = "https://jojokanbao-rsshub.onrender.com"
    rsshub_access_key: str | None = None
    rsshub_timeout_seconds: float = 12.0

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
            rsshub_url=(
                os.getenv("JOJO_TIMES_RSSHUB_URL", "https://jojokanbao-rsshub.onrender.com").strip().rstrip("/")
                or "https://jojokanbao-rsshub.onrender.com"
            ),
            rsshub_access_key=(os.getenv("JOJOKANBAO_RSSHUB_ACCESS_KEY") or "").strip() or None,
            rsshub_timeout_seconds=_positive_float(
                os.getenv("JOJO_TIMES_RSSHUB_TIMEOUT_SECONDS"),
                default=12.0,
                name="JOJO_TIMES_RSSHUB_TIMEOUT_SECONDS",
            ),
        )

    def require_supabase(self) -> tuple[str, str]:
        if not self.supabase_url or not self.supabase_publishable_key:
            raise RuntimeError("Supabase authentication is not configured")
        return self.supabase_url, self.supabase_publishable_key


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
