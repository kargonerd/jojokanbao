from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Callable, Iterable
from urllib.parse import urlsplit, urlunsplit
import uuid

from bs4 import BeautifulSoup, Tag
import httpx


DEFAULT_USER_AGENT = (
    "JOJO-Olds/0.1 (+https://jojokanbao.cn; authorized personal academic archive)"
)
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
IMAGE_HOSTS = {"assets.bwbx.io", "assets.bwbx.com"}
IMAGE_PATH_PREFIXES = ("/images/users/",)
WAYBACK_REPLAY_RE = re.compile(
    r"^https?://web\.archive\.org/web/\d{1,14}(?:id_|im_)?/(https?://.+)$",
    re.IGNORECASE,
)
DIMENSION_RE = re.compile(
    r"^(?P<width>\d+|-1)x(?P<height>\d+|-1)(?P<tail>[^.]*)\.(?P<extension>[a-z0-9]+)$",
    re.IGNORECASE,
)
@dataclass(frozen=True)
class ManifestArticle:
    url: str
    catalog_date: str
    section: str
    wayback_timestamp: str
    wayback_snapshot_url: str
    wayback_digest: str | None


@dataclass(frozen=True)
class StoredObject:
    relative_path: str
    sha256: str
    byte_count: int


class GlobalRateLimiter:
    def __init__(self, minimum_interval: float) -> None:
        self.minimum_interval = max(0.0, minimum_interval)
        self._lock = threading.Lock()
        self._next_request_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_request_at - now)
            self._next_request_at = max(now, self._next_request_at) + self.minimum_interval
        if delay:
            time.sleep(delay)


class ArchiveClient:
    def __init__(
        self,
        *,
        timeout: float = 90.0,
        minimum_interval: float = 0.5,
        attempts: int = 6,
        client: httpx.Client | None = None,
    ) -> None:
        self.attempts = attempts
        self.timeout = timeout
        self.rate_limiter = GlobalRateLimiter(minimum_interval)
        self._provided_client = client
        self._local = threading.local()
        self._clients: list[httpx.Client] = []
        self._clients_lock = threading.Lock()
        self._circuit_lock = threading.Lock()
        self._consecutive_failures = 0
        self._blocked_until = 0.0

    def close(self) -> None:
        if self._provided_client is not None:
            return
        with self._clients_lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            client.close()

    def _get_client(self) -> httpx.Client:
        if self._provided_client is not None:
            return self._provided_client
        client = getattr(self._local, "client", None)
        if client is None:
            transport = httpx.HTTPTransport(
                retries=2,
                limits=httpx.Limits(
                    max_connections=2,
                    max_keepalive_connections=1,
                    keepalive_expiry=10.0,
                ),
            )
            client = httpx.Client(
                headers={"User-Agent": DEFAULT_USER_AGENT},
                follow_redirects=True,
                timeout=self.timeout,
                transport=transport,
            )
            self._local.client = client
            with self._clients_lock:
                self._clients.append(client)
        return client

    def _wait_for_circuit(self) -> None:
        with self._circuit_lock:
            delay = max(0.0, self._blocked_until - time.monotonic())
        if delay:
            time.sleep(delay)

    def _record_success(self) -> None:
        with self._circuit_lock:
            self._consecutive_failures = 0
            self._blocked_until = 0.0

    def _record_failure(self, *, retry_after: float | None = None) -> None:
        with self._circuit_lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= 3:
                exponent = min(3, self._consecutive_failures - 3)
                circuit_delay = max(retry_after or 0.0, 15.0 * (2**exponent))
                self._blocked_until = max(
                    self._blocked_until,
                    time.monotonic() + circuit_delay,
                )

    def fetch(
        self,
        url: str,
        *,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]:
        last_error: Exception | None = None
        for attempt in range(self.attempts):
            self._wait_for_circuit()
            self.rate_limiter.wait()
            try:
                with self._get_client().stream("GET", url) as response:
                    status_code = response.status_code
                    headers = {
                        key.lower(): value
                        for key, value in response.headers.items()
                    }
                    if status_code in RETRYABLE_STATUS_CODES:
                        retry_after = _parse_retry_after(headers.get("retry-after"))
                        self._record_failure(retry_after=retry_after)
                        raise RetryableArchiveError(
                            f"retryable HTTP {status_code}",
                            retry_after=retry_after,
                        )
                    if status_code not in {200, 206}:
                        self._record_success()
                        return status_code, headers, b"", str(response.url)
                    chunks = []
                    byte_count = 0
                    for chunk in response.iter_bytes():
                        byte_count += len(chunk)
                        if byte_count > maximum_bytes:
                            raise ValueError(
                                f"response exceeds {maximum_bytes} bytes"
                            )
                        chunks.append(chunk)
                    self._record_success()
                    return status_code, headers, b"".join(chunks), str(response.url)
            except RetryableArchiveError as exc:
                last_error = exc
                if attempt + 1 < self.attempts:
                    time.sleep(exc.retry_after or min(60.0, 2.0 ** attempt))
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_error = exc
                self._record_failure()
                if attempt + 1 < self.attempts:
                    time.sleep(min(60.0, 2.0 ** (attempt + 1)))
        if last_error:
            raise last_error
        raise RuntimeError("archive fetch failed without an error")


class RetryableArchiveError(RuntimeError):
    def __init__(self, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, min(300.0, float(value)))
    except ValueError:
        return None


def initialize_download_schema(
    connection: sqlite3.Connection,
    *,
    authorization_reference: str,
    scope: str = "Bloomberg archived HTML, extracted article text, and editorial images",
) -> None:
    if not authorization_reference.strip():
        raise ValueError("authorization_reference cannot be empty")
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS archive_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS articles (
            url TEXT PRIMARY KEY,
            catalog_date TEXT NOT NULL,
            section TEXT NOT NULL,
            wayback_timestamp TEXT NOT NULL,
            wayback_snapshot_url TEXT NOT NULL,
            wayback_digest TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            http_status INTEGER,
            raw_path TEXT,
            raw_sha256 TEXT,
            raw_bytes INTEGER,
            title TEXT,
            description TEXT,
            authors_json TEXT,
            published_at TEXT,
            modified_at TEXT,
            body_text TEXT,
            body_html_path TEXT,
            body_html_sha256 TEXT,
            body_chars INTEGER NOT NULL DEFAULT 0,
            image_references INTEGER NOT NULL DEFAULT 0,
            images_downloaded INTEGER NOT NULL DEFAULT 0,
            image_status TEXT NOT NULL DEFAULT 'pending',
            last_error TEXT,
            authorization_reference TEXT NOT NULL,
            updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_archive_articles_status
            ON articles(status);
        CREATE INDEX IF NOT EXISTS idx_archive_articles_catalog_date
            ON articles(catalog_date);

        CREATE TABLE IF NOT EXISTS assets (
            asset_key TEXT PRIMARY KEY,
            original_url TEXT NOT NULL,
            chosen_url TEXT,
            replay_url TEXT,
            final_url TEXT,
            status TEXT NOT NULL,
            http_status INTEGER,
            mime_type TEXT,
            local_path TEXT,
            sha256 TEXT,
            byte_count INTEGER,
            attempts_json TEXT NOT NULL,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS article_assets (
            article_url TEXT NOT NULL,
            asset_key TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            PRIMARY KEY(article_url, asset_key),
            FOREIGN KEY(article_url) REFERENCES articles(url),
            FOREIGN KEY(asset_key) REFERENCES assets(asset_key)
        );
        """
    )
    now = datetime.now(timezone.utc).isoformat()
    metadata = {
        "authorization_reference": authorization_reference,
        "created_at": now,
        "format_version": "1",
        "scope": scope,
    }
    connection.executemany(
        """
        INSERT INTO archive_metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        metadata.items(),
    )
    connection.execute(
        """
        UPDATE articles
        SET status='pending', last_error='interrupted before completion'
        WHERE status='downloading'
        """
    )
    connection.commit()


def load_manifest(
    connection: sqlite3.Connection,
    *,
    manifest_path: Path,
    authorization_reference: str,
) -> dict:
    inserted = 0
    skipped_without_capture = 0
    with gzip.open(manifest_path, "rt", encoding="utf-8") as stream:
        batch: list[tuple] = []
        for line in stream:
            item = json.loads(line)
            if (
                item.get("wayback_status") != "found"
                or not item.get("wayback_snapshot_url")
                or not item.get("wayback_timestamp")
            ):
                skipped_without_capture += 1
                continue
            batch.append(
                (
                    item["url"],
                    item["catalog_date"],
                    item.get("section") or "unknown",
                    item["wayback_timestamp"],
                    item["wayback_snapshot_url"],
                    item.get("wayback_digest"),
                    authorization_reference,
                )
            )
            if len(batch) >= 1000:
                inserted += _insert_manifest_batch(connection, batch)
                batch.clear()
        if batch:
            inserted += _insert_manifest_batch(connection, batch)
    connection.commit()
    total = connection.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
    return {
        "inserted": inserted,
        "totalDownloadable": total,
        "skippedWithoutCapture": skipped_without_capture,
    }


def _insert_manifest_batch(
    connection: sqlite3.Connection,
    batch: list[tuple],
) -> int:
    before = connection.total_changes
    connection.executemany(
        """
        INSERT OR IGNORE INTO articles(
            url, catalog_date, section, wayback_timestamp,
            wayback_snapshot_url, wayback_digest, authorization_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        batch,
    )
    return connection.total_changes - before


def extract_article(html_bytes: bytes, *, base_url: str) -> dict:
    soup = BeautifulSoup(html_bytes, "html.parser")
    news_article = _find_news_article_json(soup)
    title = _string_or_none(news_article.get("headline")) if news_article else None
    if not title:
        heading = soup.select_one("article h1, .article-content h1, h1")
        title = heading.get_text(" ", strip=True) if heading else None

    description = (
        _string_or_none(news_article.get("description")) if news_article else None
    )
    if not description:
        description_meta = soup.select_one(
            'meta[name="description"], meta[property="og:description"]'
        )
        description = (
            description_meta.get("content") if description_meta is not None else None
        )

    authors = _extract_authors(news_article)
    published_at = (
        _string_or_none(news_article.get("datePublished")) if news_article else None
    )
    modified_at = (
        _string_or_none(news_article.get("dateModified")) if news_article else None
    )

    body_node = soup.select_one(
        ".body-copy-v2, [data-component='article-body'], "
        "article .body-content, article [itemprop='articleBody'], article"
    )
    body_html = ""
    body_text = ""
    if body_node is not None:
        clean_soup = BeautifulSoup(str(body_node), "html.parser")
        for unwanted in clean_soup.select(
            "script, style, nav, form, button, aside, "
            "[data-position='in-article'], [data-position='mobile-box']"
        ):
            unwanted.decompose()
        root = clean_soup.find()
        if root is not None:
            body_html = str(root)
            body_text = _normalized_text(root)

    image_urls = _extract_editorial_image_urls(
        soup,
        news_article=news_article,
        base_url=base_url,
    )
    image_groups = group_image_variants(image_urls)
    return {
        "title": title,
        "description": description,
        "authors": authors,
        "publishedAt": published_at,
        "modifiedAt": modified_at,
        "bodyHtml": body_html,
        "bodyText": body_text,
        "imageGroups": image_groups,
    }


def _find_news_article_json(soup: BeautifulSoup) -> dict:
    for script in soup.select('script[type="application/ld+json"]'):
        payload = script.string or script.get_text()
        if not payload.strip():
            continue
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError:
            continue
        for item in _walk_json(decoded):
            item_type = item.get("@type")
            if item_type == "NewsArticle" or (
                isinstance(item_type, list) and "NewsArticle" in item_type
            ):
                return item
    return {}


def _walk_json(value: object) -> Iterable[dict]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json(child)


def _extract_authors(news_article: dict) -> list[str]:
    authors = news_article.get("author") if news_article else None
    if not isinstance(authors, list):
        authors = [authors] if authors else []
    values = []
    for author in authors:
        if isinstance(author, str):
            values.append(author)
        elif isinstance(author, dict) and isinstance(author.get("name"), str):
            values.append(author["name"])
    return values


def _normalized_text(node: Tag) -> str:
    lines = []
    previous = None
    for value in node.get_text("\n", strip=True).splitlines():
        normalized = " ".join(value.split())
        if normalized and normalized != previous:
            lines.append(normalized)
            previous = normalized
    return "\n".join(lines)


def _extract_editorial_image_urls(
    soup: BeautifulSoup,
    *,
    news_article: dict,
    base_url: str,
) -> list[str]:
    candidates: list[str] = []
    if news_article:
        candidates.extend(_image_values(news_article.get("image")))

    for meta in soup.select(
        'meta[property="og:image"], meta[name="twitter:image"], '
        'meta[name="parsely-image-url"]'
    ):
        content = meta.get("content")
        if isinstance(content, str):
            candidates.append(content)

    # Old Bloomberg templates put recommendation cards inside the outer
    # <article> shell. Restrict attribute scanning to the actual body; the
    # lead image is independently covered by JSON-LD and Open Graph metadata.
    body_nodes = soup.select(
        ".body-copy-v2, [data-component='article-body'], "
        "article .body-content, article [itemprop='articleBody']"
    )
    for body_node in body_nodes:
        for tag in body_node.select("img, source, figure"):
            for attribute in (
                "src",
                "data-src",
                "data-native-src",
                "data-image",
                "srcset",
                "data-srcset",
            ):
                value = tag.get(attribute)
                if not isinstance(value, str):
                    continue
                if "srcset" in attribute:
                    candidates.extend(_parse_srcset(value))
                else:
                    candidates.append(value)

    normalized = []
    seen = set()
    for candidate in candidates:
        value = normalize_editorial_image_url(candidate, base_url=base_url)
        if value and value not in seen:
            normalized.append(value)
            seen.add(value)
    return normalized


def _image_values(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        url = value.get("url") or value.get("contentUrl")
        return [url] if isinstance(url, str) else []
    if isinstance(value, list):
        values = []
        for item in value:
            values.extend(_image_values(item))
        return values
    return []


def _parse_srcset(value: str) -> list[str]:
    return [
        part.strip().split()[0]
        for part in value.split(",")
        if part.strip() and part.strip().split()
    ]


def normalize_editorial_image_url(value: str, *, base_url: str) -> str | None:
    value = html.unescape(value.strip())
    value = value.replace("\\/", "/").replace("\\u002F", "/")
    value = re.sub("%3A", ":", value, flags=re.IGNORECASE)
    value = re.sub("%2F", "/", value, flags=re.IGNORECASE)
    if value.startswith("//"):
        value = "https:" + value
    replay_match = WAYBACK_REPLAY_RE.match(value)
    if replay_match:
        value = replay_match.group(1)
    parsed = urlsplit(value)
    if not parsed.scheme and value.startswith("/"):
        base = urlsplit(base_url)
        parsed = urlsplit(urlunsplit((base.scheme, base.netloc, value, "", "")))
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or hostname not in IMAGE_HOSTS:
        return None
    if not any(parsed.path.startswith(prefix) for prefix in IMAGE_PATH_PREFIXES):
        return None
    return urlunsplit(("https", hostname, parsed.path, parsed.query, ""))


def group_image_variants(urls: list[str]) -> list[dict]:
    grouped: dict[str, list[str]] = {}
    for url in urls:
        key = image_variant_key(url)
        grouped.setdefault(key, []).append(url)
    results = []
    for key, variants in grouped.items():
        candidates = derived_image_candidates(variants)
        results.append(
            {
                "assetKey": hashlib.sha256(key.encode("utf-8")).hexdigest(),
                "family": key,
                "originalUrls": variants,
                "candidates": candidates,
            }
        )
    return results


def image_variant_key(url: str) -> str:
    parsed = urlsplit(url)
    path = parsed.path
    directory, _, filename = path.rpartition("/")
    match = DIMENSION_RE.match(filename)
    if not match:
        return urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path, parsed.query, "")
        )
    family_name = (
        "{width}x{height}"
        + match.group("tail")
        + "."
        + match.group("extension").lower()
    )
    return urlunsplit(
        (parsed.scheme, parsed.netloc, f"{directory}/{family_name}", parsed.query, "")
    )


def derived_image_candidates(variants: list[str]) -> list[str]:
    scored: list[tuple[int, str]] = []
    dimensioned = []
    for url in variants:
        filename = urlsplit(url).path.rsplit("/", 1)[-1]
        match = DIMENSION_RE.match(filename)
        if not match:
            scored.append((0, url))
            continue
        width = int(match.group("width"))
        height_token = match.group("height")
        if width == -1:
            scored.append((10**15, url))
            continue
        height = width if height_token == "-1" else int(height_token)
        scored.append((width * max(1, height), url))
        dimensioned.append((url, match, width, height_token))

    ordered = [url for _, url in sorted(scored, key=lambda item: -item[0])]
    if not dimensioned:
        return _dedupe(ordered)

    template_url, template_match, maximum_width, height_token = max(
        dimensioned,
        key=lambda item: item[2],
    )
    parsed = urlsplit(template_url)
    directory = parsed.path.rpartition("/")[0]
    tail = template_match.group("tail")
    extension = template_match.group("extension")
    if height_token == "-1":
        ratio = None
    else:
        ratio = int(height_token) / maximum_width

    for width in (2000, 1600, 1200, 960, 750, 628, 488, 320):
        if width > maximum_width:
            continue
        height_value = "-1" if ratio is None else str(round(width * ratio))
        filename = f"{width}x{height_value}{tail}.{extension}"
        candidate = urlunsplit(
            (
                parsed.scheme,
                parsed.netloc,
                f"{directory}/{filename}",
                parsed.query,
                "",
            )
        )
        ordered.append(candidate)
    return _dedupe(ordered)


def _dedupe(values: Iterable[str]) -> list[str]:
    result = []
    seen = set()
    for value in values:
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result


def download_article(
    article: ManifestArticle,
    *,
    archive_client: ArchiveClient,
    output_dir: Path,
    maximum_html_bytes: int,
    maximum_image_bytes: int,
    download_images: bool = True,
    extractor: Callable[..., dict] = extract_article,
) -> dict:
    result = {
        "url": article.url,
        "httpStatus": None,
        "status": "error",
        "raw": None,
        "title": None,
        "description": None,
        "authors": [],
        "publishedAt": None,
        "modifiedAt": None,
        "bodyText": "",
        "bodyHtml": None,
        "bodyChars": 0,
        "assets": [],
        "imageStatus": "pending",
        "error": None,
    }
    try:
        status, headers, content, final_url = archive_client.fetch(
            article.wayback_snapshot_url,
            maximum_bytes=maximum_html_bytes,
        )
        result["httpStatus"] = status
        if status not in {200, 206}:
            result["error"] = f"article replay returned HTTP {status}"
            result["imageStatus"] = "not_attempted"
            return result
        content_type = headers.get("content-type", "")
        if "html" not in content_type.lower() and not _looks_like_html(content):
            result["error"] = f"article replay is not HTML: {content_type or 'unknown'}"
            result["imageStatus"] = "not_attempted"
            return result

        raw = store_object(
            output_dir,
            kind="html",
            content=content,
            extension="html",
            compress=True,
        )
        extracted = extractor(content, base_url=article.url)
        body_html_bytes = extracted["bodyHtml"].encode("utf-8")
        body_html = (
            store_object(
                output_dir,
                kind="body",
                content=body_html_bytes,
                extension="html",
                compress=True,
            )
            if body_html_bytes
            else None
        )
        result.update(
            {
                "raw": {
                    "path": raw.relative_path,
                    "sha256": raw.sha256,
                    "bytes": raw.byte_count,
                    "finalUrl": final_url,
                },
                "title": extracted["title"],
                "description": extracted["description"],
                "authors": extracted["authors"],
                "publishedAt": extracted["publishedAt"],
                "modifiedAt": extracted["modifiedAt"],
                "bodyText": extracted["bodyText"],
                "bodyHtml": (
                    {
                        "path": body_html.relative_path,
                        "sha256": body_html.sha256,
                        "bytes": body_html.byte_count,
                    }
                    if body_html
                    else None
                ),
                "bodyChars": len(extracted["bodyText"]),
            }
        )

        if not download_images:
            result["imageStatus"] = "skipped"
        else:
            for group in extracted["imageGroups"]:
                result["assets"].append(
                    download_image_group(
                        group,
                        article_timestamp=article.wayback_timestamp,
                        archive_client=archive_client,
                        output_dir=output_dir,
                        maximum_bytes=maximum_image_bytes,
                    )
                )
            downloaded = sum(
                asset["status"] == "complete" for asset in result["assets"]
            )
            if not result["assets"]:
                result["imageStatus"] = "none"
            elif downloaded == len(result["assets"]):
                result["imageStatus"] = "complete"
            elif downloaded:
                result["imageStatus"] = "partial"
            else:
                result["imageStatus"] = "missing"

        content_complete = result["bodyChars"] >= 200
        images_complete = result["imageStatus"] in {"complete", "none", "skipped"}
        result["status"] = "complete" if content_complete and images_complete else "partial"
        if not content_complete:
            result["error"] = (
                f"extracted body is too short ({result['bodyChars']} characters)"
            )
        return result
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        if result["imageStatus"] == "pending":
            result["imageStatus"] = "not_attempted"
        return result


def download_image_group(
    group: dict,
    *,
    article_timestamp: str,
    archive_client: ArchiveClient,
    output_dir: Path,
    maximum_bytes: int,
) -> dict:
    attempts = []
    last_error = None
    discovery_enabled = group.get("discoverArchivedVariants", True)
    queued_candidates = [
        (candidate, article_timestamp)
        for candidate in group["candidates"][:1]
    ]
    tried_urls = set()
    discovery_attempted = False
    while queued_candidates:
        candidate, capture_timestamp = queued_candidates.pop(0)
        if candidate in tried_urls:
            continue
        tried_urls.add(candidate)
        replay_url = (
            f"https://web.archive.org/web/{capture_timestamp}id_/{candidate}"
        )
        try:
            status, headers, content, final_url = archive_client.fetch(
                replay_url,
                maximum_bytes=maximum_bytes,
            )
            content_type = headers.get("content-type", "").split(";", 1)[0].lower()
            attempt = {
                "url": candidate,
                "replayUrl": replay_url,
                "finalUrl": final_url,
                "httpStatus": status,
                "contentType": content_type or None,
                "bytes": len(content),
            }
            attempts.append(attempt)
            if status not in {200, 206}:
                if discovery_enabled and not discovery_attempted:
                    discovery_attempted = True
                    discovered, discovery_record = discover_image_capture(
                        group,
                        archive_client=archive_client,
                    )
                    attempts.append(discovery_record)
                    if discovered:
                        queued_candidates.insert(0, discovered)
                    else:
                        queued_candidates.extend(
                            (value, article_timestamp)
                            for value in group["candidates"][1:]
                        )
                continue
            detected_type = detect_image_type(content)
            if not detected_type:
                last_error = f"non-image response for {candidate}"
                if discovery_enabled and not discovery_attempted:
                    discovery_attempted = True
                    discovered, discovery_record = discover_image_capture(
                        group,
                        archive_client=archive_client,
                    )
                    attempts.append(discovery_record)
                    if discovered:
                        queued_candidates.insert(0, discovered)
                    else:
                        queued_candidates.extend(
                            (value, article_timestamp)
                            for value in group["candidates"][1:]
                        )
                continue
            mime_type, extension = detected_type
            stored = store_object(
                output_dir,
                kind="images",
                content=content,
                extension=extension,
                compress=False,
            )
            return {
                "assetKey": group["assetKey"],
                "originalUrl": group["originalUrls"][0],
                "chosenUrl": candidate,
                "replayUrl": replay_url,
                "finalUrl": final_url,
                "status": "complete",
                "httpStatus": status,
                "mimeType": mime_type,
                "path": stored.relative_path,
                "sha256": stored.sha256,
                "bytes": stored.byte_count,
                "attempts": attempts,
                "error": None,
            }
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            attempts.append(
                {
                    "url": candidate,
                    "replayUrl": replay_url,
                    "httpStatus": None,
                    "error": last_error,
                }
            )
            if discovery_enabled and not discovery_attempted:
                discovery_attempted = True
                discovered, discovery_record = discover_image_capture(
                    group,
                    archive_client=archive_client,
                )
                attempts.append(discovery_record)
                if discovered:
                    queued_candidates.insert(0, discovered)
                else:
                    queued_candidates.extend(
                        (value, article_timestamp)
                        for value in group["candidates"][1:]
                    )

    return {
        "assetKey": group["assetKey"],
        "originalUrl": group["originalUrls"][0],
        "chosenUrl": None,
        "replayUrl": None,
        "finalUrl": None,
        "status": "missing",
        "httpStatus": attempts[-1].get("httpStatus") if attempts else None,
        "mimeType": None,
        "path": None,
        "sha256": None,
        "bytes": 0,
        "attempts": attempts,
        "error": last_error or "no archived candidate returned an image",
    }


def discover_image_capture(
    group: dict,
    *,
    archive_client: ArchiveClient,
) -> tuple[tuple[str, str] | None, dict]:
    original_url = group["originalUrls"][0]
    parsed = urlsplit(original_url)
    directory = parsed.path.rpartition("/")[0] + "/"
    # CDX prefix queries are substantially more reliable in SURT-style
    # host/path form than when the nested URL includes its own scheme.
    query_url = f"{parsed.netloc}{directory}"
    params = [
        ("url", query_url),
        ("matchType", "prefix"),
        ("output", "json"),
        ("fl", "timestamp,original,statuscode,mimetype,digest"),
        ("filter", "statuscode:200"),
        ("filter", r"mimetype:image/.*"),
        ("collapse", "urlkey"),
        ("limit", "200"),
    ]
    cdx_url = str(
        httpx.URL(
            "https://web.archive.org/cdx/search/cdx",
            params=params,
        )
    )
    record = {
        "type": "cdx_discovery",
        "url": cdx_url,
        "httpStatus": None,
        "records": 0,
        "error": None,
    }
    try:
        status, headers, content, final_url = archive_client.fetch(
            cdx_url,
            maximum_bytes=2 * 1024 * 1024,
        )
        record.update(
            {
                "httpStatus": status,
                "finalUrl": final_url,
                "contentType": headers.get("content-type"),
                "bytes": len(content),
            }
        )
        if status not in {200, 206}:
            record["error"] = f"CDX returned HTTP {status}"
            return None, record
        payload = json.loads(content)
        if not isinstance(payload, list) or len(payload) < 2:
            return None, record
        header = payload[0]
        rows = [
            dict(zip(header, row, strict=False))
            for row in payload[1:]
            if isinstance(row, list)
        ]
        record["records"] = len(rows)
        family = group["family"]
        candidates = []
        for row in rows:
            original = row.get("original")
            timestamp = row.get("timestamp")
            if not isinstance(original, str) or not isinstance(timestamp, str):
                continue
            normalized = normalize_editorial_image_url(
                original,
                base_url=original_url,
            )
            if not normalized or image_variant_key(normalized) != family:
                continue
            candidates.append(
                (_image_quality_score(normalized), normalized, timestamp)
            )
        if not candidates:
            return None, record
        _, best_url, best_timestamp = max(candidates, key=lambda item: item[0])
        record["selectedUrl"] = best_url
        record["selectedTimestamp"] = best_timestamp
        return (best_url, best_timestamp), record
    except Exception as exc:
        record["error"] = f"{type(exc).__name__}: {exc}"
        return None, record


def _image_quality_score(url: str) -> tuple[int, int]:
    filename = urlsplit(url).path.rsplit("/", 1)[-1]
    match = DIMENSION_RE.match(filename)
    if not match:
        return 1, 0
    width = int(match.group("width"))
    height_token = match.group("height")
    if width == -1:
        return 3, 0
    height = width if height_token == "-1" else int(height_token)
    return 2, width * max(1, height)


def detect_image_type(content: bytes) -> tuple[str, str] | None:
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", "gif"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp", "webp"
    prefix = content[:512].lstrip().lower()
    if prefix.startswith(b"<svg") or (
        prefix.startswith(b"<?xml") and b"<svg" in prefix
    ):
        return "image/svg+xml", "svg"
    return None


def _looks_like_html(content: bytes) -> bool:
    prefix = content[:1024].lower()
    return b"<html" in prefix or b"<!doctype html" in prefix


def store_object(
    output_dir: Path,
    *,
    kind: str,
    content: bytes,
    extension: str,
    compress: bool,
) -> StoredObject:
    digest = hashlib.sha256(content).hexdigest()
    filename = f"{digest}.{extension}" + (".gz" if compress else "")
    relative_path = Path("objects") / kind / digest[:2] / filename
    destination = output_dir / relative_path
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(
            f".{destination.name}.{uuid.uuid4().hex}.tmp"
        )
        try:
            if compress:
                with temporary.open("wb") as raw_stream:
                    with gzip.GzipFile(
                        fileobj=raw_stream,
                        mode="wb",
                        compresslevel=6,
                        mtime=0,
                    ) as stream:
                        stream.write(content)
            else:
                temporary.write_bytes(content)
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()
    return StoredObject(
        relative_path=relative_path.as_posix(),
        sha256=digest,
        byte_count=len(content),
    )


def pending_articles(
    connection: sqlite3.Connection,
    *,
    retry_errors: bool,
    maximum: int | None,
    maximum_record_attempts: int | None = None,
) -> list[ManifestArticle]:
    statuses = ["pending"]
    if retry_errors:
        statuses.extend(["error", "partial"])
    placeholders = ", ".join("?" for _ in statuses)
    query = f"""
        SELECT
            url, catalog_date, section, wayback_timestamp,
            wayback_snapshot_url, wayback_digest
        FROM articles
        WHERE status IN ({placeholders})
    """
    parameters: list[object] = list(statuses)
    if maximum_record_attempts is not None:
        query += " AND (status='pending' OR attempts < ?)"
        parameters.append(maximum_record_attempts)
    query += " ORDER BY catalog_date, url"
    if maximum is not None:
        query += " LIMIT ?"
        parameters.append(maximum)
    return [
        ManifestArticle(*row)
        for row in connection.execute(query, parameters).fetchall()
    ]


def mark_downloading(
    connection: sqlite3.Connection,
    article: ManifestArticle,
) -> None:
    connection.execute(
        """
        UPDATE articles
        SET status='downloading', attempts=attempts+1,
            last_error=NULL, updated_at=?
        WHERE url=?
        """,
        (datetime.now(timezone.utc).isoformat(), article.url),
    )
    connection.commit()


def record_article_result(
    connection: sqlite3.Connection,
    result: dict,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    raw = result.get("raw") or {}
    body_html = result.get("bodyHtml") or {}
    downloaded = sum(
        asset["status"] == "complete" for asset in result.get("assets", [])
    )
    with connection:
        connection.execute(
            """
            UPDATE articles SET
                status=?, http_status=?, raw_path=?, raw_sha256=?, raw_bytes=?,
                title=?, description=?, authors_json=?, published_at=?,
                modified_at=?, body_text=?, body_html_path=?,
                body_html_sha256=?, body_chars=?, image_references=?,
                images_downloaded=?, image_status=?, last_error=?, updated_at=?
            WHERE url=?
            """,
            (
                result["status"],
                result.get("httpStatus"),
                raw.get("path"),
                raw.get("sha256"),
                raw.get("bytes"),
                result.get("title"),
                result.get("description"),
                json.dumps(result.get("authors", []), ensure_ascii=False),
                result.get("publishedAt"),
                result.get("modifiedAt"),
                result.get("bodyText"),
                body_html.get("path"),
                body_html.get("sha256"),
                result.get("bodyChars", 0),
                len(result.get("assets", [])),
                downloaded,
                result.get("imageStatus", "pending"),
                result.get("error"),
                now,
                result["url"],
            ),
        )
        for ordinal, asset in enumerate(result.get("assets", [])):
            connection.execute(
                """
                INSERT INTO assets(
                    asset_key, original_url, chosen_url, replay_url, final_url,
                    status, http_status, mime_type, local_path, sha256,
                    byte_count, attempts_json, last_error, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_key) DO UPDATE SET
                    chosen_url=excluded.chosen_url,
                    replay_url=excluded.replay_url,
                    final_url=excluded.final_url,
                    status=excluded.status,
                    http_status=excluded.http_status,
                    mime_type=excluded.mime_type,
                    local_path=excluded.local_path,
                    sha256=excluded.sha256,
                    byte_count=excluded.byte_count,
                    attempts_json=excluded.attempts_json,
                    last_error=excluded.last_error,
                    updated_at=excluded.updated_at
                """,
                (
                    asset["assetKey"],
                    asset["originalUrl"],
                    asset.get("chosenUrl"),
                    asset.get("replayUrl"),
                    asset.get("finalUrl"),
                    asset["status"],
                    asset.get("httpStatus"),
                    asset.get("mimeType"),
                    asset.get("path"),
                    asset.get("sha256"),
                    asset.get("bytes", 0),
                    json.dumps(asset.get("attempts", []), ensure_ascii=False),
                    asset.get("error"),
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO article_assets(article_url, asset_key, ordinal)
                VALUES (?, ?, ?)
                ON CONFLICT(article_url, asset_key) DO UPDATE SET
                    ordinal=excluded.ordinal
                """,
                (result["url"], asset["assetKey"], ordinal),
            )


def download_summary(
    connection: sqlite3.Connection,
    *,
    output_dir: Path,
) -> dict:
    by_status = dict(
        connection.execute(
            "SELECT status, COUNT(*) FROM articles GROUP BY status ORDER BY status"
        ).fetchall()
    )
    images_by_status = dict(
        connection.execute(
            """
            SELECT image_status, COUNT(*)
            FROM articles
            GROUP BY image_status
            ORDER BY image_status
            """
        ).fetchall()
    )
    totals = connection.execute(
        """
        SELECT
            COUNT(*),
            COALESCE(SUM(raw_bytes), 0),
            COALESCE(SUM(body_chars), 0),
            COALESCE(SUM(image_references), 0),
            COALESCE(SUM(images_downloaded), 0)
        FROM articles
        """
    ).fetchone()
    asset_totals = connection.execute(
        """
        SELECT COUNT(*), COALESCE(SUM(byte_count), 0)
        FROM assets
        WHERE status='complete'
        """
    ).fetchone()
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "outputDirectory": str(output_dir.resolve()),
        "articleCount": totals[0],
        "articlesByStatus": by_status,
        "imagesByArticleStatus": images_by_status,
        "rawHtmlBytes": totals[1],
        "extractedBodyCharacters": totals[2],
        "editorialImageReferences": totals[3],
        "editorialImagesDownloaded": totals[4],
        "uniqueImageObjects": asset_totals[0],
        "imageBytes": asset_totals[1],
    }


def _string_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
