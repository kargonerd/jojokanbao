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
from times_pipeline.proxy_control import rotate_proxy
from times_pipeline.webarchive import (
    capture_articles,
    load_archive_state,
    select_articles_for_capture,
    write_web_archive,
)


PARSER_SELECTORS: dict[str, tuple[str, ...]] = {
    "ap": ("main article", "[data-key='article']", ".RichTextStoryBody"),
    "guardian": ("#maincontent", "[data-gu-name='body']"),
    "bloomberg": ("[data-component='body']", ".body-content"),
    "nyt": ("section[name='articleBody']", "#story"),
    "reuters": ("[data-testid='Body']", "[data-testid='paragraph']"),
    "ft": ("[data-trackable='article-body']", ".article__content-body"),
    "axios": ("[data-cy='story-body']", ".gtm-story-text"),
    "npr": ("#storytext", "[id^='storytext']"),
    "nikkei": ("#article-body", ".article-body"),
    "zaobao": (".article-content-rawhtml", ".article-content"),
    "aljazeera": ("main article", ".wysiwyg"),
    "scmp": (".article-body", "[data-vue-component='GenericArticleBody']"),
    "xinhua": ("#detail", "#article"),
    "people": (".rm_txt_con", "#rwb_zw"),
    "cctv": (".content_area", "#content_area"),
    "chinanews": (".left_zw", ".content"),
    "thepaper": (".newscontent", ".index_cententWrap"),
    "cls": (".detail-content", ".m-detail-content"),
    "cna": (".content-detail__body", ".text-long"),
    "dw": (".rich-text", "[data-tracking-name='article-content']"),
    "focus-taiwan": (".article-content", ".paragraph"),
    "africanews": (".article-main__content", ".article-content"),
    "agencia-brasil": (".content-news", ".field--name-body"),
}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_candidates(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in gzip.decompress(path.read_bytes()).decode("utf-8").splitlines() if line]


def _source(row: dict[str, Any]) -> Source:
    discovery = row["discovery"]
    route = discovery.get("route") if discovery.get("kind") == "rsshub-package" else None
    urls = discovery.get("urls") or ([discovery["url"]] if discovery.get("url") else [])
    return Source(
        id=row["id"],
        name=row["name"],
        language=row["language"],
        route=route,
        feed_url=urls[0] if urls else None,
        feed_urls=tuple(urls),
        content_policy="feed-body" if "discovery-body" in row["content"]["priority"] else "summary-only",
        parser_id=row["content"].get("parser"),
        archive_pages=row["archive"]["mode"] == "browser",
        minimum_full_characters=row["content"].get("minimumFullCharacters", 800),
        minimum_full_paragraphs=row["content"].get("minimumFullParagraphs", 3),
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


def _plain_fragment(value: str) -> str:
    if "<" not in value:
        return re.sub(r"\s+", " ", value).strip()
    return re.sub(r"\s+", " ", BeautifulSoup(value, "html.parser").get_text(" ", strip=True)).strip()


def _reuters_fusion_article_body(body: bytes) -> str | None:
    try:
        source = body.decode("utf-8", "replace")
    except AttributeError:
        return None
    match = re.search(
        r"Fusion\.globalContent\s*=\s*(.*?);\s*Fusion\.globalContentConfig\s*=",
        source,
        re.DOTALL,
    )
    if match is None:
        return None
    try:
        payload = json.loads(match.group(1))
    except (json.JSONDecodeError, TypeError):
        return None
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict) or payload.get("statusCode") != 200:
        return None

    paragraphs: list[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                collect(child)
            return
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        content = value.get("content")
        if kind in {"paragraph", "text", "subhead", "header", "blockquote"} and isinstance(content, str):
            text = _plain_fragment(content)
            if text and text not in paragraphs:
                paragraphs.append(text)
        for key in ("items", "content_elements", "children"):
            collect(value.get(key))

    collect(result.get("content_elements"))
    text = " ".join(paragraphs)
    if len(text) < 100:
        return None
    expected_words = result.get("word_count")
    actual_words = len(text.split())
    if isinstance(expected_words, int) and expected_words > 0 and actual_words < expected_words * 0.6:
        return None
    return "".join(f"<p>{html.escape(part)}</p>" for part in paragraphs)


def _clean_parser_paragraphs(paragraphs: list[str], parser_id: str | None) -> list[str]:
    if parser_id != "reuters":
        return paragraphs
    prefixes = (
        "the reuters daily briefing newsletter",
        "reporting by ",
        "additional reporting by ",
        "our standards:",
        "based in toronto, bhargav reports",
    )
    return [part for part in paragraphs if not part.casefold().startswith(prefixes)]


def _bloomberg_text(value: Any) -> str:
    if isinstance(value, list):
        return "".join(_bloomberg_text(child) for child in value)
    if not isinstance(value, dict):
        return ""
    if isinstance(value.get("value"), str):
        return value["value"]
    # Bloomberg stores URLs, captions, newsletter copy, and other metadata in
    # `data`. Only recurse through `content`, which is the article's rich-text
    # tree and is the same source used by BPC's Bloomberg route.
    return _bloomberg_text(value.get("content"))


def _bloomberg_next_data_body(
    document: BeautifulSoup,
    minimum_characters: int,
    minimum_paragraphs: int,
) -> str | None:
    next_data = document.select_one("script#__NEXT_DATA__")
    if next_data is None:
        return None
    try:
        payload = json.loads(next_data.get_text())
        blocks = payload["props"]["pageProps"]["story"]["body"]["content"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    if not isinstance(blocks, list):
        return None

    ignored_types = {
        "ad",
        "embed",
        "hr",
        "inline-newsletter",
        "inline-recirc",
        "media",
        "tabularData",
    }
    paragraphs: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") in ignored_types:
            continue
        text = re.sub(r"\s+", " ", _bloomberg_text(block.get("content"))).strip()
        if len(text) < 20 or text in seen:
            continue
        seen.add(text)
        paragraphs.append(text)
    combined = "\n".join(paragraphs)
    if len(combined) < minimum_characters or len(paragraphs) < minimum_paragraphs:
        return None
    return "".join(f"<p>{html.escape(part)}</p>" for part in paragraphs)


def _nikkei_next_data_body(
    document: BeautifulSoup,
    minimum_characters: int,
    minimum_paragraphs: int,
) -> str | None:
    next_data = document.select_one("script#__NEXT_DATA__")
    if next_data is None:
        return None
    try:
        payload = json.loads(next_data.get_text())
        article_html = payload["props"]["pageProps"]["data"]["body"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None
    if not isinstance(article_html, str):
        return None

    fragment = BeautifulSoup(article_html, "html.parser")
    paragraphs: list[str] = []
    seen: set[str] = set()
    for element in fragment.find_all(("p", "h2", "h3", "blockquote", "li")):
        text = re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip()
        if len(text) < 20 or text in seen:
            continue
        seen.add(text)
        paragraphs.append(text)
    combined = "\n".join(paragraphs)
    if len(combined) < minimum_characters or len(paragraphs) < minimum_paragraphs:
        return None
    return "".join(f"<p>{html.escape(part)}</p>" for part in paragraphs)


def _browser_article_body(
    body: bytes,
    minimum_characters: int = 800,
    minimum_paragraphs: int = 3,
    parser_id: str | None = None,
) -> str | None:
    if not body:
        return None
    if parser_id == "reuters":
        fusion_body = _reuters_fusion_article_body(body)
        if fusion_body is not None:
            return fusion_body
    document = BeautifulSoup(body, "html.parser")
    if parser_id == "bloomberg":
        next_data_body = _bloomberg_next_data_body(document, minimum_characters, minimum_paragraphs)
        if next_data_body is not None:
            return next_data_body
    if parser_id == "nikkei":
        next_data_body = _nikkei_next_data_body(document, minimum_characters, minimum_paragraphs)
        if next_data_body is not None:
            return next_data_body
    if parser_id == "cls":
        next_data = document.select_one("script#__NEXT_DATA__")
        if next_data is not None:
            try:
                payload = json.loads(next_data.get_text())
                detail = payload["props"]["pageProps"]["articleDetail"]
                content = detail.get("content") if isinstance(detail, dict) else None
            except (json.JSONDecodeError, KeyError, TypeError):
                content = None
            if isinstance(content, str):
                text = _plain_fragment(content)
                if len(text) >= minimum_characters and minimum_paragraphs <= 1:
                    return f"<p>{html.escape(text)}</p>"
    json_bodies: list[str] = []
    for script in document.select('script[type="application/ld+json"]'):
        try:
            json_bodies.extend(_json_article_bodies(json.loads(script.get_text())))
        except (json.JSONDecodeError, TypeError):
            continue
    if json_bodies:
        best = max(json_bodies, key=len).strip()
        if len(best) >= minimum_characters:
            paragraphs = [part.strip() for part in re.split(r"\n\s*\n|\r?\n", best) if part.strip()]
            paragraphs = _clean_parser_paragraphs(paragraphs or [best], parser_id)
            if len("\n".join(paragraphs)) >= minimum_characters:
                return "".join(f"<p>{html.escape(part)}</p>" for part in paragraphs)

    for element in document.select("script, style, nav, footer, header, aside, form, noscript"):
        element.decompose()
    selectors = (*PARSER_SELECTORS.get(parser_id or "", ()),
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
    parser_selectors = PARSER_SELECTORS.get(parser_id or "", ())
    candidates: list[tuple[Any, bool]] = []
    for selector in selectors:
        candidates.extend((element, selector in parser_selectors) for element in document.select(selector))
    best_paragraphs: list[str] = []
    for container, allow_direct_text in candidates:
        paragraphs: list[str] = []
        seen: set[str] = set()
        for element in container.find_all(("p", "h2", "h3", "blockquote")):
            text = re.sub(r"\s+", " ", element.get_text(" ", strip=True)).strip()
            if len(text) < 20 or text in seen:
                continue
            seen.add(text)
            paragraphs.append(text)
        if not paragraphs and allow_direct_text:
            direct_text = re.sub(r"\s+", " ", container.get_text(" ", strip=True)).strip()
            if len(direct_text) >= minimum_characters:
                paragraphs.append(direct_text)
        if sum(map(len, paragraphs)) > sum(map(len, best_paragraphs)):
            best_paragraphs = paragraphs
    best_paragraphs = _clean_parser_paragraphs(best_paragraphs, parser_id)
    text = "\n".join(best_paragraphs)
    paywall_hints = (
        "subscribe to continue",
        "sign in to continue",
        "register to continue",
        "already a subscriber",
    )
    if len(text) < minimum_characters or len(best_paragraphs) < minimum_paragraphs:
        return None
    if len(text) < 2_000 and any(hint in text.casefold() for hint in paywall_hints):
        return None
    return "".join(f"<p>{html.escape(part)}</p>" for part in best_paragraphs)


def _browser_failure_reason(final: Any | None) -> str:
    if final is None:
        return "http-blocked"
    if final.status_code in {401, 403, 407, 429, 451}:
        return "http-blocked"
    document = BeautifulSoup(final.body, "html.parser")
    text = re.sub(r"\s+", " ", document.get_text(" ", strip=True)).casefold()
    hard_paywall_hints = (
        "subscribe to continue",
        "subscribe to keep reading",
        "sign in to continue reading",
        "register to continue reading",
        "unlock this article",
        "this article is for subscribers",
    )
    paywall_marker = document.find(
        lambda tag: bool(tag.name) and any(
            re.search(r"paywall|regwall|articleblur", str(value), re.IGNORECASE)
            for name in ("class", "id", "data-testid")
            for value in ([tag.get(name)] if tag.get(name) is not None else [])
        )
    )
    # isAccessibleForFree=false and isMetered=true describe the publisher's
    # commercial policy. They do not prove that the captured DOM/JSON lacks a
    # complete article; Bloomberg is a concrete counterexample.
    if paywall_marker is not None or any(hint in text for hint in hard_paywall_hints):
        return "hard-paywall"
    return "extraction-failed"


def _capture_failure_reason(capture: Any) -> str:
    rendered_pages = [
        exchange
        for exchange in capture.exchanges
        if exchange.is_page and any(
            name.casefold() == "x-jojo-rendered-dom" and value.casefold() == "true"
            for name, value in exchange.response_headers
        )
    ]
    if rendered_pages:
        # BPC and client JavaScript mutate the rendered DOM. An access marker in
        # the original response must not override the later browser result.
        return _browser_failure_reason(rendered_pages[-1])
    return _browser_failure_reason(capture.final_exchange)


def _capture_result(capture: Any) -> tuple[bool, str | None]:
    final = capture.final_exchange
    browser_bodies = [
        body
        for exchange in capture.exchanges
        if exchange.is_page
        for body in [_browser_article_body(
            exchange.body,
            capture.minimum_full_characters,
            capture.minimum_full_paragraphs,
            capture.parser_id,
        )]
        if body is not None
    ]
    browser_body = max(browser_bodies, key=len) if browser_bodies else None
    success = browser_body is not None or (
        capture.error is None
        and final is not None
        and 200 <= final.status_code < 400
    )
    return success, browser_body


def _merge_capture_attempts(original: Any, retry: Any) -> Any:
    return type(original)(
        article_id=original.article_id,
        source_id=original.source_id,
        canonical_url=original.canonical_url,
        title=original.title,
        exchanges=(*original.exchanges, *retry.exchanges),
        elapsed_ms=original.elapsed_ms + retry.elapsed_ms,
        error=retry.error,
        parser_id=original.parser_id,
        minimum_full_characters=original.minimum_full_characters,
        minimum_full_paragraphs=original.minimum_full_paragraphs,
    )


def _needs_extraction_retry(article: Article, capture: Any) -> bool:
    if article.content_status == "full":
        return False
    _archive_succeeded, browser_body = _capture_result(capture)
    # A visible paywall is only terminal after configured browser/BPC/proxy
    # attempts are exhausted. It is not a reason to suppress those attempts.
    return browser_body is None


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
            success, browser_body = _capture_result(capture)
            # A browser extension or client-side rendering can produce a valid
            # article DOM even when the original navigation response was 401/403.
            # The HTTP status remains in Raw provenance, but validated full text
            # is authoritative for extraction success.
            if not success:
                row["browserFailureReason"] = _capture_failure_reason(capture)
                failed += 1
                continue
            succeeded += 1
            if browser_body:
                row["browserBody"] = browser_body
                row["contentStatus"] = "full"
                row.pop("browserFailureReason", None)
                extracted += 1
                full_bodies += 1
            else:
                row["browserFailureReason"] = _capture_failure_reason(capture)
        if not attempts:
            continue
        payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)
        candidate_bytes = gzip.compress(payload.encode("utf-8"), compresslevel=9, mtime=0)
        candidates_path.write_bytes(candidate_bytes)
        manifest = _read_json(manifest_path)
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
            "hardPaywall": sum(row.get("browserFailureReason") == "hard-paywall" for row in rows),
            "httpBlocked": sum(row.get("browserFailureReason") == "http-blocked" for row in rows),
            "extractionFailed": sum(row.get("browserFailureReason") == "extraction-failed" for row in rows),
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
    parser.add_argument("--proxy-control", type=Path)
    parser.add_argument("--browser-extension-path")
    parser.add_argument("--browser-extension-revision")
    parser.add_argument("--browser-retries", type=int, default=1)
    parser.add_argument(
        "--archive-run-id",
        help="Optional distinct archive id for a repair/backfill of an existing Raw run",
    )
    return parser.parse_args()


async def _main() -> None:
    args = _arguments()
    workspace = args.output.resolve()
    run_path = args.run_manifest.resolve()
    run = _read_json(run_path)
    config = _read_json(args.config.resolve())
    generated_at = datetime.now(timezone.utc)
    archive_run_id = args.archive_run_id or run["runId"]
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
        # Retry rounds below rotate the isolated proxy between attempts. Do not
        # spend those rounds retrying the same node inside Playwright first.
        browser_retries=0,
        maximum_page_bytes=args.maximum_page_bytes,
    )
    selected_by_id = {article.id: article for article in selected}
    proxy_rotations = 0
    for _retry_index in range(args.browser_retries):
        retry_articles = [
            selected_by_id[capture.article_id]
            for capture in captures
            if _needs_extraction_retry(selected_by_id[capture.article_id], capture)
        ]
        if not retry_articles:
            break
        if args.proxy_server and args.proxy_control is not None:
            proxy_rotations += int(await asyncio.to_thread(rotate_proxy, args.proxy_control.resolve()))
        retry_captures = await capture_articles(
            retry_articles,
            timeout_seconds=args.timeout,
            workers=args.workers,
            maximum_response_bytes=args.maximum_response_bytes,
            engine=args.engine,
            proxy_server=args.proxy_server,
            browser_extension_path=args.browser_extension_path,
            browser_retries=0,
            maximum_page_bytes=args.maximum_page_bytes,
        )
        retries_by_id = {capture.article_id: capture for capture in retry_captures}
        captures = [
            _merge_capture_attempts(capture, retries_by_id[capture.article_id])
            if capture.article_id in retries_by_id
            else capture
            for capture in captures
        ]
    capture_full_text: dict[str, bool] = {}
    capture_failure_reasons: dict[str, str | None] = {}
    for capture in captures:
        _archive_succeeded, browser_body = _capture_result(capture)
        article = selected_by_id.get(capture.article_id)
        capture_full_text[capture.article_id] = bool(
            browser_body is not None
            or (article is not None and article.content_status == "full")
        )
        capture_failure_reasons[capture.article_id] = (
            None
            if capture_full_text[capture.article_id]
            else _capture_failure_reason(capture)
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
        run_id=archive_run_id,
        full_text_outcomes=capture_full_text,
        failure_reasons=capture_failure_reasons,
    )
    capture_by_source: dict[str, dict[str, Any]] = {}
    failed_cases: list[dict[str, Any]] = []
    for capture in captures:
        final = capture.final_exchange
        succeeded, browser_body = _capture_result(capture)
        source_report = capture_by_source.setdefault(capture.source_id, {
            "sourceId": capture.source_id,
            "attempts": 0,
            "succeeded": 0,
            "failed": 0,
            "extractedFullBodies": 0,
            "fullTextAvailable": 0,
            "fullTextUnavailable": 0,
        })
        source_report["attempts"] += 1
        source_report["succeeded" if succeeded else "failed"] += 1
        if browser_body is not None:
            source_report["extractedFullBodies"] += 1
        full_text_available = capture_full_text[capture.article_id]
        source_report["fullTextAvailable" if full_text_available else "fullTextUnavailable"] += 1
        if not full_text_available:
            failed_cases.append({
                "articleId": capture.article_id,
                "sourceId": capture.source_id,
                "title": capture.title,
                "url": capture.canonical_url,
                "httpStatus": final.status_code if final is not None else None,
                "error": capture.error,
                "reason": _capture_failure_reason(capture),
            })
    report["captureBySource"] = sorted(capture_by_source.values(), key=lambda row: row["sourceId"])
    report["failedCases"] = failed_cases
    report["fullTextFailures"] = sum(not value for value in capture_full_text.values())
    report["hardPaywalls"] = sum(value == "hard-paywall" for value in capture_failure_reasons.values())
    report["extractedFullBodies"] = _apply_capture_results(workspace, run, captures, report["waczObject"])
    report["browser"] = {
        "engine": args.engine,
        "playwrightVersion": package_version("playwright"),
        "extensionEnabled": bool(args.browser_extension_path),
        "extensionLoaded": bool(args.browser_extension_path),
        "extensionRevision": args.browser_extension_revision if args.browser_extension_path else None,
        "proxyConfigured": bool(args.proxy_server),
        "proxyRotations": proxy_rotations,
        "workers": args.workers,
        "maximumPages": args.max_pages,
    }
    archive_run = workspace.joinpath(*Path(report["waczObject"]).parent.parts, "run.json")
    archive_run.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    run["browserArchive"] = report
    run_path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "runId": run["runId"],
        "archiveRunId": archive_run_id,
        "discovered": len(articles),
        "selected": len(selected),
        "waczObject": report["waczObject"],
        "waczBytes": report["waczBytes"],
        "articleFailures": report["articleFailures"],
        "fullTextFailures": report["fullTextFailures"],
        "extractedFullBodies": report["extractedFullBodies"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
