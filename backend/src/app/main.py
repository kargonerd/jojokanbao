from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.account.router import router as account_router
from app.core.config import get_settings
from app.core.http_middleware import (
    ResponseHeadersMiddleware,
    UnhandledErrorMiddleware,
    install_exception_handlers,
)
from app.rag.router import internal_router as rag_internal_router
from app.rag.router import router as rag_router


settings = get_settings()
app = FastAPI(
    title="JOJO Platform API",
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url=None,
)

app.add_middleware(UnhandledErrorMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)
app.add_middleware(ResponseHeadersMiddleware)
install_exception_handlers(app)
app.include_router(account_router, prefix="/v1")
app.include_router(rag_router, prefix="/v1")
app.include_router(rag_internal_router, prefix="/v1")
