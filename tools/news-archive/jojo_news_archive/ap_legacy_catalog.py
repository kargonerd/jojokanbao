from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
import gzip
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit, urlunsplit

from bs4 import BeautifulSoup
from dateutil.parser import isoparse

from .archive_sources import (
    ap_hosted_publication_datetime,
    archive_source_spec,
    normalize_article_url,
)
from .news_models import CaptureCandidate, CaptureProvider
from .wayback_manifest import MANIFEST_FORMAT_VERSION


ARQUIVO_PT_REPLAY_ENDPOINT = "https://arquivo.pt/noFrame/replay"
WAYBACK_REPLAY_ENDPOINT = "https://web.archive.org/web"
_TIMESTAMP_RE = re.compile(r"\d{14}")
_GOOGLE_HOSTED_PATH_RE = re.compile(
    r"^/hostednews/ap/article/(?P<article>[A-Za-z0-9_-]+)$"
)
_YAHOO_AP_PATH_RE = re.compile(
    r"^/s/ap(?:_[A-Za-z0-9_-]+)?/"
    r"(?P<date>20\d{6})/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$"
)
_HUFF_WIRES_PATH_RE = re.compile(
    r"^/huff-wires/(?P<date>20\d{6})/[A-Za-z0-9_-]+$"
)
_GOOGLE_UNAVAILABLE_RE = re.compile(
    r"(?i)^unavailable_after:\s*"
    r"(?P<day>\d{2})-(?P<month>[A-Za-z]{3})-(?P<year>\d{4})\s+"
    r"(?P<time>\d{2}:\d{2}:\d{2})\s+"
    r"(?P<zone>PST|PDT|UTC|GMT)$"
)


def build_ap_hosted_manifest_rows(
    rows: Iterable[dict[str, object]],
    *,
    from_year: int,
    to_year: int,
    maximum_candidates: int = 3,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    if from_year < 1900 or to_year > 2100 or from_year > to_year:
        raise ValueError("invalid publication year range")
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")

    spec = archive_source_spec("ap")
    grouped: dict[
        str,
        tuple[datetime, list[tuple[tuple[object, ...], CaptureCandidate]]],
    ] = {}
    seen_rows = 0
    rejected_rows = 0
    for row in rows:
        seen_rows += 1
        original_url = str(row.get("url") or row.get("original") or "").strip()
        canonical_source = str(
            row.get("canonicalUrl")
            or row.get("canonical_url")
            or original_url
        ).strip()
        timestamp = str(row.get("timestamp") or "").strip()
        mime_type = str(row.get("mime") or row.get("mimetype") or "").strip()
        status_code = str(row.get("status") or row.get("statuscode") or "").strip()
        canonical_url = normalize_article_url(spec, canonical_source)
        published_at = ap_hosted_publication_datetime(canonical_url or "")
        if (
            canonical_url is None
            or published_at is None
            or not from_year <= published_at.year <= to_year
            or _TIMESTAMP_RE.fullmatch(timestamp) is None
            or mime_type.casefold() != "text/html"
            or status_code != "200"
        ):
            rejected_rows += 1
            continue
        captured_at = _timestamp_datetime(timestamp)
        candidate = CaptureCandidate(
            provider=CaptureProvider.ARQUIVO_PT,
            snapshot_url=(
                f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original_url}"
            ),
            source_url=original_url,
            expected_headline=_optional_string(row.get("expectedHeadline")),
            captured_at=captured_at,
            digest=_optional_string(row.get("digest")),
            mime_type=mime_type,
            status_code=200,
            byte_count=_optional_nonnegative_int(row.get("length")),
        )
        site = parse_qs(urlsplit(original_url).query).get("SITE", [""])[0]
        rank = (
            0 if site.casefold() == "ap" else 1,
            abs(int((captured_at - published_at).total_seconds())),
            timestamp,
            candidate.snapshot_url,
        )
        group = grouped.setdefault(canonical_url, (published_at, []))
        group[1].append((rank, candidate))

    manifest_rows: list[dict[str, object]] = []
    candidate_count = 0
    duplicate_candidates = 0
    duplicate_articles_by_digest = 0
    primary_digests: set[str] = set()
    for canonical_url in sorted(grouped):
        published_at, ranked_candidates = grouped[canonical_url]
        candidates: list[CaptureCandidate] = []
        identities: set[tuple[str, str]] = set()
        for _, candidate in sorted(ranked_candidates, key=lambda item: item[0]):
            identity = (candidate.snapshot_url, candidate.digest or "")
            if identity in identities:
                duplicate_candidates += 1
                continue
            identities.add(identity)
            candidates.append(candidate)
            if len(candidates) >= maximum_candidates:
                break
        if not candidates:
            continue
        primary_digest = candidates[0].digest or ""
        if primary_digest and primary_digest in primary_digests:
            duplicate_articles_by_digest += 1
            continue
        if primary_digest:
            primary_digests.add(primary_digest)
        candidate_count += len(candidates)
        manifest_rows.append(
            {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": "ap",
                "canonicalUrl": canonical_url,
                "publishedAt": published_at.isoformat(),
                "candidates": [
                    candidate.model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
                    for candidate in candidates
                ],
            }
        )
    return manifest_rows, {
        "rowsSeen": seen_rows,
        "rowsRejected": rejected_rows,
        "articles": len(manifest_rows),
        "candidates": candidate_count,
        "duplicateCandidates": duplicate_candidates,
        "duplicateArticlesByDigest": duplicate_articles_by_digest,
    }


def write_ap_hosted_manifest(
    rows: Iterable[dict[str, object]],
    destination: Path,
    *,
    from_year: int,
    to_year: int,
    maximum_candidates: int = 3,
) -> dict[str, int]:
    manifest_rows, metrics = build_ap_hosted_manifest_rows(
        rows,
        from_year=from_year,
        to_year=to_year,
        maximum_candidates=maximum_candidates,
    )
    write_ap_manifest_rows(manifest_rows, destination)
    return metrics


def write_ap_manifest_rows(
    manifest_rows: Iterable[dict[str, object]],
    destination: Path,
) -> None:
    """Atomically write already validated AP legacy manifest rows."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    opener = gzip.open if destination.suffix == ".gz" else open
    with opener(temporary, "wt", encoding="utf-8") as handle:
        for row in manifest_rows:
            handle.write(
                json.dumps(
                    row,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
    temporary.replace(destination)


def normalize_ap_partner_url(value: str) -> str | None:
    """Canonicalize legacy AP pages distributed by Google News or Yahoo."""
    parsed = urlsplit(value.strip())
    hostname = (parsed.hostname or "").casefold()
    path = parsed.path.split(";", 1)[0].rstrip("/")
    if hostname in {"google.com", "www.google.com"}:
        match = _GOOGLE_HOSTED_PATH_RE.fullmatch(path)
        if match is None:
            return None
        raw_query = parsed.query
        doc_id = ""
        query_match = re.search(
            r"(?i)(?:^|&)docid(?:=|/x3d|/u003d)([^&]+)",
            raw_query,
        )
        if query_match is not None:
            doc_id = query_match.group(1).strip()
        query = f"docId={doc_id}" if doc_id else ""
        return urlunsplit(("https", "www.google.com", path, query, ""))
    if hostname in {"news.yahoo.com", "www.news.yahoo.com"}:
        if _YAHOO_AP_PATH_RE.fullmatch(path) is None:
            return None
        return urlunsplit(("https", "news.yahoo.com", path, "", ""))
    if hostname in {
        "huffingtonpost.com",
        "www.huffingtonpost.com",
    }:
        if _HUFF_WIRES_PATH_RE.fullmatch(path) is None:
            return None
        return urlunsplit(
            ("https", "www.huffingtonpost.com", path, "", "")
        )
    return None


def ap_partner_publication_datetime(value: str) -> datetime | None:
    """Infer publication dates encoded in legacy Yahoo/AP paths."""
    normalized = normalize_ap_partner_url(value)
    if normalized is None:
        return None
    parsed = urlsplit(normalized)
    match = _YAHOO_AP_PATH_RE.fullmatch(parsed.path)
    if match is None:
        match = _HUFF_WIRES_PATH_RE.fullmatch(parsed.path)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group("date"), "%Y%m%d").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def ap_google_hosted_page_metadata(
    html_bytes: bytes,
) -> tuple[datetime, str] | None:
    """Validate a Google Hosted News/AP page and recover its publish time."""
    soup = BeautifulSoup(html_bytes, "html.parser")
    source = soup.select_one('link[rel~="syndication-source"][href]')
    source_href = str(source.get("href") or "") if source else ""
    if re.search(r"(?i)https?://(?:www\.)?ap\.org/", source_href) is None:
        return None
    headline_node = soup.select_one("#hostednews-article #hn-headline")
    body = soup.select_one(
        "#hostednews-article .hn-copy > .g-section:first-child"
    )
    headline = (
        " ".join(headline_node.get_text(" ", strip=True).split())
        if headline_node is not None
        else ""
    )
    body_characters = len(
        " ".join(body.get_text(" ", strip=True).split())
        if body is not None
        else ""
    )
    match = next(
        (
            candidate
            for node in soup.select('meta[name="googlebot"][content]')
            if (
                candidate := _GOOGLE_UNAVAILABLE_RE.fullmatch(
                    str(node.get("content") or "").strip()
                )
            )
            is not None
        ),
        None,
    )
    if not headline or body_characters < 100 or match is None:
        return None
    zone = match.group("zone").upper()
    offsets = {
        "PST": timezone(timedelta(hours=-8)),
        "PDT": timezone(timedelta(hours=-7)),
        "UTC": timezone.utc,
        "GMT": timezone.utc,
    }
    try:
        unavailable_after = datetime.strptime(
            (
                f"{match.group('day')}-{match.group('month')}-"
                f"{match.group('year')} {match.group('time')}"
            ),
            "%d-%b-%Y %H:%M:%S",
        ).replace(tzinfo=offsets[zone])
    except ValueError:
        return None
    published_at = unavailable_after - timedelta(days=30)
    return published_at.astimezone(timezone.utc), headline


def ap_huff_wire_page_metadata(
    html_bytes: bytes,
) -> tuple[datetime, str] | None:
    """Validate a HuffPost AP-wire page and recover its visible timestamp."""
    soup = BeautifulSoup(html_bytes, "html.parser")
    marker = soup.select_one(".entry .comments_datetime .ap img[alt]")
    if (
        marker is None
        or str(marker.get("alt") or "").strip().casefold() != "ap"
    ):
        return None
    headline_node = soup.select_one(".entry h1")
    body = soup.select_one(".entry .entry_content")
    metadata = soup.select_one(".entry .comments_datetime")
    headline = (
        " ".join(headline_node.get_text(" ", strip=True).split())
        if headline_node is not None
        else ""
    )
    body_characters = len(
        " ".join(body.get_text(" ", strip=True).split())
        if body is not None
        else ""
    )
    text = (
        " ".join(metadata.get_text(" ", strip=True).split())
        if metadata is not None
        else ""
    )
    match = re.search(
        r"(?i)\b([A-Z][a-z]+ \d{1,2}, 20\d{2} "
        r"\d{1,2}:\d{2} [AP]M)\s+(EST|EDT)\b",
        text,
    )
    if not headline or body_characters < 100 or match is None:
        return None
    try:
        published_at = datetime.strptime(
            match.group(1),
            "%B %d, %Y %I:%M %p",
        )
    except ValueError:
        return None
    offset = -5 if match.group(2).upper() == "EST" else -4
    return published_at.replace(
        tzinfo=timezone(timedelta(hours=offset))
    ).astimezone(timezone.utc), headline


def build_ap_partner_manifest_rows(
    rows: Iterable[dict[str, object]],
    *,
    from_year: int,
    to_year: int,
    maximum_candidates: int = 3,
    provider: CaptureProvider = CaptureProvider.ARQUIVO_PT,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    """Build manifest rows for validated Google/Yahoo AP distributions."""
    if from_year < 1900 or to_year > 2100 or from_year > to_year:
        raise ValueError("invalid publication year range")
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    if provider not in {
        CaptureProvider.ARQUIVO_PT,
        CaptureProvider.WAYBACK,
    }:
        raise ValueError("unsupported AP partner capture provider")
    grouped: dict[
        str,
        tuple[datetime, list[tuple[tuple[object, ...], CaptureCandidate]]],
    ] = {}
    seen_rows = 0
    rejected_rows = 0
    for row in rows:
        seen_rows += 1
        original_url = str(row.get("url") or row.get("original") or "").strip()
        canonical_source = str(
            row.get("canonicalUrl")
            or row.get("canonical_url")
            or original_url
        ).strip()
        canonical_url = normalize_ap_partner_url(canonical_source)
        canonical_host = (
            urlsplit(canonical_url).hostname or ""
            if canonical_url is not None
            else ""
        ).casefold()
        validation_marker = str(row.get("partnerValidated") or "").strip()
        raw_published = str(row.get("publishedAt") or "").strip()
        try:
            published_at = isoparse(raw_published) if raw_published else None
        except (TypeError, ValueError, OverflowError):
            published_at = None
        if published_at is None:
            published_at = ap_partner_publication_datetime(canonical_source)
        if published_at is not None and published_at.tzinfo is None:
            published_at = published_at.replace(tzinfo=timezone.utc)
        timestamp = str(row.get("timestamp") or "").strip()
        mime_type = str(row.get("mime") or row.get("mimetype") or "").strip()
        status_code = str(row.get("status") or row.get("statuscode") or "").strip()
        if (
            canonical_url is None
            or (
                canonical_host == "www.google.com"
                and validation_marker != "google-hosted-ap"
            )
            or (
                canonical_host == "www.huffingtonpost.com"
                and validation_marker != "huffpost-ap-wire"
            )
            or published_at is None
            or not from_year <= published_at.year <= to_year
            or _TIMESTAMP_RE.fullmatch(timestamp) is None
            or mime_type.casefold() != "text/html"
            or status_code != "200"
        ):
            rejected_rows += 1
            continue
        captured_at = _timestamp_datetime(timestamp)
        if provider == CaptureProvider.ARQUIVO_PT:
            snapshot_url = (
                f"{ARQUIVO_PT_REPLAY_ENDPOINT}/{timestamp}/{original_url}"
            )
        else:
            snapshot_url = (
                f"{WAYBACK_REPLAY_ENDPOINT}/{timestamp}id_/{original_url}"
            )
        candidate = CaptureCandidate(
            provider=provider,
            snapshot_url=snapshot_url,
            source_url=original_url,
            expected_headline=_optional_string(row.get("expectedHeadline")),
            captured_at=captured_at,
            digest=_optional_string(row.get("digest")),
            mime_type=mime_type,
            status_code=200,
            byte_count=_optional_nonnegative_int(row.get("length")),
        )
        rank = (
            abs(int((captured_at - published_at).total_seconds())),
            timestamp,
            candidate.snapshot_url,
        )
        group = grouped.setdefault(canonical_url, (published_at, []))
        group[1].append((rank, candidate))

    manifest_rows: list[dict[str, object]] = []
    candidate_count = 0
    duplicate_candidates = 0
    duplicate_articles_by_digest = 0
    primary_digests: set[str] = set()
    for canonical_url in sorted(grouped):
        published_at, ranked_candidates = grouped[canonical_url]
        candidates: list[CaptureCandidate] = []
        identities: set[tuple[str, str]] = set()
        for _, candidate in sorted(ranked_candidates, key=lambda item: item[0]):
            identity = (candidate.snapshot_url, candidate.digest or "")
            if identity in identities:
                duplicate_candidates += 1
                continue
            identities.add(identity)
            candidates.append(candidate)
            if len(candidates) >= maximum_candidates:
                break
        if not candidates:
            continue
        primary_digest = candidates[0].digest or ""
        if primary_digest and primary_digest in primary_digests:
            duplicate_articles_by_digest += 1
            continue
        if primary_digest:
            primary_digests.add(primary_digest)
        candidate_count += len(candidates)
        manifest_rows.append(
            {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": "ap",
                "canonicalUrl": canonical_url,
                "publishedAt": published_at.astimezone(timezone.utc).isoformat(),
                "candidates": [
                    candidate.model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
                    for candidate in candidates
                ],
            }
        )
    return manifest_rows, {
        "rowsSeen": seen_rows,
        "rowsRejected": rejected_rows,
        "articles": len(manifest_rows),
        "candidates": candidate_count,
        "duplicateCandidates": duplicate_candidates,
        "duplicateArticlesByDigest": duplicate_articles_by_digest,
    }


def build_ap_bigstory_manifest_rows(
    rows: Iterable[dict[str, object]],
    *,
    from_year: int,
    to_year: int,
    maximum_candidates: int = 3,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    """Build AP Big Story rows using capture time as catalog-year hint.

    Big Story pages expose the exact timestamp inside the archived HTML. The
    manifest only needs a stable year for sampling, so the first 2012 capture
    is retained as a provisional value and the parser replaces it from
    ``.article-data .updated[title]`` when the page is captured.
    """
    if from_year < 1900 or to_year > 2100 or from_year > to_year:
        raise ValueError("invalid publication year range")
    if maximum_candidates < 1:
        raise ValueError("maximum_candidates must be positive")
    spec = archive_source_spec("ap")
    grouped: dict[
        str,
        list[tuple[tuple[object, ...], datetime, CaptureCandidate]],
    ] = {}
    seen_rows = 0
    rejected_rows = 0
    for row in rows:
        seen_rows += 1
        original_url = str(row.get("url") or row.get("original") or "").strip()
        canonical_url = normalize_article_url(spec, original_url)
        timestamp = str(row.get("timestamp") or "").strip()
        mime_type = str(row.get("mime") or row.get("mimetype") or "").strip()
        status_code = str(row.get("status") or row.get("statuscode") or "").strip()
        if _TIMESTAMP_RE.fullmatch(timestamp) is None:
            rejected_rows += 1
            continue
        captured_at = _timestamp_datetime(timestamp)
        parsed = urlsplit(canonical_url or "")
        if (
            canonical_url is None
            or (parsed.hostname or "").casefold() != "bigstory.ap.org"
            or not parsed.path.startswith("/article/")
            or not from_year <= captured_at.year <= to_year
            or mime_type.casefold() != "text/html"
            or status_code != "200"
        ):
            rejected_rows += 1
            continue
        candidate = CaptureCandidate(
            provider=CaptureProvider.WAYBACK,
            snapshot_url=(
                f"{WAYBACK_REPLAY_ENDPOINT}/{timestamp}id_/{original_url}"
            ),
            source_url=original_url,
            captured_at=captured_at,
            digest=_optional_string(row.get("digest")),
            mime_type=mime_type,
            status_code=200,
            byte_count=_optional_nonnegative_int(row.get("length")),
        )
        rank = (timestamp, candidate.snapshot_url)
        grouped.setdefault(canonical_url, []).append(
            (rank, captured_at, candidate)
        )

    manifest_rows: list[dict[str, object]] = []
    candidate_count = 0
    duplicate_candidates = 0
    duplicate_articles_by_digest = 0
    primary_digests: set[str] = set()
    for canonical_url in sorted(grouped):
        candidates: list[CaptureCandidate] = []
        identities: set[tuple[str, str]] = set()
        published_at: datetime | None = None
        for _, captured_at, candidate in sorted(
            grouped[canonical_url], key=lambda item: item[0]
        ):
            identity = (candidate.snapshot_url, candidate.digest or "")
            if identity in identities:
                duplicate_candidates += 1
                continue
            identities.add(identity)
            candidates.append(candidate)
            published_at = published_at or captured_at
            if len(candidates) >= maximum_candidates:
                break
        if not candidates or published_at is None:
            continue
        primary_digest = candidates[0].digest or ""
        if primary_digest and primary_digest in primary_digests:
            duplicate_articles_by_digest += 1
            continue
        if primary_digest:
            primary_digests.add(primary_digest)
        candidate_count += len(candidates)
        manifest_rows.append(
            {
                "formatVersion": MANIFEST_FORMAT_VERSION,
                "publisher": "ap",
                "canonicalUrl": canonical_url,
                "publishedAt": published_at.isoformat(),
                "candidates": [
                    candidate.model_dump(
                        mode="json",
                        by_alias=True,
                        exclude_none=True,
                    )
                    for candidate in candidates
                ],
            }
        )
    return manifest_rows, {
        "rowsSeen": seen_rows,
        "rowsRejected": rejected_rows,
        "articles": len(manifest_rows),
        "candidates": candidate_count,
        "duplicateCandidates": duplicate_candidates,
        "duplicateArticlesByDigest": duplicate_articles_by_digest,
    }


def ap_hosted_page_metadata(
    html_bytes: bytes,
) -> tuple[datetime, str] | None:
    """Read stable identity metadata from a legacy Hosted AP story page."""
    soup = BeautifulSoup(html_bytes, "html.parser")
    timestamp_node = soup.select_one(
        ".ap-story-table .timestamp.updated[title], "
        ".ap-story-table time.updated[datetime]"
    )
    timestamp = ""
    if timestamp_node is not None:
        timestamp = str(
            timestamp_node.get("title")
            or timestamp_node.get("datetime")
            or ""
        ).strip()
    headline_node = soup.select_one(
        ".ap-story-table .headline.entry-title, "
        ".ap-story-table .entry-title"
    )
    body = soup.select_one(".ap-story-table .entry-content")
    headline = (
        " ".join(headline_node.get_text(" ", strip=True).split())
        if headline_node is not None
        else ""
    )
    body_characters = len(
        " ".join(body.get_text(" ", strip=True).split())
        if body is not None
        else ""
    )
    if not timestamp or not headline or body_characters < 100:
        return None
    try:
        published_at = isoparse(timestamp)
    except (TypeError, ValueError, OverflowError):
        return None
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    return published_at.astimezone(timezone.utc), headline


def _timestamp_datetime(value: str) -> datetime:
    return datetime.strptime(value, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc
    )


def _optional_string(value: object) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


def _optional_nonnegative_int(value: object) -> int | None:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None
