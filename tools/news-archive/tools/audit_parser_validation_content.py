from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_news_archive.archive_sources import (
    archive_source_spec,
    article_deduplication_key,
    article_url_publication_year,
    normalize_article_url,
)
from jojo_news_archive.news_parser import (
    _aljazeera_non_editorial_image_url,
    parse_article,
)
from jojo_news_archive.parser_qa_policy import CONTENT_AUDIT_FORMAT_VERSION
from jojo_news_archive.parser_validation import (
    _read_capture_html,
    _read_dependent_resources,
    is_axios_internal_test_entry,
    publication_year_for_sample,
)
from jojo_news_archive.raw_archive_capture import completed_raw_capture


_SPACE_RE = re.compile(r"\s+")
_SUSPICIOUS_IMAGE_RE = re.compile(
    r"(?i)(?:^|[/_.-])(?:advert(?:isement)?|icon|"
    r"spacer|sprite)(?:[/_.-]|$)|"
    r"(?:doubleclick|googlesyndication|scorecardresearch)"
)
_SUSPICIOUS_PIXEL_RE = re.compile(
    r"(?i)(?:^|[/_.-])pixel(?:"
    r"\.(?:gif|png|jpe?g|webp)(?:[?#]|$)|"
    r"[-_.](?:1x1|tracking|beacon)(?:[/_.-]|$)|"
    r"$)"
)
_SUSPICIOUS_AVATAR_FILENAME_RE = re.compile(
    r"(?i)(?:^|[_.-])avatar(?:[_.-]|$)"
)
_SUSPICIOUS_TRANSPARENT_FILENAME_RE = re.compile(
    r"(?i)^transparent(?:[_.-](?:1x1|pixel|spacer))?\.(?:gif|png)$"
)
_INTERFACE_TEXT_RE = re.compile(
    r"(?i)^(?:advertisement|back to top|click here|follow us|keep reading|more from axios:?|read more:?|related|rss|"
    r"related stories|share this:?|share this article|sign in|subscribe|trending stories)$|"
    r"^(?:are you curious about the ft[’']s environmental sustainability commitments|"
    r"find out about our latest stories first\s*[—-]\s*follow\s+@ftweekend|"
    r"recommended newsletters for you|"
    r"where climate change meets business, markets and politics)\b|"
    r"^(?:purchase the \d{2,4}\+ page china internet report|"
    r"sign up now for a 50% early bird discount on the \d{2,4}\+ page china internet report)\b|"
    r"^[-–—]{8,}$|"
    r"^(?:\d{2}\s*第\d+页\s*){2,}$|"
    r"^marketwatch拥有位于三大洲的100多名记者|"
    r"^(?:c\.|©)\s*(?:19|20)\d{2}\s+the new york times company\s*\.?$|"
    r"^(?:accept all cookies|all rights reserved|"
    r"download (?:our|the) app(?:\s+(?:now|today))?[.!]?$|"
    r"sign up for (?:our|the)|subscribe to (?:axios|our|the)|"
    r"terms (?:of use|and conditions)[.!]?$)"
)
_INTERACTIVE_TAGS = {"button", "form", "input", "nav", "script", "style"}
_NYT_DEAD_INTERACTIVE_CONTROL_RE = re.compile(
    r"(?i)^(?:read full answer|next:\s+.{1,120})$"
)


def replacement_character_count(*values: str) -> int:
    """Count Unicode replacement characters that reached normalized output."""
    return sum(value.count("\ufffd") for value in values)


def source_replacement_character_count(html_bytes: bytes) -> int:
    """Count replacement markers already present in the captured source."""
    return html_bytes.count(b"\xef\xbf\xbd")


def article_content_identity(
    plain_text: str,
) -> str | None:
    """Identify exact article duplicates that use different public URLs."""

    normalized_body = normalize_text(plain_text)
    if len(normalized_body) < 100:
        return None
    return "content-sha256:" + hashlib.sha256(
        normalized_body.encode("utf-8")
    ).hexdigest()


def contextual_signup_article_block(
    publisher: str,
    canonical_url: str,
    headline: str,
    text: str,
) -> bool:
    """Keep an editorial signup instruction when signup is the story itself."""

    path = urlsplit(canonical_url).path.casefold()
    return (
        publisher == "wsj"
        and "/sign-up-for-" in path
        and normalize_text(headline).startswith("sign up for ")
        and text.startswith("sign up for ")
    )


def contextual_scmp_competition_terms_block(
    publisher: str,
    canonical_url: str,
    text: str,
    plain_text: str,
) -> bool:
    """Keep SCMP Young Post competition rules that are editorial content."""

    path = urlsplit(canonical_url).path.casefold()
    normalized_body = normalize_text(plain_text)
    rule_signals = (
        "contest is only open",
        "competition is not open",
        "entries must be the contestant's original work",
        "contestants retain copyright",
        "by entering this competition",
        "judges’ decision is final",
        "judges' decision is final",
        "tickets cannot be exchanged for cash",
        "all members must be hong kong secondary school students",
        "entry to the competition means you consent",
    )
    return (
        publisher == "scmp"
        and "/yp/" in path
        and "/competitions/" in path
        and text.rstrip(".") == "terms and conditions"
        and sum(signal in normalized_body for signal in rule_signals) >= 2
    )


def contextual_scmp_virtual_event_signup_block(
    publisher: str,
    canonical_url: str,
    headline: str,
    text: str,
    plain_text: str,
    body_html: str,
) -> bool:
    """Keep the official signup link when the reported event is the story."""

    if (
        publisher != "scmp"
        or "/yp/discover/news/" not in urlsplit(canonical_url).path.casefold()
        or text.rstrip(".") != "sign up for the virtual tour here"
    ):
        return False
    normalized_headline = normalize_text(headline)
    normalized_body = normalize_text(plain_text)
    event_signals = (
        "virtual information day",
        "virtual campus tour",
        "admission information",
        "undergraduate students",
    )
    if (
        "university" not in normalized_headline
        or not any(
            marker in normalized_headline
            for marker in ("online information session", "virtual")
        )
        or sum(signal in normalized_body for signal in event_signals) < 3
    ):
        return False
    for link in BeautifulSoup(body_html, "html.parser").select("a[href]"):
        normalized_link_text = normalize_text(
            link.get_text(" ", strip=True)
        ).rstrip(".")
        if normalized_link_text != text.rstrip("."):
            continue
        host = (urlsplit(str(link.get("href") or "")).hostname or "").casefold()
        if host == "ust.hk" or host.endswith(".ust.hk"):
            return True
    return False


def _near_duplicate_body_signature(
    plain_text: str,
) -> tuple[str, frozenset[int], int] | None:
    """Build a stable content-defined sketch for substantial article prose."""

    normalized_body = normalize_text(plain_text)
    if len(normalized_body) < 300:
        return None
    width = 17
    if len(normalized_body) < width:
        return None
    mask = (1 << 64) - 1
    base = 257
    leading_power = pow(base, width - 1, 1 << 64)
    rolling_hash = 0
    for character in normalized_body[:width]:
        rolling_hash = (
            rolling_hash * base + ord(character)
        ) & mask
    samples: set[int] = set()
    if rolling_hash & 15 == 0:
        samples.add(rolling_hash)
    for index in range(width, len(normalized_body)):
        outgoing = ord(normalized_body[index - width])
        rolling_hash = (
            (
                rolling_hash
                - ((outgoing * leading_power) & mask)
            )
            & mask
        )
        rolling_hash = (
            rolling_hash * base + ord(normalized_body[index])
        ) & mask
        # Content-defined sampling remains aligned after a small insertion or
        # deletion, unlike fixed-position slices. It also keeps each 800-row
        # audit compact enough for an all-pairs high-confidence prefilter.
        if rolling_hash & 15 == 0:
            samples.add(rolling_hash)
    if len(samples) < 16:
        return None
    bit_weights = [0] * 64
    for value in samples:
        for bit in range(64):
            bit_weights[bit] += 1 if value & (1 << bit) else -1
    simhash = sum(
        1 << bit
        for bit, weight in enumerate(bit_weights)
        if weight >= 0
    )
    return normalized_body, frozenset(samples), simhash


def near_duplicate_article_pairs(
    article_bodies: dict[str, str],
) -> list[dict[str, object]]:
    """Find near-identical bodies that evade an exact normalized hash."""

    prepared: list[tuple[str, str, frozenset[int], int]] = []
    for url, body in sorted(article_bodies.items()):
        signature = _near_duplicate_body_signature(body)
        if signature is None:
            continue
        normalized_body, samples, simhash = signature
        prepared.append((url, normalized_body, samples, simhash))

    duplicates: list[dict[str, object]] = []
    for left_index, left in enumerate(prepared):
        left_url, left_body, left_samples, left_simhash = left
        for right in prepared[left_index + 1 :]:
            right_url, right_body, right_samples, right_simhash = right
            if left_body == right_body:
                # The exact content identity audit reports this pair.
                continue
            length_ratio = min(len(left_body), len(right_body)) / max(
                len(left_body),
                len(right_body),
            )
            if length_ratio < 0.98:
                continue
            if (left_simhash ^ right_simhash).bit_count() > 3:
                continue
            union = left_samples | right_samples
            similarity = len(left_samples & right_samples) / len(union)
            if similarity < 0.98:
                continue
            duplicates.append(
                {
                    "type": "near-duplicate-article-content",
                    "url": left_url,
                    "detail": {
                        "sampleUrls": [left_url, right_url],
                        "similarity": round(similarity, 6),
                        "bodyCharacters": [
                            len(left_body),
                            len(right_body),
                        ],
                    },
                }
            )
    return duplicates


def nyt_raw_interactive_prose_characters(
    html_bytes: bytes,
    canonical_url: str,
) -> int:
    """Measure substantial paragraph prose available in an NYT interactive."""
    if "/interactive/" not in canonical_url.casefold():
        return 0
    soup = BeautifulSoup(html_bytes, "html.parser")
    candidates = soup.select(
        ".interactive-graphic, .interactive-body, "
        "section.interactive-content"
    )
    unique_paragraphs = {
        normalize_text(paragraph.get_text(" ", strip=True))
        for candidate in candidates
        for paragraph in candidate.select("p")
        if normalize_text(paragraph.get_text(" ", strip=True))
    }
    return sum(len(text) for text in unique_paragraphs)


def _suspicious_selected_image(value: str) -> bool:
    parsed = urlsplit(value)
    path = parsed.path.casefold()
    filename = path.rsplit("/", 1)[-1]
    if _aljazeera_non_editorial_image_url(value):
        return True
    if filename == "social-share.png":
        return True
    # WSJ's editorial image desk uses ``_SPACER_M_`` in some full-size photo
    # filenames.  These are ordinary story images (the audited example is a
    # 1280x853 Long March rocket launch), not transparent layout spacers.
    if (
        parsed.netloc.casefold() == "si.wsj.net"
        and path.startswith("/public/resources/images/")
        and re.fullmatch(
            r"[a-z0-9-]+_spacer_[a-z]_\d+\.jpe?g",
            filename,
        )
    ):
        return False
    # Some publishers use ``-icon-`` as part of a genuine editorial image
    # slug (for example NYT On Politics artwork and Reuters-sourced Al
    # Jazeera photos).  Restrict the generic icon check to UI-looking assets;
    # these media-hosted image paths are article artwork, not controls.
    if (
        re.search(
            r"(?:^|/)[^/]*-icon-[^/]+\.(?:jpe?g|png|webp)$",
            path,
        )
        and (
            parsed.netloc.casefold() == "static01.nyt.com"
            or "/wp-content/uploads/" in path
        )
    ):
        return False
    # Older NYT On Politics pages put genuine section artwork in a directory
    # whose name ends in ``-icon`` while the rendition filename itself does
    # not.  Treat that family like the filename-based exception above; the
    # directory name alone is not evidence that the selected asset is UI
    # chrome.
    if (
        parsed.netloc.casefold() == "static01.nyt.com"
        and re.search(
            r"/onpolitics-[^/]*-icon/[^/]+\.(?:gif|jpe?g|png|webp)$",
            path,
            flags=re.IGNORECASE,
        )
    ):
        return False
    # NPR's legacy book-review pages use the ``icon`` directory for genuine
    # Baker & Taylor cover art.  It is editorial media, not a UI icon.
    if "/assets/bakertaylor/covers/" in path:
        return False
    avatar_directory = any(
        segment in {"author", "authors", "avatar", "avatars", "profile", "profiles", "headshot", "headshots"}
        for segment in path.split("/")
    )
    return bool(
        _SUSPICIOUS_IMAGE_RE.search(value)
        or _SUSPICIOUS_PIXEL_RE.search(value)
        or _SUSPICIOUS_TRANSPARENT_FILENAME_RE.fullmatch(filename)
        or (
            avatar_directory
            and _SUSPICIOUS_AVATAR_FILENAME_RE.search(filename)
        )
        or (
            "/__assets/creatives/brand-ft/icons/v2/open-graph.png"
            in value.casefold()
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Reparse a completed validation cell and report content-level "
            "cross-article anomalies missed by row-level QA."
        )
    )
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--archive-root", type=Path, required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--target", type=int, default=800)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help=(
            "Audit the currently available QA-passing rows before the formal "
            "target is reached. Partial audits can pass content checks but "
            "never satisfy the formal convergence gate."
        ),
    )
    parser.add_argument("--expected-parser-version")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def normalize_text(value: str | None) -> str:
    return _SPACE_RE.sub(" ", value or "").strip().casefold()


def image_identity(value: str) -> str:
    parts = urlsplit(value)
    host = (parts.hostname or "").casefold()
    if host in {"cdn.i-scmp.com", "cdn1.i-scmp.com", "img.i-scmp.com"}:
        path = re.sub(
            r"^/sites/default/files/styles/[^/]+/public/",
            "/sites/default/files/",
            parts.path,
            flags=re.IGNORECASE,
        )
        path = re.sub(
            r"_(?:image_hires|\d+x\d*)_(\d+)(\.[a-z0-9]+)$",
            r"_\1\2",
            path,
            flags=re.IGNORECASE,
        )
        if path.casefold().startswith("/sites/default/files/"):
            return f"scmp-image:{path.casefold()}"
    query = ""
    if (
        (parts.hostname or "").casefold() == "markets.on.nytimes.com"
        and parts.path.casefold().endswith("/research/tools/builder/api.asp")
    ):
        # NYT's legacy stock-chart endpoint uses one common path for every
        # chart.  Preserve the semantic query keys so the audit neither
        # conflates different companies nor different time windows.
        query = urlencode(
            sorted(
                (key.casefold(), item)
                for key, item in parse_qsl(
                    parts.query,
                    keep_blank_values=False,
                )
                if key.casefold() in {"sym", "duration"} and item
            )
        )
    # Legacy Reuters stores the media identity in the query string of the
    # generic ``/resources/r/`` path.  Dropping the whole query collapses
    # unrelated article images into one audit identity; retain the media
    # identifiers while ignoring only rendition/placeholder dimensions.
    elif parts.path.casefold().endswith("/resources/r/"):
        resize_keys = {"w", "fh", "fw", "ll", "pl", "sq"}
        query = urlencode(
            sorted(
                (key, item)
                for key, item in parse_qsl(parts.query, keep_blank_values=False)
                if key.casefold() not in resize_keys and item
            )
        )
    return urlunsplit(
        (
            parts.scheme.casefold(),
            parts.netloc.casefold(),
            parts.path,
            query,
            "",
        )
    )


def url_year_mismatch(
    publisher: str,
    canonical_url: str,
    expected_year: int,
) -> int | None:
    embedded_year = article_url_publication_year(
        archive_source_spec(publisher),
        canonical_url,
    )
    return (
        embedded_year
        if embedded_year is not None and embedded_year != expected_year
        else None
    )


def selected_validation_urls(
    connection: sqlite3.Connection,
    *,
    publisher: str,
    year: int,
    target: int,
    allow_partial: bool = False,
) -> tuple[str, int, list[str]]:
    config_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(parser_validation_config)"
        )
    }
    result_columns = {
        str(row[1])
        for row in connection.execute(
            "PRAGMA table_info(parser_validation_results)"
        )
    }
    has_qa_revision = (
        "qa_revision" in config_columns
        and "qa_revision" in result_columns
    )
    config = connection.execute(
        (
            "SELECT parser_version, qa_revision, target_size "
            if has_qa_revision
            else "SELECT parser_version, 0, target_size "
        )
        + "FROM parser_validation_config WHERE sample_year=?",
        (year,),
    ).fetchone()
    if config is None:
        raise ValueError(f"validation config missing for {publisher}/{year}")
    parser_version, qa_revision, configured_target = config
    if int(configured_target) != target:
        raise ValueError(
            f"configured target is {configured_target}, expected {target}"
        )
    qa_revision_clause = (
        "AND result.qa_revision=?" if has_qa_revision else ""
    )
    parameters: list[object] = [
        year,
        publisher,
        year,
        str(parser_version),
    ]
    if has_qa_revision:
        parameters.append(int(qa_revision))
    parameters.append(target)
    rows = connection.execute(
        """
        SELECT sample.canonical_url
        FROM parser_validation_samples AS sample
        JOIN parser_validation_results AS result
          ON result.canonical_url=sample.canonical_url
        JOIN captures AS capture
          ON capture.canonical_url=sample.canonical_url
        WHERE sample.sample_year=?
          AND result.publisher=?
          AND result.sample_year=?
          AND result.parser_version=?
          {qa_revision_clause}
          AND result.qa_pass=1
          AND capture.status='complete'
          AND capture.raw_path IS NOT NULL
        ORDER BY sample.sample_priority
        LIMIT ?
        """.format(qa_revision_clause=qa_revision_clause),
        parameters,
    ).fetchall()
    urls = [str(row[0]) for row in rows]
    if allow_partial and not urls:
        raise ValueError("completed QA-passing sample has no rows")
    if not allow_partial and len(urls) != target:
        raise ValueError(
            f"completed QA-passing sample has {len(urls)} rows, expected {target}"
        )
    return str(parser_version), int(qa_revision), urls


def audit_content(
    *,
    state: Path,
    archive_root: Path,
    publisher: str,
    year: int,
    target: int,
    expected_parser_version: str | None = None,
    allow_partial: bool = False,
) -> dict[str, object]:
    connection = sqlite3.connect(f"file:{state.resolve().as_posix()}?mode=ro", uri=True)
    try:
        parser_version, qa_revision, urls = selected_validation_urls(
            connection,
            publisher=publisher,
            year=year,
            target=target,
            allow_partial=allow_partial,
        )
        expected_version = expected_parser_version or parser_version
        hard_anomalies: list[dict[str, object]] = []
        review_candidates: list[dict[str, object]] = []
        block_articles: dict[str, set[str]] = defaultdict(set)
        selected_image_articles: dict[str, set[str]] = defaultdict(set)
        identity_articles: dict[str, set[str]] = defaultdict(set)
        content_identity_articles: dict[str, set[str]] = defaultdict(set)
        article_bodies: dict[str, str] = {}
        body_lengths: list[int] = []
        selected_images = 0
        validated_unsupported_nontext = 0
        extraction_statuses: Counter[str] = Counter()
        for index, canonical_url in enumerate(urls, start=1):
            source_spec = archive_source_spec(publisher)
            normalized_url = normalize_article_url(source_spec, canonical_url)
            if normalized_url != canonical_url:
                hard_anomalies.append(
                    {
                        "type": "noncanonical-sample-url",
                        "url": canonical_url,
                        "detail": normalized_url,
                    }
                )
            identity = article_deduplication_key(source_spec, canonical_url)
            if identity is not None:
                identity_articles[identity].add(canonical_url)
            mismatched_year = url_year_mismatch(
                publisher,
                canonical_url,
                year,
            )
            if mismatched_year is not None:
                hard_anomalies.append(
                    {
                        "type": "url-publication-year-mismatch",
                        "url": canonical_url,
                        "detail": mismatched_year,
                    }
                )
            try:
                capture = completed_raw_capture(
                    connection,
                    canonical_url=canonical_url,
                )
                raw_html = _read_capture_html(capture, archive_root)
                article = parse_article(
                    raw_html,
                    publisher=publisher,
                    canonical_url=canonical_url,
                    raw_capture=capture,
                    dependent_resources=_read_dependent_resources(
                        capture,
                        archive_root,
                    ),
                    parsed_at=datetime.now(timezone.utc),
                )
            except Exception as exc:
                hard_anomalies.append(
                    {
                        "type": "reparse-error",
                        "url": canonical_url,
                        "detail": f"{type(exc).__name__}: {exc}",
                    }
                )
                continue
            extraction_statuses[article.quality.status.value] += 1
            content_identity = article_content_identity(
                article.plain_text,
            )
            if content_identity is not None:
                content_identity_articles[content_identity].add(canonical_url)
            article_bodies[canonical_url] = article.plain_text
            replacement_count = replacement_character_count(
                article.headline,
                article.plain_text,
            )
            source_replacement_count = source_replacement_character_count(
                raw_html
            )
            if replacement_count > source_replacement_count:
                hard_anomalies.append(
                    {
                        "type": "decoded-replacement-character",
                        "url": canonical_url,
                        "detail": {
                            "decoded": replacement_count,
                            "source": source_replacement_count,
                        },
                    }
                )
            if article.extraction.parser_version != expected_version:
                hard_anomalies.append(
                    {
                        "type": "parser-version-mismatch",
                        "url": canonical_url,
                        "detail": article.extraction.parser_version,
                    }
                )
            parsed_publication_year = publication_year_for_sample(
                article.published_at,
                capture.published_at,
            )
            if (
                article.quality.status.value == "complete"
                and parsed_publication_year != year
            ):
                # A complete extraction from the wrong publication year is
                # still the wrong validation sample. URL-less-date publishers
                # such as FT can otherwise silently use the WARC capture year
                # for sampling even though the parser later recovers the
                # article's real, older publication timestamp.
                hard_anomalies.append(
                    {
                        "type": "complete-publication-year-mismatch",
                        "url": canonical_url,
                        "detail": {
                            "expectedYear": year,
                            "publishedAt": (
                                article.published_at.isoformat()
                                if article.published_at is not None
                                else None
                            ),
                        },
                    }
                )
            if (
                article.content_type.value == "article"
                and article.quality.status.value != "complete"
            ):
                hard_anomalies.append(
                    {
                        "type": "extraction-not-complete",
                        "url": canonical_url,
                        "detail": article.quality.status.value,
                    }
                )
            elif article.quality.status.value != "complete":
                # Valid non-text packages are not parser defects, but they
                # still need an explicit human review trail.  In particular,
                # do not let a zero-character video/gallery silently blend
                # into an otherwise text-complete 800-row audit.
                review_candidates.append(
                    {
                        "type": "non-text-extraction-status",
                        "url": canonical_url,
                        "detail": {
                            "contentType": article.content_type.value,
                            "status": article.quality.status.value,
                            "bodyCharacters": article.quality.body_characters,
                        },
                    }
                )
                if article.quality.status.value == "unsupported":
                    supported_nontext_types = {
                        "audio",
                        "gallery",
                        "interactive",
                        "video",
                    }
                    if article.content_type.value not in supported_nontext_types:
                        hard_anomalies.append(
                            {
                                "type": "unsupported-content-type",
                                "url": canonical_url,
                                "detail": article.content_type.value,
                            }
                        )
                    elif parsed_publication_year == year:
                        validated_unsupported_nontext += 1
                    else:
                        hard_anomalies.append(
                            {
                                "type": "non-text-publication-year-mismatch",
                                "url": canonical_url,
                                "detail": {
                                    "contentType": article.content_type.value,
                                    "expectedYear": year,
                                    "publishedAt": (
                                        article.published_at.isoformat()
                                        if article.published_at is not None
                                        else None
                                    ),
                                },
                            }
                        )
            if publisher == "axios" and is_axios_internal_test_entry(
                canonical_url,
                article.headline,
            ):
                hard_anomalies.append(
                    {
                        "type": "internal-test-entry",
                        "url": canonical_url,
                        "detail": article.headline,
                    }
                )
            body_lengths.append(len(article.plain_text))
            normalized_blocks = [
                normalize_text(block.text)
                for block in article.blocks
                if normalize_text(block.text)
            ]
            if publisher == "nyt":
                raw_interactive_prose = nyt_raw_interactive_prose_characters(
                    raw_html,
                    canonical_url,
                )
                if (
                    raw_interactive_prose >= 1_000
                    and article.quality.body_characters < 200
                ):
                    hard_anomalies.append(
                        {
                            "type": "interactive-prose-collapse",
                            "url": canonical_url,
                            "detail": {
                                "rawParagraphCharacters": raw_interactive_prose,
                                "parsedBodyCharacters": (
                                    article.quality.body_characters
                                ),
                            },
                        }
                    )
                for text in normalized_blocks:
                    if _NYT_DEAD_INTERACTIVE_CONTROL_RE.fullmatch(text):
                        hard_anomalies.append(
                            {
                                "type": "dead-interactive-control",
                                "url": canonical_url,
                                "detail": text,
                            }
                        )
            for text in set(normalized_blocks):
                if 4 <= len(text) <= 500:
                    block_articles[text].add(canonical_url)
                if _INTERFACE_TEXT_RE.search(text) and not (
                    (publisher == "aljazeera" and text == "read more:")
                    or contextual_signup_article_block(
                        publisher,
                        canonical_url,
                        article.headline,
                        text,
                    )
                    or contextual_scmp_competition_terms_block(
                        publisher,
                        canonical_url,
                        text,
                        article.plain_text,
                    )
                    or contextual_scmp_virtual_event_signup_block(
                        publisher,
                        canonical_url,
                        article.headline,
                        text,
                        article.plain_text,
                        article.body_html,
                    )
                ):
                    hard_anomalies.append(
                        {
                            "type": "interface-text",
                            "url": canonical_url,
                            "detail": text[:500],
                        }
                    )
            duplicate_count = len(normalized_blocks) - len(set(normalized_blocks))
            if duplicate_count:
                hard_anomalies.append(
                    {
                        "type": "duplicate-text-blocks",
                        "url": canonical_url,
                        "detail": duplicate_count,
                    }
                )
            tags = {
                node.name
                for node in BeautifulSoup(article.body_html, "html.parser").find_all(True)
                if node.name in _INTERACTIVE_TAGS
            }
            if tags:
                hard_anomalies.append(
                    {
                        "type": "interactive-tags",
                        "url": canonical_url,
                        "detail": sorted(tags),
                    }
                )
            article_selected_image_urls: defaultdict[str, list[str]] = defaultdict(list)
            for image in article.images:
                if not image.should_archive:
                    continue
                selected_images += 1
                identity = image_identity(image.original_url)
                article_selected_image_urls[identity].append(image.original_url)
                selected_image_articles[identity].add(canonical_url)
                if _suspicious_selected_image(identity):
                    hard_anomalies.append(
                        {
                            "type": "suspicious-selected-image",
                            "url": canonical_url,
                            "detail": image.original_url,
                        }
                    )
                if (
                    image.width is not None
                    and image.height is not None
                    and max(image.width, image.height) <= 160
                ):
                    review_candidates.append(
                        {
                            "type": "small-selected-image",
                            "url": canonical_url,
                            "detail": {
                                "image": image.original_url,
                                "width": image.width,
                                "height": image.height,
                            },
                        }
                    )
            for identity, urls in article_selected_image_urls.items():
                if len(urls) > 1:
                    hard_anomalies.append(
                        {
                            "type": "duplicate-selected-image",
                            "url": canonical_url,
                            "detail": {
                                "identity": identity,
                                "imageUrls": urls,
                            },
                        }
                    )
            if index % 100 == 0:
                print(json.dumps({"audited": index, "target": target}))
    finally:
        connection.close()

    repeated_threshold = max(5, math.ceil(target * 0.01))
    duplicate_identities = [
        {
            "type": "duplicate-article-identity",
            "url": sorted(article_urls)[0],
            "detail": {
                "identity": identity,
                "sampleUrls": sorted(article_urls),
            },
        }
        for identity, article_urls in identity_articles.items()
        if len(article_urls) > 1
    ]
    duplicate_identities.sort(key=lambda item: str(item["url"]))
    hard_anomalies.extend(duplicate_identities)
    duplicate_contents = [
        {
            "type": "duplicate-article-content",
            "url": sorted(article_urls)[0],
            "detail": {
                "identity": identity,
                "sampleUrls": sorted(article_urls),
            },
        }
        for identity, article_urls in content_identity_articles.items()
        if len(article_urls) > 1
    ]
    duplicate_contents.sort(key=lambda item: str(item["url"]))
    hard_anomalies.extend(duplicate_contents)
    hard_anomalies.extend(near_duplicate_article_pairs(article_bodies))
    repeated_blocks = [
        {
            "text": text,
            "articleCount": len(article_urls),
            "sampleUrls": sorted(article_urls)[:5],
        }
        for text, article_urls in block_articles.items()
        if len(article_urls) >= repeated_threshold
    ]
    repeated_blocks.sort(key=lambda item: (-int(item["articleCount"]), str(item["text"])))
    repeated_images = [
        {
            "image": identity,
            "articleCount": len(article_urls),
            "sampleUrls": sorted(article_urls)[:5],
        }
        for identity, article_urls in selected_image_articles.items()
        if len(article_urls) >= 2
    ]
    repeated_images.sort(key=lambda item: (-int(item["articleCount"]), str(item["image"])))
    if repeated_blocks:
        review_candidates.append(
            {"type": "cross-article-repeated-blocks", "items": repeated_blocks}
        )
    if repeated_images:
        review_candidates.append(
            {"type": "cross-article-selected-images", "items": repeated_images}
        )
    issue_counts = Counter(str(item["type"]) for item in hard_anomalies)
    lengths = sorted(body_lengths)
    quantiles = {
        "minimum": lengths[0] if lengths else None,
        "p50": lengths[len(lengths) // 2] if lengths else None,
        "p95": lengths[min(len(lengths) - 1, math.floor(len(lengths) * 0.95))]
        if lengths
        else None,
        "maximum": lengths[-1] if lengths else None,
    }
    passes_content_checks = not hard_anomalies and bool(body_lengths)
    formal_target_reached = len(body_lengths) == target
    return {
        "formatVersion": CONTENT_AUDIT_FORMAT_VERSION,
        "publisher": publisher,
        "year": year,
        "target": target,
        "audited": len(body_lengths),
        "formalTargetReached": formal_target_reached,
        "configuredParserVersion": parser_version,
        "parserVersion": expected_version,
        "qaRevision": qa_revision,
        "extractionStatuses": dict(sorted(extraction_statuses.items())),
        "validatedUnsupportedNonText": validated_unsupported_nontext,
        "bodyCharacters": quantiles,
        "selectedImages": selected_images,
        "hardAnomalyCount": len(hard_anomalies),
        "hardAnomaliesByType": dict(sorted(issue_counts.items())),
        "hardAnomalies": hard_anomalies,
        "reviewCandidateCount": len(review_candidates),
        "reviewCandidates": review_candidates,
        "passesContentChecks": passes_content_checks,
        "passesHardChecks": passes_content_checks and formal_target_reached,
    }


def main() -> int:
    args = parse_args()
    result = audit_content(
        state=args.state,
        archive_root=args.archive_root,
        publisher=args.publisher,
        year=args.year,
        target=args.target,
        expected_parser_version=args.expected_parser_version,
        allow_partial=args.allow_partial,
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in (
                        "publisher",
                        "year",
                        "target",
                        "audited",
                        "formalTargetReached",
                        "parserVersion",
                        "configuredParserVersion",
                        "extractionStatuses",
                        "bodyCharacters",
                        "selectedImages",
                        "hardAnomalyCount",
                        "hardAnomaliesByType",
                        "reviewCandidateCount",
                        "passesHardChecks",
                        "passesContentChecks",
                    )
                }
                | {"output": str(args.output)},
                ensure_ascii=False,
                sort_keys=True,
            )
        )
    else:
        print(rendered)
    accepted = (
        result["passesContentChecks"]
        if args.allow_partial
        else result["passesHardChecks"]
    )
    return 0 if bool(accepted) else 2


if __name__ == "__main__":
    raise SystemExit(main())
