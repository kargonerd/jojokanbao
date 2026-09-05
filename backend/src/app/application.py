"""Shared API composition, without a platform-discoverable module-level entry."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.account.router import router as account_router
from app.core.config import get_settings
from app.core.http_middleware import (
    ResponseHeadersMiddleware,
    UnhandledErrorMiddleware,
    install_exception_handlers,
)
from app.speech.router import router as speech_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="JOJO 看报 API",
        docs_url="/docs" if settings.environment != "production" else None,
        redoc_url=None,
    )

    app.add_middleware(UnhandledErrorMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-JOJO-Visitor-ID", "X-Request-ID"],
        expose_headers=["ETag", "X-Request-ID"],
    )
    app.add_middleware(ResponseHeadersMiddleware)
    install_exception_handlers(app)
    app.include_router(account_router, prefix="/v1")
    app.include_router(speech_router, prefix="/v1")
    return app
