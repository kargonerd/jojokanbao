from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import json
import re
import threading
from typing import Protocol
from urllib.parse import urlencode, urlsplit
import zlib

from .news_models import CaptureCandidate, CaptureProvider


COLLECTION_INFO_URL = "https://index.commoncrawl.org/collinfo.json"
DATA_BASE_URL = "https://data.commoncrawl.org/"
COLLECTION_INFO_MAXIMUM_BYTES = 2_000_000
INDEX_RESULT_MAXIMUM_BYTES = 2_000_000
MAXIMUM_COLLECTIONS_PER_ARTICLE = 3
MAXIMUM_CANDIDATES_PER_ARTICLE = 3
MAXIMUM_COMPRESSED_WARC_BYTES = 25_000_000
_COLLECTION_CACHE_LOCK = threading.Lock()


class CommonCrawlCircuitOpenError(RuntimeError):
    """The shared Common Crawl index transport is temporarily cooling down."""


class CommonCrawlClient(Protocol):
    def fetch(
        self,
        url: str,
        *,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]: ...

    def fetch_range(
        self,
        url: str,
        *,
        offset: int,
        length: int,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]: ...


@dataclass(frozen=True)
class CommonCrawlCollection:
    identifier: str
    index_url: str
    from_at: datetime
    to_at: datetime


def discover_common_crawl_candidates(
    canonical_url: str,
    *,
    published_at: str | None,
    archive_client: CommonCrawlClient,
    maximum_collections: int = MAXIMUM_COLLECTIONS_PER_ARTICLE,
) -> tuple[CaptureCandidate, ...]:
    published = _parse_datetime(published_at)
    collections = _rank_collections(
        _load_collections(archive_client),
        published_at=published,
    )[:maximum_collections]
    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    completed_queries = 0
    last_error: Exception | None = None
    for collection in collections:
        query_url = collection.index_url + "?" + urlencode(
            [
                ("url", canonical_url),
                ("matchType", "exact"),
                ("output", "json"),
                ("filter", "status:200"),
                ("filter", "mime:text/html"),
                ("collapse", "digest"),
            ]
        )
        try:
            status, _, content, _ = _fetch_limited(
                archive_client,
                query_url,
                maximum_bytes=INDEX_RESULT_MAXIMUM_BYTES,
                attempts=1,
                timeout=25.0,
            )
        except Exception as exc:
            last_error = exc
            continue
        completed_queries += 1
        if status == 404 or not content:
            continue
        if status != 200:
            raise ValueError(
                f"Common Crawl index {collection.identifier} returned "
                f"HTTP {status}"
            )
        for line in content.splitlines():
            try:
                row = json.loads(line)
            except (TypeError, ValueError):
                continue
            candidate = _candidate_from_index_row(
                row,
                canonical_url=canonical_url,
            )
            if candidate is None:
                continue
            key = candidate.digest or (
                f"{candidate.warc_filename}:"
                f"{candidate.warc_offset}:{candidate.warc_length}"
            )
            if key in seen:
                continue
            seen.add(key)
            candidates.append(candidate)

    if completed_queries == 0 and last_error is not None:
        raise last_error
    candidates.sort(
        key=lambda candidate: _candidate_sort_key(
            candidate,
            published_at=published,
        )
    )
    return tuple(candidates[:MAXIMUM_CANDIDATES_PER_ARTICLE])


def fetch_common_crawl_candidate(
    candidate: CaptureCandidate,
    *,
    archive_client: CommonCrawlClient,
    maximum_html_bytes: int,
) -> tuple[int, dict[str, str], bytes, str]:
    if candidate.provider != CaptureProvider.COMMON_CRAWL:
        raise ValueError("candidate is not from Common Crawl")
    if (
        not candidate.warc_filename
        or candidate.warc_offset is None
        or candidate.warc_length is None
    ):
        raise ValueError("Common Crawl candidate is missing WARC coordinates")
    if candidate.warc_length > MAXIMUM_COMPRESSED_WARC_BYTES:
        raise ValueError("Common Crawl WARC record exceeds safety limit")
    status, _, compressed, _ = archive_client.fetch_range(
        candidate.snapshot_url,
        offset=candidate.warc_offset,
        length=candidate.warc_length,
        maximum_bytes=MAXIMUM_COMPRESSED_WARC_BYTES,
    )
    if status != 206 or not compressed:
        return status, {}, b"", candidate.snapshot_url
    response_status, headers, content, target_url = _decode_warc_response(
        compressed
    )
    if len(content) > maximum_html_bytes:
        raise ValueError(
            f"Common Crawl HTML exceeds {maximum_html_bytes} bytes"
        )
    return response_status, headers, content, target_url


def _load_collections(
    archive_client: CommonCrawlClient,
) -> tuple[CommonCrawlCollection, ...]:
    cached = getattr(
        archive_client,
        "_jojo_common_crawl_collections",
        None,
    )
    if cached is not None:
        return cached
    with _COLLECTION_CACHE_LOCK:
        cached = getattr(
            archive_client,
            "_jojo_common_crawl_collections",
            None,
        )
        if cached is not None:
            return cached
        status, headers, content, _ = _fetch_limited(
            archive_client,
            COLLECTION_INFO_URL,
            maximum_bytes=COLLECTION_INFO_MAXIMUM_BYTES,
            attempts=2,
            timeout=35.0,
        )
        content_type = headers.get("content-type", "").casefold()
        if status != 200 or not content:
            raise ValueError(
                f"Common Crawl collection list returned HTTP {status}"
            )
        if "json" not in content_type and not content.lstrip().startswith(b"["):
            raise ValueError("Common Crawl collection list is not JSON")
        payload = json.loads(content)
        collections: list[CommonCrawlCollection] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            identifier = str(row.get("id") or "").strip()
            index_url = str(row.get("cdx-api") or "").strip()
            from_at = _parse_datetime(str(row.get("from") or ""))
            to_at = _parse_datetime(str(row.get("to") or ""))
            if (
                not identifier
                or not index_url.startswith(
                    "https://index.commoncrawl.org/"
                )
                or from_at is None
                or to_at is None
            ):
                continue
            collections.append(
                CommonCrawlCollection(
                    identifier=identifier,
                    index_url=index_url,
                    from_at=from_at,
                    to_at=to_at,
                )
            )
        if not collections:
            raise ValueError("Common Crawl collection list is empty")
        result = tuple(collections)
        setattr(
            archive_client,
            "_jojo_common_crawl_collections",
            result,
        )
        return result


def _rank_collections(
    collections: tuple[CommonCrawlCollection, ...],
    *,
    published_at: datetime | None,
) -> list[CommonCrawlCollection]:
    if published_at is None:
        return sorted(
            collections,
            key=lambda collection: collection.to_at,
            reverse=True,
        )

    def key(
        collection: CommonCrawlCollection,
    ) -> tuple[float, int, float]:
        if collection.from_at <= published_at <= collection.to_at:
            distance = 0.0
            relation = 0
        elif collection.from_at > published_at:
            distance = (collection.from_at - published_at).total_seconds()
            relation = 1
        else:
            distance = (published_at - collection.to_at).total_seconds()
            relation = 2
        return distance, relation, -collection.to_at.timestamp()

    return sorted(collections, key=key)


def _candidate_from_index_row(
    row: object,
    *,
    canonical_url: str,
) -> CaptureCandidate | None:
    if not isinstance(row, dict):
        return None
    original_url = str(row.get("url") or "").strip()
    filename = str(row.get("filename") or "").strip()
    mime_type = str(row.get("mime") or "").strip()
    status = _optional_int(row.get("status"))
    offset = _optional_int(row.get("offset"))
    length = _optional_int(row.get("length"))
    captured_at = _parse_common_crawl_timestamp(row.get("timestamp"))
    if (
        not _same_article_url(original_url, canonical_url)
        or not filename.startswith("crawl-data/")
        or mime_type.casefold() != "text/html"
        or status != 200
        or offset is None
        or offset < 0
        or length is None
        or not 0 < length <= MAXIMUM_COMPRESSED_WARC_BYTES
        or captured_at is None
    ):
        return None
    return CaptureCandidate(
        provider=CaptureProvider.COMMON_CRAWL,
        snapshot_url=DATA_BASE_URL + filename,
        captured_at=captured_at,
        digest=_optional_string(row.get("digest")),
        mime_type=mime_type,
        status_code=status,
        byte_count=length,
        warc_filename=filename,
        warc_offset=offset,
        warc_length=length,
    )


def _decode_warc_response(
    compressed: bytes,
) -> tuple[int, dict[str, str], bytes, str]:
    try:
        record = gzip.decompress(compressed)
    except (EOFError, OSError) as exc:
        raise ValueError("Common Crawl WARC record is not valid gzip") from exc
    warc_header, payload = _split_headers(record)
    warc_headers = _parse_headers(warc_header)
    warc_type = warc_headers.get("warc-type", "").casefold()
    if warc_type != "response":
        raise ValueError(
            f"Common Crawl WARC type {warc_type or 'unknown'} is not response"
        )
    warc_truncated = warc_headers.get("warc-truncated", "").strip()
    if warc_truncated:
        raise ValueError(
            f"Common Crawl WARC response is origin-truncated ({warc_truncated})"
        )
    target_url = warc_headers.get("warc-target-uri", "")
    if not target_url.startswith(("http://", "https://")):
        raise ValueError("Common Crawl WARC target URL is invalid")
    warc_content_length = _optional_int(warc_headers.get("content-length"))
    if warc_content_length is not None:
        if warc_content_length < 1 or warc_content_length > len(payload):
            raise ValueError("Common Crawl WARC payload is truncated")
        # A gzip member may be followed by the WARC record separator. Respect
        # the outer record length before decoding the embedded HTTP response.
        payload = payload[:warc_content_length]

    http_header, content = _split_headers(payload)
    lines = http_header.replace(b"\r\n", b"\n").split(b"\n")
    if not lines:
        raise ValueError("Common Crawl WARC HTTP response is empty")
    status_match = re.match(
        rb"HTTP/\d(?:\.\d)?\s+(\d{3})(?:\s|$)",
        lines[0],
        re.IGNORECASE,
    )
    if status_match is None:
        raise ValueError("Common Crawl WARC HTTP status line is invalid")
    status = int(status_match.group(1))
    headers = _parse_headers(b"\n".join(lines[1:]))
    if "chunked" in headers.get("transfer-encoding", "").casefold():
        content = _decode_chunked(content)
        headers.pop("transfer-encoding", None)
    content_encoding = headers.get("content-encoding", "").casefold()
    if content_encoding in {"gzip", "x-gzip"}:
        if content.startswith(b"\x1f\x8b"):
            try:
                content = gzip.decompress(content)
            except (EOFError, OSError) as exc:
                raise ValueError(
                    "Common Crawl HTTP gzip body is invalid"
                ) from exc
        elif not _looks_like_already_decoded_html(content, headers=headers):
            raise ValueError(
                "Common Crawl HTTP gzip body has no gzip framing"
            )
        headers.pop("content-encoding", None)
        # This length describes the encoded origin response. Some historical
        # WARC records store a decoded payload but retain the original headers;
        # in either case it must not truncate the decoded HTML below.
        headers.pop("content-length", None)
    elif content_encoding == "deflate":
        if not _looks_like_already_decoded_html(content, headers=headers):
            try:
                content = zlib.decompress(content)
            except zlib.error:
                try:
                    content = zlib.decompress(content, -zlib.MAX_WBITS)
                except zlib.error as exc:
                    raise ValueError(
                        "Common Crawl HTTP deflate body is invalid"
                    ) from exc
        headers.pop("content-encoding", None)
        headers.pop("content-length", None)
    content_length = _optional_int(headers.get("content-length"))
    if content_length is not None and content_length <= len(content):
        content = content[:content_length]
    return status, headers, content, target_url


def _looks_like_already_decoded_html(
    content: bytes,
    *,
    headers: dict[str, str],
) -> bool:
    content_type = headers.get("content-type", "").casefold()
    if "html" not in content_type and "xhtml" not in content_type:
        return False
    return content.lstrip(b"\x00\x09\x0a\x0c\x0d\x20\xef\xbb\xbf").startswith(
        b"<"
    )


def _split_headers(content: bytes) -> tuple[bytes, bytes]:
    for separator in (b"\r\n\r\n", b"\n\n"):
        head, found, tail = content.partition(separator)
        if found:
            return head, tail
    raise ValueError("archive response is missing a header separator")


def _parse_headers(content: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    current: str | None = None
    for raw_line in content.replace(b"\r\n", b"\n").split(b"\n"):
        if raw_line.startswith((b" ", b"\t")) and current is not None:
            headers[current] += " " + raw_line.decode(
                "latin-1",
                errors="replace",
            ).strip()
            continue
        name, separator, value = raw_line.partition(b":")
        if not separator:
            current = None
            continue
        current = name.decode("latin-1", errors="replace").strip().casefold()
        headers[current] = value.decode(
            "latin-1",
            errors="replace",
        ).strip()
    return headers


def _decode_chunked(content: bytes) -> bytes:
    output = bytearray()
    position = 0
    while True:
        line_end = content.find(b"\r\n", position)
        separator_size = 2
        if line_end < 0:
            line_end = content.find(b"\n", position)
            separator_size = 1
        if line_end < 0:
            raise ValueError("chunked archive response is truncated")
        size_token = content[position:line_end].split(b";", 1)[0].strip()
        try:
            size = int(size_token, 16)
        except ValueError as exc:
            raise ValueError("chunked archive response has invalid size") from exc
        position = line_end + separator_size
        if size == 0:
            return bytes(output)
        end = position + size
        if end > len(content):
            raise ValueError("chunked archive response is truncated")
        output.extend(content[position:end])
        position = end
        if content[position:position + 2] == b"\r\n":
            position += 2
        elif content[position:position + 1] == b"\n":
            position += 1
        else:
            raise ValueError("chunked archive response has invalid framing")


def _candidate_sort_key(
    candidate: CaptureCandidate,
    *,
    published_at: datetime | None,
) -> tuple[float, str]:
    captured = candidate.captured_at
    if captured is None:
        return float("inf"), candidate.snapshot_url
    if published_at is None:
        return -captured.timestamp(), candidate.snapshot_url
    return (
        abs((captured - published_at).total_seconds()),
        candidate.snapshot_url,
    )


def _same_article_url(first: str, second: str) -> bool:
    first_parts = urlsplit(first)
    second_parts = urlsplit(second)
    first_host = (first_parts.hostname or "").casefold().removeprefix("www.")
    second_host = (
        (second_parts.hostname or "").casefold().removeprefix("www.")
    )
    return (
        bool(first_host)
        and first_host == second_host
        and _archive_article_path(first_host, first_parts.path)
        == _archive_article_path(second_host, second_parts.path)
    )


def _archive_article_path(host: str, path: str) -> str:
    normalized = path.rstrip("/")
    if host != "bloomberg.com":
        return normalized
    legacy = re.fullmatch(
        r"/news/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)\.html",
        normalized,
    )
    if legacy is not None:
        return f"/news/{legacy.group('date')}/{legacy.group('slug')}"
    current = re.fullmatch(
        r"/news/articles/(?P<date>\d{4}-\d{2}-\d{2})/(?P<slug>[^/]+)",
        normalized,
    )
    if current is not None:
        return f"/news/{current.group('date')}/{current.group('slug')}"
    return normalized


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_common_crawl_timestamp(value: object) -> datetime | None:
    raw = str(value or "").strip()
    try:
        return datetime.strptime(raw, "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _optional_int(value: object) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _optional_string(value: object) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _fetch_limited(
    archive_client: CommonCrawlClient,
    url: str,
    *,
    maximum_bytes: int,
    attempts: int,
    timeout: float,
) -> tuple[int, dict[str, str], bytes, str]:
    circuit_is_open = getattr(archive_client, "circuit_is_open", None)
    if callable(circuit_is_open) and circuit_is_open(url):
        raise CommonCrawlCircuitOpenError(
            "Common Crawl index circuit is temporarily open"
        )
    limited = getattr(archive_client, "fetch_limited", None)
    if callable(limited):
        return limited(
            url,
            maximum_bytes=maximum_bytes,
            attempts=attempts,
            timeout=timeout,
        )
    return archive_client.fetch(
        url,
        maximum_bytes=maximum_bytes,
    )
