from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import importlib
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable, Iterable

from .feeds import Article
from .webarchive import ArticleCapture


DEFAULT_LOCK = Path(__file__).resolve().parents[1] / "runner.lock.json"


def _load_runner(
    runner_root: Path,
    lock_path: Path = DEFAULT_LOCK,
) -> Callable[..., Any]:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    package_root = runner_root.resolve()
    if not (package_root / "jojo_olds_api" / "news_parser.py").is_file():
        raise RuntimeError(f"Invalid JOJO news archive runner service root: {package_root}")
    root_value = str(package_root)
    if root_value not in sys.path:
        sys.path.insert(0, root_value)
    news_parser = importlib.import_module("jojo_olds_api.news_parser")
    publisher_specs = importlib.import_module("jojo_olds_api.publisher_specs")
    expected = lock.get("parsers")
    actual = {
        name: spec.parser_version
        for name, spec in publisher_specs.PUBLISHER_SPECS.items()
    }
    if actual != expected:
        raise RuntimeError("JOJO news archive runner parser versions do not match runner.lock.json")
    return news_parser.parse_article


def enrich_articles(
    articles: Iterable[Article],
    captures: Iterable[ArticleCapture],
    *,
    runner_root: Path | None,
    require_runner: bool,
    parsed_at: datetime | None = None,
) -> tuple[list[Article], dict[str, int | str | None]]:
    values = list(articles)
    root = runner_root or (
        Path(os.environ["JOJO_NEWS_ARCHIVE_RUNNER_ROOT"])
        if os.getenv("JOJO_NEWS_ARCHIVE_RUNNER_ROOT")
        else None
    )
    if root is None:
        if require_runner:
            raise RuntimeError("JOJO_NEWS_ARCHIVE_RUNNER_ROOT or --news-runner-root is required")
        return values, {"runner": None, "complete": 0, "partial": 0, "unsupported": 0, "error": 0, "skipped": len(values)}
    parse_article = _load_runner(root)
    capture_by_id = {capture.article_id: capture for capture in captures}
    stats: dict[str, int | str | None] = {
        "runner": str(root.resolve()),
        "complete": 0,
        "partial": 0,
        "unsupported": 0,
        "error": 0,
        "skipped": 0,
    }
    enriched: list[Article] = []
    for article in values:
        capture = capture_by_id.get(article.id)
        final = capture.final_exchange if capture is not None else None
        content_type = next(
            (value for name, value in final.response_headers if name.casefold() == "content-type"),
            "",
        ) if final is not None else ""
        if final is None or final.status_code < 200 or final.status_code >= 300 or "html" not in content_type.casefold():
            stats["skipped"] = int(stats["skipped"] or 0) + 1
            enriched.append(article)
            continue
        parser_id = article.source.parser_id or article.source.id
        try:
            parsed = parse_article(
                final.body,
                publisher=parser_id,
                canonical_url=article.url,
                parsed_at=parsed_at or datetime.now(timezone.utc),
            )
            normalized = parsed.model_dump(mode="json", by_alias=True)
            normalized["articleId"] = article.id
            quality = normalized.get("quality", {})
            status = quality.get("status", "error") if isinstance(quality, dict) else "error"
            if status not in {"complete", "partial", "unsupported", "error"}:
                status = "error"
            stats[status] = int(stats[status] or 0) + 1
            plain_text = normalized.get("plainText")
            if status in {"complete", "partial"} and isinstance(plain_text, str) and plain_text.strip():
                enriched.append(replace(
                    article,
                    title=(normalized.get("headline") or article.title)[:1_000],
                    body=plain_text[:1_000_000],
                    content_status="full" if status == "complete" else "partial",
                    normalized=normalized,
                ))
            else:
                enriched.append(replace(article, normalized=normalized))
        except Exception:
            stats["error"] = int(stats["error"] or 0) + 1
            enriched.append(article)
    return enriched, stats
