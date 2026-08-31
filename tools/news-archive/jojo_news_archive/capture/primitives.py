from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime, timezone
import gzip
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from bs4 import BeautifulSoup

from jojo_news_archive.discovery.client import ArchiveClient
from jojo_news_archive.models import (
    BlobReference,
    CaptureCandidate,
    CaptureProvider,
)
from jojo_news_archive.sources.capture_contracts import (
    ManifestItem,
    SourceCaptureHooks,
)
from jojo_news_archive.sources.registry import registered_sources, source_module
from jojo_news_archive.sources.runtime import capture_hooks


WAYBACK_TIMEMAP_ENDPOINT = "https://web.archive.org/web/timemap/json"
WAYBACK_TIMEMAP_MAXIMUM_BYTES = 2_000_000
WAYBACK_TIMEMAP_MAXIMUM_CANDIDATES = 8
SYNDICATION_SEARCH_ENDPOINT = "https://search.yahoo.com/search"
SYNDICATION_SEARCH_MAXIMUM_BYTES = 2_000_000

_PARSED_PAYWALL_PHRASES = (
    "subscribe to read",
    "subscribe to continue",
    "sign in to continue",
    "already a subscriber",
    "unlock this article",
)
_PARSED_PAYWALL_MAXIMUM_BODY_CHARACTERS = 1_000
_SYNDICATION_STOP_WORDS = {
    "a", "after", "an", "and", "as", "at", "by", "for", "from",
    "in", "of", "on", "s", "the", "to", "with",
}


def headline_slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", errors="ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.casefold()).strip("-")


def syndication_search_url(
    item: ManifestItem,
    *,
    publisher_label: str,
) -> str:
    parsed = urlsplit(item.canonical_url)
    slug = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    slug_hook = capture_hooks(item.publisher).syndication_search_slug
    if slug_hook is not None:
        slug = slug_hook(slug)
    words = " ".join(part for part in slug.split("-") if part)
    query = f"{words} {publisher_label}"
    return SYNDICATION_SEARCH_ENDPOINT + "?" + urlencode({"p": query})


def meta_tag_content(
    soup: BeautifulSoup,
    attribute: str,
    value: str,
) -> str | None:
    node = soup.select_one(f'meta[{attribute}="{value}"]')
    content = node.get("content") if node is not None else None
    return content.strip() if isinstance(content, str) and content.strip() else None


def walk_json_dicts(value: object) -> Iterable[dict[str, object]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_json_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json_dicts(child)


def decode_duckduckgo_search_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    absolute = "https:" + value if value.startswith("//") else value
    parsed = urlsplit(absolute)
    candidate_url = parse_qs(parsed.query).get("uddg", [absolute])[0]
    candidate = urlsplit(candidate_url)
    if candidate.scheme not in {"http", "https"} or not candidate.netloc:
        return None
    return candidate_url


def decode_yahoo_search_result(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.search(r"/RU=([^/]+)/RK=", value)
    candidate_url = unquote(match.group(1)) if match else value
    parsed = urlsplit(candidate_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return candidate_url


def yahoo_search_results(
    soup: BeautifulSoup,
    *,
    clean_title: Callable[[str], str] | None = None,
) -> list[tuple[int, str, str]]:
    results: list[tuple[int, str, str]] = []
    for position, result in enumerate(soup.select("#web li")):
        anchor = (
            result.select_one(".compTitle > a")
            or result.select_one("h3 a")
            or result.select_one("a")
        )
        heading = result.select_one("h3")
        if anchor is None or heading is None:
            continue
        candidate_url = decode_yahoo_search_result(anchor.get("href"))
        if candidate_url is None:
            continue
        raw_title = heading.get_text(" ", strip=True)
        result_title = clean_title(raw_title) if clean_title is not None else raw_title
        results.append((position, result_title, candidate_url))
    return results


def discover_syndication_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    search_url: str,
    excluded_publisher: str,
) -> tuple[CaptureCandidate, ...]:
    results = fetch_syndication_search_results(
        item,
        archive_client=archive_client,
        search_url=search_url,
    )
    return rank_syndication_candidates(
        results,
        excluded_publisher=excluded_publisher,
    )


def fetch_syndication_search_results(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    search_url: str,
) -> list[tuple[int, str, str]]:
    status_code, headers, content, _ = archive_client.fetch(
        search_url,
        maximum_bytes=SYNDICATION_SEARCH_MAXIMUM_BYTES,
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        raise ValueError(
            f"{item.publisher} syndication search returned HTTP {status_code}"
        )
    if "html" not in content_type and b"<html" not in content[:1_000].lower():
        raise ValueError(
            f"{item.publisher} syndication search did not return HTML"
        )

    soup = BeautifulSoup(content, "html.parser")
    results: list[tuple[int, str, str]] = []
    cleaner = capture_hooks(item.publisher).clean_syndication_search_title
    if cleaner is None:
        cleaner = clean_syndication_search_title
    for position, result in enumerate(soup.select("#web li")):
        anchor = result.select_one("h3 a") or result.select_one("a")
        heading = result.select_one("h3")
        if anchor is None:
            continue
        candidate_url = decode_yahoo_search_result(anchor.get("href"))
        if candidate_url is None:
            continue
        title = cleaner(heading.get_text(" ", strip=True)) if heading else ""
        results.append((position, title, candidate_url))
    return results


def rank_syndication_candidates(
    results: Iterable[tuple[int, str, str]],
    *,
    excluded_publisher: str,
    expected_headline: str | None = None,
) -> tuple[CaptureCandidate, ...]:
    ranked: list[tuple[float, int, int, str]] = []
    hooks = capture_hooks(excluded_publisher)
    normalize_url = hooks.normalize_syndication_candidate_url or (lambda value: value)
    url_priority = hooks.syndication_candidate_priority or (lambda value: 0)
    seen: set[str] = set()
    for position, result_title, candidate_url in results:
        candidate_url = normalize_url(candidate_url)
        if (
            candidate_url in seen
            or not is_public_syndication_url(
                candidate_url,
                excluded_publisher=excluded_publisher,
            )
        ):
            continue
        overlap = (
            headline_text_overlap(expected_headline, result_title)
            if expected_headline and result_title
            else 0.0
        )
        if expected_headline and overlap < 0.35:
            continue
        seen.add(candidate_url)
        ranked.append((-overlap, url_priority(candidate_url), position, candidate_url))
    ranked.sort()
    return tuple(
        CaptureCandidate(
            provider=CaptureProvider.OTHER,
            snapshot_url=candidate_url,
            expected_headline=expected_headline,
        )
        for _, _, _, candidate_url in ranked[: hooks.syndication_maximum_candidates]
    )


def is_archive_today_candidate_url(value: str) -> bool:
    parsed = urlsplit(value)
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").casefold()
        in {"archive.is", "archive.md", "archive.ph", "archive.today", "archive.vn"}
        and parsed.path not in {"", "/"}
    )


def clean_syndication_search_title(value: str) -> str:
    return re.sub(r"\s*(?:…|\.\.\.)\s*$", "", value.strip()).strip()


def html_links_to_article(html_value: str, canonical_url: str) -> bool:
    soup = BeautifulSoup(html_value, "html.parser")
    return any(
        same_article_url(href, canonical_url)
        for anchor in soup.select("a[href]")
        if isinstance(href := anchor.get("href"), str)
    )


def is_public_syndication_url(value: str, *, excluded_publisher: str) -> bool:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").casefold().rstrip(".")
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
    ):
        return False
    try:
        if parsed.port not in {None, 80, 443}:
            return False
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return False
    source = source_module(excluded_publisher)
    excluded_domains = {
        source.archive_spec.canonical_host.casefold().removeprefix("www."),
        *(domain.casefold().removeprefix("www.") for domain in source.archive_spec.alternate_hosts),
        *(domain.casefold().removeprefix("www.") for domain in source.parser_spec.domains),
    }
    if any(host == domain or host.endswith("." + domain) for domain in excluded_domains):
        return False
    return not (
        host in {"search.yahoo.com", "www.google.com", "www.bing.com"}
        or host.startswith("video.search.")
        or parsed.path.startswith(("/search", "/search/"))
    )


def short_parsed_paywall_shell(*, body_characters: int, plain_text: str) -> bool:
    prefix = plain_text[:1_500].casefold()
    return bool(
        body_characters < _PARSED_PAYWALL_MAXIMUM_BODY_CHARACTERS
        and any(phrase in prefix for phrase in _PARSED_PAYWALL_PHRASES)
    )


def syndication_headline_overlap(
    canonical_url: str,
    headline: str,
    *,
    strip_iso_date_suffix: bool = False,
) -> float:
    slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
    if strip_iso_date_suffix:
        slug = re.sub(r"-20\d{2}-\d{2}-\d{2}$", "", slug)
    slug_tokens = significant_tokens(slug.replace("-", " "))
    headline_tokens = significant_tokens(headline)
    if not slug_tokens or not headline_tokens:
        return 0.0
    return len(slug_tokens & headline_tokens) / min(len(slug_tokens), len(headline_tokens))


def headline_text_overlap(first: str, second: str) -> float:
    first_tokens = significant_tokens(first)
    second_tokens = significant_tokens(second)
    if not first_tokens or not second_tokens:
        return 0.0
    return len(first_tokens & second_tokens) / min(len(first_tokens), len(second_tokens))


def expected_date_visible(content: bytes, *, expected_date: datetime | None) -> bool:
    if expected_date is None:
        return False
    text = BeautifulSoup(content, "html.parser").get_text(" ", strip=True)
    raw = content.decode("utf-8", errors="ignore")
    month = expected_date.strftime("%B")
    abbreviated_month = expected_date.strftime("%b")
    values = (
        expected_date.strftime("%Y-%m-%d"),
        f"{month} {expected_date.day}, {expected_date.year}",
        f"{abbreviated_month} {expected_date.day}, {expected_date.year}",
        f"{expected_date.day} {month} {expected_date.year}",
        f"{expected_date.day} {abbreviated_month} {expected_date.year}",
    )
    haystack = raw.casefold() + "\n" + text.casefold()
    return any(value.casefold() in haystack for value in values)


def nearest_visible_date_delta_days(
    visible_text: str,
    *,
    expected_date: datetime | None,
) -> int | None:
    if expected_date is None:
        return None
    patterns = (
        (r"\b20\d{2}-\d{2}-\d{2}\b", "%Y-%m-%d"),
        (r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b", "%B %d %Y"),
        (r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+20\d{2}\b", "%b %d %Y"),
        (r"\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b", "%d %B %Y"),
        (r"\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+20\d{2}\b", "%d %b %Y"),
    )
    deltas: list[int] = []
    for pattern, date_format in patterns:
        for match in re.finditer(pattern, visible_text[:4_000], flags=re.IGNORECASE):
            normalized = re.sub(r"(?<=\b[A-Za-z]{3})\.", "", match.group(0)).replace(",", "")
            try:
                parsed = datetime.strptime(normalized, date_format)
            except ValueError:
                continue
            deltas.append(abs((parsed.date() - expected_date.date()).days))
    return min(deltas) if deltas else None


def significant_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if token not in _SYNDICATION_STOP_WORDS
    }


def fetch_limited_archive(
    archive_client: ArchiveClient,
    url: str,
    *,
    maximum_bytes: int,
    attempts: int,
    timeout: float,
) -> tuple[int, dict[str, str], bytes, str]:
    try:
        return archive_client.fetch_limited(
            url,
            maximum_bytes=maximum_bytes,
            attempts=attempts,
            timeout=timeout,
        )
    except AttributeError:
        return archive_client.fetch(url, maximum_bytes=maximum_bytes)


def capture_hooks_for_source_url(value: str | None) -> SourceCaptureHooks | None:
    host = (urlsplit(value or "").hostname or "").casefold().removeprefix("www.")
    for source in registered_sources():
        domains = {
            source.archive_spec.canonical_host.casefold().removeprefix("www."),
            *(domain.casefold().removeprefix("www.") for domain in source.parser_spec.domains),
            *(domain.casefold().removeprefix("www.") for domain in source.archive_spec.alternate_hosts),
        }
        if host in domains:
            return capture_hooks(source.id)
    return None


def archive_url_match_key(value: str) -> tuple[str, str]:
    parts = urlsplit(value)
    host = (parts.hostname or "").casefold().removeprefix("www.")
    normalized_path = parts.path.rstrip("/")
    for source in registered_sources():
        domains = {
            domain.casefold().removeprefix("www.")
            for domain in source.parser_spec.domains
        }
        domains.add(source.archive_spec.canonical_host.casefold().removeprefix("www."))
        if host not in domains:
            continue
        hook = capture_hooks(source.id).archive_match_path
        if hook is not None:
            normalized_path = hook(host, normalized_path)
        break
    return host, normalized_path


def same_article_url(first: str, second: str) -> bool:
    first_key = archive_url_match_key(first)
    second_key = archive_url_match_key(second)
    return bool(first_key[0]) and first_key == second_key


def common_crawl_discovery_urls(item: ManifestItem) -> tuple[str, ...]:
    hook = capture_hooks(item.publisher).archive_discovery_urls
    if hook is None:
        return (item.canonical_url,)
    return tuple(dict.fromkeys(hook(item.canonical_url)))


def timemap_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[float, str]:
    timestamp = candidate.captured_at
    if timestamp is None:
        return (float("inf"), candidate.snapshot_url)
    published = parse_iso_datetime(published_at)
    if published is None:
        return (timestamp.timestamp(), candidate.snapshot_url)
    return (abs((timestamp - published).total_seconds()), candidate.snapshot_url)


def common_crawl_first_candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: str | None,
) -> tuple[bool, bool, int, tuple[float, str]]:
    return (
        candidate.provider != CaptureProvider.COMMON_CRAWL,
        candidate.byte_count is None,
        -(candidate.byte_count or 0),
        timemap_candidate_sort_key(candidate, published_at=published_at),
    )


def largest_distinct_timemap_candidates(
    candidates: tuple[CaptureCandidate, ...],
    *,
    maximum_candidates: int,
    published_at: str | None,
) -> tuple[CaptureCandidate, ...]:
    largest = sorted(
        candidates,
        key=lambda candidate: (
            candidate.byte_count is None,
            -(candidate.byte_count or 0),
            timemap_candidate_sort_key(candidate, published_at=published_at),
        ),
    )
    selected: list[CaptureCandidate] = []
    seen_urls: set[str] = set()

    def append(candidate: CaptureCandidate) -> None:
        if candidate.snapshot_url not in seen_urls and len(selected) < maximum_candidates:
            seen_urls.add(candidate.snapshot_url)
            selected.append(candidate)

    for candidate in largest[: max(1, maximum_candidates // 2)]:
        append(candidate)
    for candidate in candidates:
        append(candidate)
    for candidate in largest:
        append(candidate)
    return tuple(selected)


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def wayback_datetime(timestamp: str) -> datetime | None:
    if not re.fullmatch(r"\d{14}", timestamp):
        return None
    return datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def optional_string(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _timemap_value(row: list[object], columns: dict[str, int], name: str) -> str:
    index = columns.get(name)
    if index is None or index >= len(row):
        return ""
    return str(row[index]).strip()


def discover_wayback_timemap_candidates(
    item: ManifestItem,
    *,
    archive_client: ArchiveClient,
    maximum_candidates: int = WAYBACK_TIMEMAP_MAXIMUM_CANDIDATES,
    _include_companions: bool = True,
) -> tuple[CaptureCandidate, ...]:
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    companion_candidates: tuple[CaptureCandidate, ...] | None = None
    companion_items: tuple[ManifestItem, ...] = ()
    companion_hook = capture_hooks(item.publisher).timemap_companion_urls
    if _include_companions and companion_hook is not None:
        companion_items = tuple(
            ManifestItem(
                publisher=item.publisher,
                canonical_url=url,
                published_at=item.published_at,
                section=item.section,
                candidates=(),
            )
            for url in companion_hook(item.canonical_url)
            if url != item.canonical_url
        )

    def fallback_companion_candidates() -> tuple[CaptureCandidate, ...]:
        nonlocal companion_candidates
        if companion_candidates is not None:
            return companion_candidates
        collected: list[CaptureCandidate] = []
        for companion_item in companion_items:
            try:
                collected.extend(
                    discover_wayback_timemap_candidates(
                        companion_item,
                        archive_client=archive_client,
                        maximum_candidates=maximum_candidates,
                        _include_companions=False,
                    )
                )
            except Exception:
                continue
        companion_candidates = tuple(collected[:maximum_candidates])
        return companion_candidates

    timemap_url = WAYBACK_TIMEMAP_ENDPOINT + "?" + urlencode({"url": item.canonical_url})
    try:
        configured_attempts = int(archive_client.attempts)
    except AttributeError:
        configured_attempts = 2
    try:
        configured_timeout = float(archive_client.timeout)
    except AttributeError:
        configured_timeout = 35.0
    status_code, headers, content, _ = fetch_limited_archive(
        archive_client,
        timemap_url,
        maximum_bytes=WAYBACK_TIMEMAP_MAXIMUM_BYTES,
        attempts=min(2, max(1, configured_attempts)),
        timeout=min(35.0, max(0.1, configured_timeout)),
    )
    content_type = headers.get("content-type", "").casefold()
    if status_code != 200 or not content:
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError(f"Wayback timemap returned HTTP {status_code}")
    if "json" not in content_type and not content.lstrip().startswith(b"["):
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        raise ValueError("Wayback timemap did not return JSON")
    payload = json.loads(content)
    if not isinstance(payload, list) or not payload:
        companions = fallback_companion_candidates()
        if companions:
            return companions[:maximum_candidates]
        return ()
    header = payload[0]
    if not isinstance(header, list):
        raise ValueError("Wayback timemap header is invalid")
    columns = {str(value).casefold(): index for index, value in enumerate(header)}
    if not {"timestamp", "original", "mimetype", "statuscode"}.issubset(columns):
        raise ValueError("Wayback timemap is missing required columns")

    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    for row in payload[1:]:
        if not isinstance(row, list):
            continue
        timestamp = _timemap_value(row, columns, "timestamp")
        original = _timemap_value(row, columns, "original")
        mime_type = _timemap_value(row, columns, "mimetype")
        status = optional_int(_timemap_value(row, columns, "statuscode"))
        if (
            wayback_datetime(timestamp) is None
            or status != 200
            or mime_type.casefold() != "text/html"
            or not same_article_url(original, item.canonical_url)
        ):
            continue
        digest = optional_string(_timemap_value(row, columns, "digest"))
        deduplication_key = digest or f"{timestamp}:{original}"
        if deduplication_key in seen:
            continue
        seen.add(deduplication_key)
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.WAYBACK,
                snapshot_url=f"https://web.archive.org/web/{timestamp}id_/{original}",
                captured_at=wayback_datetime(timestamp),
                digest=digest,
                mime_type=mime_type,
                status_code=status,
                byte_count=optional_int(_timemap_value(row, columns, "length")),
            )
        )

    companions = fallback_companion_candidates() if not candidates else ()
    seen_urls = {candidate.snapshot_url for candidate in candidates}
    for candidate in companions:
        if candidate.snapshot_url not in seen_urls:
            candidates.append(candidate)
            seen_urls.add(candidate.snapshot_url)
    candidates.sort(key=lambda candidate: timemap_candidate_sort_key(candidate, published_at=item.published_at))
    selection_hook = capture_hooks(item.publisher).select_timemap_candidates
    if selection_hook is None:
        return tuple(candidates[:maximum_candidates])
    return selection_hook(
        tuple(candidates),
        maximum_candidates=maximum_candidates,
        published_at=item.published_at,
    )


def store_dependent_resource(output_dir: Path, content: bytes) -> BlobReference:
    digest = hashlib.sha256(content).hexdigest()
    relative = Path("objects") / "resources" / digest[:2] / f"{digest}.bin.gz"
    destination = output_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    if destination.exists():
        if destination.read_bytes() != compressed:
            raise RuntimeError(f"content-addressed object collision: {relative}")
    else:
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(compressed)
        temporary.replace(destination)
    return BlobReference(
        path=relative.as_posix(),
        sha256=digest,
        byte_count=len(content),
        stored_byte_count=len(compressed),
        content_encoding="gzip",
    )


__all__ = [
    "SYNDICATION_SEARCH_ENDPOINT",
    "SYNDICATION_SEARCH_MAXIMUM_BYTES",
    "WAYBACK_TIMEMAP_ENDPOINT",
    "WAYBACK_TIMEMAP_MAXIMUM_BYTES",
    "WAYBACK_TIMEMAP_MAXIMUM_CANDIDATES",
    "archive_url_match_key",
    "capture_hooks_for_source_url",
    "clean_syndication_search_title",
    "common_crawl_discovery_urls",
    "common_crawl_first_candidate_sort_key",
    "decode_duckduckgo_search_result",
    "discover_syndication_candidates",
    "discover_wayback_timemap_candidates",
    "expected_date_visible",
    "fetch_limited_archive",
    "fetch_syndication_search_results",
    "headline_slug",
    "headline_text_overlap",
    "html_links_to_article",
    "is_archive_today_candidate_url",
    "is_public_syndication_url",
    "largest_distinct_timemap_candidates",
    "meta_tag_content",
    "nearest_visible_date_delta_days",
    "parse_iso_datetime",
    "rank_syndication_candidates",
    "same_article_url",
    "short_parsed_paywall_shell",
    "significant_tokens",
    "store_dependent_resource",
    "syndication_headline_overlap",
    "syndication_search_url",
    "timemap_candidate_sort_key",
    "walk_json_dicts",
    "yahoo_search_results",
]
