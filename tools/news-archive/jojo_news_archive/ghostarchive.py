from __future__ import annotations

import re
from typing import Protocol
from urllib.parse import urlencode, urlsplit
import zlib

from bs4 import BeautifulSoup

from .news_models import CaptureCandidate, CaptureProvider


GHOSTARCHIVE_ORIGIN = "https://ghostarchive.org"
GHOSTARCHIVE_SEARCH_ENDPOINT = GHOSTARCHIVE_ORIGIN + "/search"
GHOSTARCHIVE_SEARCH_MAXIMUM_BYTES = 1_000_000
GHOSTARCHIVE_WRAPPER_MAXIMUM_BYTES = 1_000_000
GHOSTARCHIVE_WARC_MAXIMUM_BYTES = 25_000_000
GHOSTARCHIVE_MAXIMUM_CANDIDATES = 3
_ARCHIVE_PATH_RE = re.compile(r"^/archive/([A-Za-z0-9]+)$")


class GhostarchiveClient(Protocol):
    def fetch(
        self,
        url: str,
        *,
        maximum_bytes: int,
    ) -> tuple[int, dict[str, str], bytes, str]: ...


def ghostarchive_search_url(canonical_url: str) -> str:
    return GHOSTARCHIVE_SEARCH_ENDPOINT + "?" + urlencode(
        {"term": canonical_url}
    )


def is_ghostarchive_candidate_url(value: str) -> bool:
    return _archive_id(value) is not None


def discover_ghostarchive_candidates(
    canonical_url: str,
    *,
    archive_client: GhostarchiveClient,
    expected_headline: str | None = None,
    maximum_candidates: int = GHOSTARCHIVE_MAXIMUM_CANDIDATES,
) -> tuple[CaptureCandidate, ...]:
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    if not _is_ft_article_url(canonical_url):
        return ()
    search_url = ghostarchive_search_url(canonical_url)
    status, headers, content, final_url = archive_client.fetch(
        search_url,
        maximum_bytes=GHOSTARCHIVE_SEARCH_MAXIMUM_BYTES,
    )
    final = urlsplit(final_url)
    content_type = headers.get("content-type", "").casefold()
    if (
        status != 200
        or final.scheme != "https"
        or final.hostname != "ghostarchive.org"
        or final.path != "/search"
        or not content
    ):
        return ()
    if "html" not in content_type and b"<html" not in content[:1_000].lower():
        raise ValueError("Ghostarchive search did not return HTML")
    soup = BeautifulSoup(content, "html.parser")
    candidates: list[CaptureCandidate] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if _ARCHIVE_PATH_RE.fullmatch(urlsplit(href).path) is None:
            continue
        archived_url = anchor.get_text(" ", strip=True)
        if not _same_ft_article_url(archived_url, canonical_url):
            continue
        snapshot_url = GHOSTARCHIVE_ORIGIN + urlsplit(href).path
        if snapshot_url in seen:
            continue
        seen.add(snapshot_url)
        candidates.append(
            CaptureCandidate(
                provider=CaptureProvider.OTHER,
                snapshot_url=snapshot_url,
                source_url=canonical_url,
                expected_headline=expected_headline,
            )
        )
        if len(candidates) >= maximum_candidates:
            break
    return tuple(candidates)


def fetch_ghostarchive_candidate(
    candidate: CaptureCandidate,
    *,
    canonical_url: str,
    archive_client: GhostarchiveClient,
    maximum_html_bytes: int,
) -> tuple[int, dict[str, str], bytes, str, dict[str, object]]:
    archive_id = _archive_id(candidate.snapshot_url)
    if (
        archive_id is None
        or not candidate.source_url
        or not _same_ft_article_url(candidate.source_url, canonical_url)
    ):
        raise ValueError("invalid Ghostarchive candidate")
    wrapper_status, wrapper_headers, wrapper, wrapper_final_url = (
        archive_client.fetch(
            candidate.snapshot_url,
            maximum_bytes=GHOSTARCHIVE_WRAPPER_MAXIMUM_BYTES,
        )
    )
    wrapper_final = urlsplit(wrapper_final_url)
    wrapper_content_type = wrapper_headers.get(
        "content-type",
        "",
    ).casefold()
    if (
        wrapper_status != 200
        or wrapper_final.scheme != "https"
        or wrapper_final.hostname != "ghostarchive.org"
        or _archive_id(wrapper_final_url) != archive_id
        or not wrapper
    ):
        raise ValueError("Ghostarchive wrapper is invalid")
    if (
        "html" not in wrapper_content_type
        and b"<html" not in wrapper[:1_000].lower()
    ):
        raise ValueError("Ghostarchive wrapper did not return HTML")
    replay = BeautifulSoup(wrapper, "html.parser").find("replay-web-page")
    if replay is None:
        raise ValueError("Ghostarchive wrapper is missing replay metadata")
    warc_url = str(replay.get("source") or "").strip()
    replay_url = str(replay.get("url") or "").strip()
    warc = urlsplit(warc_url)
    if (
        warc.scheme != "https"
        or warc.hostname != "ghostarchive.org"
        or warc.path != f"/chimurai4/{archive_id}.warc"
        or not _same_ft_article_url(replay_url, canonical_url)
    ):
        raise ValueError("Ghostarchive replay metadata is invalid")
    warc_status, warc_headers, warc_content, warc_final_url = (
        archive_client.fetch(
            warc_url,
            maximum_bytes=GHOSTARCHIVE_WARC_MAXIMUM_BYTES,
        )
    )
    final_warc = urlsplit(warc_final_url)
    warc_content_type = warc_headers.get("content-type", "").casefold()
    if (
        warc_status != 200
        or final_warc.scheme != "https"
        or final_warc.hostname != "ghostarchive.org"
        or final_warc.path != warc.path
        or not warc_content
    ):
        raise ValueError("Ghostarchive WARC is invalid")
    if "warc" not in warc_content_type and not warc_content.startswith(
        b"WARC/"
    ):
        raise ValueError("Ghostarchive replay did not return WARC")
    status, headers, html, target_url = _decode_warc_article(
        warc_content,
        canonical_url=canonical_url,
        maximum_html_bytes=maximum_html_bytes,
    )
    return (
        status,
        headers,
        html,
        target_url,
        {
            "ghostarchiveWarcValidated": True,
            "ghostarchiveWrapperUrl": candidate.snapshot_url,
            "ghostarchiveWarcUrl": warc_url,
            "ghostarchiveTargetUrl": target_url,
        },
    )


def _decode_warc_article(
    content: bytes,
    *,
    canonical_url: str,
    maximum_html_bytes: int,
) -> tuple[int, dict[str, str], bytes, str]:
    position = 0
    best: tuple[int, dict[str, str], bytes, str] | None = None
    while True:
        record_start = content.find(b"WARC/", position)
        if record_start < 0:
            break
        try:
            warc_header, payload_start = _header_at(
                content,
                record_start,
            )
            warc_headers = _parse_headers(warc_header)
            payload_length = int(warc_headers.get("content-length", ""))
        except (TypeError, ValueError):
            position = record_start + 5
            continue
        if payload_length < 0:
            position = record_start + 5
            continue
        payload_end = payload_start + payload_length
        if payload_end > len(content):
            raise ValueError("Ghostarchive WARC record is truncated")
        position = payload_end
        if warc_headers.get("warc-type", "").casefold() != "response":
            continue
        target_url = warc_headers.get("warc-target-uri", "")
        if not _same_ft_article_url(target_url, canonical_url):
            continue
        payload = content[payload_start:payload_end]
        try:
            status, headers, body = _decode_http_response(
                payload,
                maximum_body_bytes=maximum_html_bytes,
            )
        except ValueError:
            continue
        content_type = headers.get("content-type", "").casefold()
        if (
            status != 200
            or "html" not in content_type
            or not body
            or len(body) > maximum_html_bytes
        ):
            continue
        if best is None or len(body) > len(best[2]):
            best = status, headers, body, target_url
    if best is None:
        raise ValueError("Ghostarchive WARC has no usable article response")
    return best


def _decode_http_response(
    payload: bytes,
    *,
    maximum_body_bytes: int,
) -> tuple[int, dict[str, str], bytes]:
    http_header, content_start = _header_at(payload, 0)
    lines = http_header.replace(b"\r\n", b"\n").split(b"\n")
    status_match = re.match(
        rb"HTTP/\d(?:\.\d)?\s+(\d{3})(?:\s|$)",
        lines[0] if lines else b"",
        re.IGNORECASE,
    )
    if status_match is None:
        raise ValueError("Ghostarchive WARC HTTP status is invalid")
    headers = _parse_headers(b"\n".join(lines[1:]))
    content = payload[content_start:]
    if "chunked" in headers.get("transfer-encoding", "").casefold():
        content = _decode_chunked(content)
        headers.pop("transfer-encoding", None)
    encoding = headers.get("content-encoding", "").casefold()
    if encoding in {"gzip", "x-gzip"}:
        content = _decompress_limited(
            content,
            wbits=16 + zlib.MAX_WBITS,
            maximum_bytes=maximum_body_bytes,
        )
        headers.pop("content-encoding", None)
    elif encoding == "deflate":
        try:
            content = _decompress_limited(
                content,
                wbits=zlib.MAX_WBITS,
                maximum_bytes=maximum_body_bytes,
            )
        except ValueError:
            content = _decompress_limited(
                content,
                wbits=-zlib.MAX_WBITS,
                maximum_bytes=maximum_body_bytes,
            )
        headers.pop("content-encoding", None)
    elif encoding:
        raise ValueError(
            f"unsupported Ghostarchive content encoding: {encoding}"
        )
    content_length = _optional_int(headers.get("content-length"))
    if content_length is not None and content_length <= len(content):
        content = content[:content_length]
    return int(status_match.group(1)), headers, content


def _decompress_limited(
    content: bytes,
    *,
    wbits: int,
    maximum_bytes: int,
) -> bytes:
    decoder = zlib.decompressobj(wbits)
    try:
        decoded = decoder.decompress(content, maximum_bytes + 1)
        if len(decoded) > maximum_bytes or decoder.unconsumed_tail:
            raise ValueError("decompressed archive response is too large")
        decoded += decoder.flush(maximum_bytes + 1 - len(decoded))
    except zlib.error as exc:
        raise ValueError("archive response compression is invalid") from exc
    if len(decoded) > maximum_bytes:
        raise ValueError("decompressed archive response is too large")
    return decoded


def _header_at(content: bytes, start: int) -> tuple[bytes, int]:
    positions = [
        (content.find(separator, start), separator)
        for separator in (b"\r\n\r\n", b"\n\n")
    ]
    positions = [
        (position, separator)
        for position, separator in positions
        if position >= 0
    ]
    if not positions:
        raise ValueError("archive response is missing a header separator")
    position, separator = min(positions, key=lambda value: value[0])
    return content[start:position], position + len(separator)


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
        current = name.decode(
            "latin-1",
            errors="replace",
        ).strip().casefold()
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
            raise ValueError(
                "chunked archive response has invalid size"
            ) from exc
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


def _archive_id(value: str) -> str | None:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "ghostarchive.org"
        or parsed.query
        or parsed.fragment
    ):
        return None
    match = _ARCHIVE_PATH_RE.fullmatch(parsed.path)
    return match.group(1) if match else None


def _same_ft_article_url(first: str, second: str) -> bool:
    first_parts = urlsplit(first)
    second_parts = urlsplit(second)
    return bool(
        _is_ft_article_url(first)
        and _is_ft_article_url(second)
        and first_parts.path.rstrip("/").casefold()
        == second_parts.path.rstrip("/").casefold()
    )


def _is_ft_article_url(value: str) -> bool:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").casefold()
    return bool(
        parsed.scheme in {"http", "https"}
        and (hostname == "ft.com" or hostname.endswith(".ft.com"))
        and re.fullmatch(
            r"/content/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12}/?",
            parsed.path,
            flags=re.IGNORECASE,
        )
    )


def _optional_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None
