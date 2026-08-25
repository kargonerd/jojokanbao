from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import gzip
import hashlib
import html
from importlib.metadata import version as package_version
import json
from pathlib import Path
import re
from typing import Any

from bs4 import BeautifulSoup

from times_pipeline.feeds import Article, Source
from times_pipeline.webarchive import (
    capture_articles,
    load_archive_state,
    select_articles_for_capture,
    write_web_archive,
)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_candidates(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in gzip.decompress(path.read_bytes()).decode("utf-8").splitlines() if line]


def _source(row: dict[str, Any]) -> Source:
    discovery = row["discovery"]
    urls = discovery.get("urls") or ([discovery["url"]] if discovery.get("url") else [])
    return Source(
        id=row["id"],
        name=row["name"],
        language=row["language"],
        feed_url=urls[0] if urls else None,
        feed_urls=tuple(urls),
        content_policy="feed-body" if "discovery-body" in row["content"]["priority"] else "summary-only",
        parser_id=row["content"].get("parser"),
        archive_pages=row["archive"]["mode"] == "browser",
    )


def _articles(workspace: Path, run: dict[str, Any], config: dict[str, Any]) -> list[Article]:
    sources = {row["id"]: _source(row) for row in config["sources"] if row.get("enabled", True)}
    articles: list[Article] = []
    for result in run["sources"]:
        manifest_object = (result.get("output") or {}).get("manifest")
        source = sources.get(result["sourceId"])
        if result.get("status") != "ok" or not manifest_object or source is None:
            continue
        manifest_path = workspace.joinpath(*manifest_object.split("/"))
        for row in _read_candidates(manifest_path.parent / "candidates.jsonl.gz"):
            articles.append(Article(
                id=row["articleId"],
                title=row["title"],
                summary=row.get("summary"),
                body=row.get("discoveryBody") or row.get("summary") or "",
                content_status=row["contentStatus"],
                url=row["canonicalUrl"],
                published_at=row["publishedAt"],
                source=source,
            ))
    return articles


def _json_article_bodies(value: Any) -> list[str]:
    if isinstance(value, dict):
        rows = [value.get("articleBody")] if isinstance(value.get("articleBody"), str) else []
        return rows + [body for child in value.values() for body in _json_article_bodies(child)]
    if isinstance(value, list):
        return [body for child in value for body in _json_article_bodies(child)]
    return []


def _browser_article_body(body: bytes, source_selectors: tuple[str, ...] = ()) -> str | None:
    if not body:
        return None
    document = BeautifulSoup(body, "html.parser")
    json_bodies: list[str] = []
    for script in document.select('script[type="application/ld+json"]'):
        try:
            json_bodies.extend(_json_article_bodies(json.loads(script.get_text())))
        except (json.JSONDecodeError, TypeError):
            continue
    if json_bodies:
        best = max(json_bodies, key=len).strip()
        if len(best) >= 800:
            paragraphs = [part.strip() for part in re.split(r"\n\s*\n|\r?\n", best) if part.strip()]
            return "".join(f"<p>{html.escape(part)}</p>" for part in paragraphs or [best])

    for element in document.select("script, style, nav, footer, header, aside, form, noscript"):
        element.decompose()
    selectors = source_selectors + (
        "[itemprop='articleBody']",
        "article",
        ".article-body",
        ".article__body",
        ".story-body",
        ".storytext",
        ".entry-content",
        ".post-content",
        "main",
    )
    candidates = []
    for selector in selectors:
        candidates.extend(document.select(selector))
    candidates.append(document)
    best_paragraphs: list[str] = []
    for container in candidates:
        paragraphs: list[str] = []
        seen: set[str] = set()
        for element in container.find_all(("p", "h2", "h3", "blockquote")):
            text = re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip()
            if len(text) < 20 or text in seen:
                continue
            seen.add(text)
            paragraphs.append(text)
        if sum(map(len, paragraphs)) > sum(map(len, best_paragraphs)):
            best_paragraphs = paragraphs
    text = "\n".join(best_paragraphs)
    paywall_hints = (
        "subscribe to continue",
        "sign in to continue",
        "register to continue",
        "already a subscriber",
    )
    if len(text) < 800 or len(best_paragraphs) < 3:
        return None
    if len(text) < 2_000 and any(hint in text.casefold() for hint in paywall_hints):
        return None
    return "".join(f"<p>{html.escape(part)}</p>" for part in best_paragraphs)


def _apply_capture_results(
    workspace: Path,
    run: dict[str, Any],
    captures: list[Any],
    wacz_object: str,
) -> int:
    capture_by_id = {capture.article_id: capture for capture in captures}
    full_bodies = 0
    for result in run["sources"]:
        manifest_object = (result.get("output") or {}).get("manifest")
        if not manifest_object:
            continue
        manifest_path = workspace.joinpath(*manifest_object.split("/"))
        candidates_path = manifest_path.parent / "candidates.jsonl.gz"
        manifest = _read_json(manifest_path)
        configured_selectors = (manifest.get("pagePolicy") or {}).get("bodySelectors") or []
        source_selectors = tuple(value for value in configured_selectors if isinstance(value, str) and value.strip())
        rows = _read_candidates(candidates_path)
        attempts = succeeded = failed = extracted = 0
        for row in rows:
            capture = capture_by_id.get(row["articleId"])
            if capture is None:
                continue
            attempts += 1
            final = capture.final_exchange
            row["browserArchiveObject"] = wacz_object
            if final is not None:
                row["browserCapturedAt"] = final.captured_at
                row["browserHttpStatus"] = final.status_code
            success = capture.error is None and final is not None and 200 <= final.status_code < 400
            if not success:
                failed += 1
                continue
            succeeded += 1
            browser_body = _browser_article_body(final.body, source_selectors)
            if browser_body:
                row["browserBody"] = browser_body
                row["contentStatus"] = "full"
                extracted += 1
                full_bodies += 1
        if not attempts:
            continue
        payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)
        candidate_bytes = gzip.compress(payload.encode("utf-8"), compresslevel=9, mtime=0)
        candidates_path.write_bytes(candidate_bytes)
        manifest["fullCount"] = sum(row["contentStatus"] == "full" for row in rows)
        manifest["summaryCount"] = sum(row["contentStatus"] == "summary" for row in rows)
        manifest["metadataCount"] = sum(row["contentStatus"] == "metadata" for row in rows)
        manifest["archiveStatus"] = "wacz-complete"
        manifest["browserArchive"] = {
            "object": wacz_object,
            "attempts": attempts,
            "succeeded": succeeded,
            "failed": failed,
            "extractedFullBodies": extracted,
        }
        for descriptor in manifest.get("objects", []):
            if descriptor.get("path") == "candidates.jsonl.gz":
                descriptor["size"] = len(candidate_bytes)
                descriptor["sha256"] = hashlib.sha256(candidate_bytes).hexdigest()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return full_bodies


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Archive v2 Times candidates as replayable WACZ")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-manifest", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--engine", choices=("browser", "http"), default="browser")
    parser.add_argument("--max-pages", type=int, default=50)
    parser.add_argument("--sources", help="Optional comma-separated source ids")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--maximum-response-bytes", type=int, default=5_000_000)
    parser.add_argument("--maximum-page-bytes", type=int, default=25_000_000)
    parser.add_argument("--refresh-hours", type=float, default=24)
    parser.add_argument("--retry-hours", type=float, default=2)
    parser.add_argument("--proxy-server")
    parser.add_argument("--browser-extension-path")
    parser.add_argument("--browser-extension-revision")
    return parser.parse_args()


async def _main() -> None:
    args = _arguments()
    workspace = args.output.resolve()
    run_path = args.run_manifest.resolve()
    run = _read_json(run_path)
    config = _read_json(args.config.resolve())
    generated_at = datetime.now(timezone.utc)
    articles = _articles(workspace, run, config)
    requested_sources = {value.strip() for value in (args.sources or "").split(",") if value.strip()}
    if requested_sources:
        articles = [article for article in articles if article.source.id in requested_sources]
    state_root = workspace / "raw" / "web-archives" / "times"
    state = load_archive_state(state_root)
    selected = select_articles_for_capture(
        articles,
        state,
        now=generated_at,
        retention_days=7,
        max_pages=args.max_pages,
        refresh_hours=args.refresh_hours,
        retry_hours=args.retry_hours,
    )
    captures = await capture_articles(
        selected,
        timeout_seconds=args.timeout,
        workers=args.workers,
        maximum_response_bytes=args.maximum_response_bytes,
        engine=args.engine,
        proxy_server=args.proxy_server,
        browser_extension_path=args.browser_extension_path,
        browser_retries=0,
        maximum_page_bytes=args.maximum_page_bytes,
    )
    statuses = [{
        "id": result["sourceId"],
        "status": result["status"],
        **({"error": result["error"]} if result.get("error") else {}),
    } for result in run["sources"]]
    report = write_web_archive(
        workspace / "raw",
        raw_feeds=[],
        captures=captures,
        articles=articles,
        previous_state=state,
        source_statuses=statuses,
        generated_at=generated_at,
        run_id=run["runId"],
    )
    capture_by_source: dict[str, dict[str, Any]] = {}
    failed_cases: list[dict[str, Any]] = []
    for capture in captures:
        final = capture.final_exchange
        succeeded = capture.error is None and final is not None and 200 <= final.status_code < 400
        source_report = capture_by_source.setdefault(capture.source_id, {
            "sourceId": capture.source_id,
            "attempts": 0,
            "succeeded": 0,
            "failed": 0,
        })
        source_report["attempts"] += 1
        source_report["succeeded" if succeeded else "failed"] += 1
        if not succeeded:
            failed_cases.append({
                "articleId": capture.article_id,
                "sourceId": capture.source_id,
                "title": capture.title,
                "url": capture.canonical_url,
                "httpStatus": final.status_code if final is not None else None,
                "error": capture.error,
            })
    report["captureBySource"] = sorted(capture_by_source.values(), key=lambda row: row["sourceId"])
    report["failedCases"] = failed_cases
    report["extractedFullBodies"] = _apply_capture_results(workspace, run, captures, report["waczObject"])
    report["browser"] = {
        "engine": args.engine,
        "playwrightVersion": package_version("playwright"),
        "extensionEnabled": bool(args.browser_extension_path),
        "extensionRevision": args.browser_extension_revision if args.browser_extension_path else None,
        "proxyConfigured": bool(args.proxy_server),
        "workers": args.workers,
        "maximumPages": args.max_pages,
    }
    archive_run = workspace.joinpath(*Path(report["waczObject"]).parent.parts, "run.json")
    archive_run.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    run["browserArchive"] = report
    run_path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "runId": run["runId"],
        "discovered": len(articles),
        "selected": len(selected),
        "waczObject": report["waczObject"],
        "waczBytes": report["waczBytes"],
        "articleFailures": report["articleFailures"],
        "extractedFullBodies": report["extractedFullBodies"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
