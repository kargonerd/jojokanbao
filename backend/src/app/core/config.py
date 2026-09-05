from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
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


def _boolean(value: str | None, default: bool, name: str) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str
    allowed_origins: tuple[str, ...]
    supabase_url: str | None
    supabase_publishable_key: str | None
    auth_timeout_seconds: float
    tts_enabled: bool = True
    mimo_api_key: str | None = field(default=None, repr=False)
    speech_cache_path: str | None = None
    speech_storage: str = "local"
    speech_s3_endpoint: str | None = None
    speech_s3_region: str = "us-west-004"
    speech_s3_bucket: str | None = None
    speech_s3_key_id: str | None = field(default=None, repr=False)
    speech_s3_application_key: str | None = field(default=None, repr=False)
    speech_cdn_base: str = "https://blacknews.jojokanbao.cn"

    @classmethod
    def from_env(cls) -> Settings:
        environment = os.getenv("JOJO_ENV", "development").strip() or "development"
        if environment not in VALID_ENVIRONMENTS:
            raise RuntimeError(f"JOJO_ENV must be one of: {', '.join(sorted(VALID_ENVIRONMENTS))}")
        configured_origins = os.getenv("JOJO_ALLOWED_ORIGINS")
        if environment == "production" and not configured_origins:
            raise RuntimeError("JOJO_ALLOWED_ORIGINS is required in production")
        storage = os.getenv("JOJO_SPEECH_STORAGE", "b2" if environment == "production" else "local")
        if storage not in {"local", "b2"}:
            raise RuntimeError("JOJO_SPEECH_STORAGE must be local or b2")
        endpoint = os.getenv("JOJO_SPEECH_S3_ENDPOINT") or None
        cdn = os.getenv("JOJO_SPEECH_CDN_BASE") or os.getenv("VITE_CONTENT_CDN_BASE") or "https://blacknews.jojokanbao.cn"
        for name, value in (("JOJO_SPEECH_S3_ENDPOINT", endpoint), ("JOJO_SPEECH_CDN_BASE", cdn)):
            if value:
                parsed = urlsplit(value)
                if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
                    raise RuntimeError(f"{name} must be an HTTPS URL without credentials or query")

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
            tts_enabled=_boolean(
                os.getenv("JOJO_TTS_ENABLED"),
                default=environment != "production",
                name="JOJO_TTS_ENABLED",
            ),
            mimo_api_key=(os.getenv("MIMO_API_KEY") or "").strip() or None,
            speech_storage=storage,
            speech_s3_endpoint=endpoint,
            speech_s3_region=os.getenv("JOJO_SPEECH_S3_REGION", "us-west-004"),
            speech_s3_bucket=os.getenv("JOJO_SPEECH_S3_BUCKET") or None,
            speech_s3_key_id=os.getenv("JOJO_SPEECH_S3_KEY_ID") or None,
            speech_s3_application_key=os.getenv("JOJO_SPEECH_S3_APPLICATION_KEY") or None,
            speech_cdn_base=cdn.rstrip("/"),
            speech_cache_path=(os.getenv("JOJO_SPEECH_CACHE_PATH") or str(Path(__file__).resolve().parents[3] / ".runtime" / "speech" / "cache.sqlite3")) if _boolean(
                os.getenv("JOJO_SPEECH_CACHE_ENABLED"), environment != "test", "JOJO_SPEECH_CACHE_ENABLED",
            ) else None,
        )

    def require_supabase(self) -> tuple[str, str]:
        if not self.supabase_url or not self.supabase_publishable_key:
            raise RuntimeError("Supabase authentication is not configured")
        return self.supabase_url, self.supabase_publishable_key


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
