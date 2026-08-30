from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from urllib.parse import parse_qsl, urlsplit, urlunsplit
from uuid import UUID


@dataclass(frozen=True)
class ArchiveSourceSpec:
    publisher: str
    canonical_host: str
    wayback_patterns: tuple[str, ...]
    accepted_path_patterns: tuple[re.Pattern[str], ...]
    rejected_path_patterns: tuple[re.Pattern[str], ...] = ()
    alternate_hosts: tuple[str, ...] = ()
    preserve_normalized_hosts: tuple[str, ...] = ()

    def expanded_wayback_patterns(
        self,
        *,
        from_year: int,
        to_year: int,
    ) -> tuple[str, ...]:
        result: list[str] = []
        for pattern in self.wayback_patterns:
            if "{year}" in pattern:
                result.extend(
                    pattern.format(year=year)
                    for year in range(from_year, to_year + 1)
                )
            else:
                result.append(pattern)
        return tuple(result)


def _patterns(*values: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(value, re.IGNORECASE) for value in values)


_SLUG_PREFIXES = tuple("abcdefghijklmnopqrstuvwxyz0123456789")
_NON_ARTICLE_FILE_SUFFIX_RE = re.compile(
    r"\.(?:avif|bmp|css|gif|ico|jpe?g|js|mjs|pdf|png|svg|webp)$",
    re.IGNORECASE,
)

_CAIXIN_EDITORIAL_HOSTS = (
    "china.caixin.com",
    "economy.caixin.com",
    "finance.caixin.com",
    "companies.caixin.com",
    "international.caixin.com",
    "opinion.caixin.com",
    "culture.caixin.com",
    # Caixin publishes first-party photo essays under a dated article URL
    # family.  Keep the host distinct: its story ids do not alias the text
    # desks, and gallery captures exercise a separate editorial template.
    "photos.caixin.com",
    "video.caixin.com",
)

# These pages are retained by the raw archive for provenance, but they are
# image/video packages rather than text-news articles.  Sampling them into a
# parser cohort wastes one of the fixed 800 article slots and can make a
# source look artificially capacity-deficient after QA screens them.
_PARSER_VALIDATION_NONARTICLE_HOSTS = {
    "caixin": frozenset({"photos.caixin.com", "video.caixin.com"}),
}


ARCHIVE_SOURCE_SPECS = {
    "ap": ArchiveSourceSpec(
        publisher="ap",
        canonical_host="apnews.com",
        wayback_patterns=tuple(
            f"hosted.ap.org/dynamic/stories/{prefix.upper()}/*"
            for prefix in _SLUG_PREFIXES
        ) + (
            "apnews.com/article/*",
            "apnews.com/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/article/",
            r"^/[a-f0-9]{24,}$",
            r"^/.+-[a-f0-9]{24,}$",
            r"^/dynamic/stories/[a-z0-9]/[a-z0-9_-]+$",
            # Historical AP wire copies were distributed through Yahoo,
            # Google Hosted News, and HuffPost.  They remain first-class AP
            # parser inputs: the partner catalog preserves the source URL so
            # the raw capture and provenance stay auditable.
            r"^/s/ap(?:_[A-Za-z0-9_-]+)?/20\d{6}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$",
            r"^/hostednews/ap/article/[A-Za-z0-9_-]+$",
            r"^/huff-wires/20\d{6}/[A-Za-z0-9_-]+$",
        ),
        rejected_path_patterns=_patterns(
            r"^/(?:hub|video|videos|search|press-releases|newsletters)(?:/|$)",
        ),
        alternate_hosts=(
            "hosted.ap.org",
            "hosted2.ap.org",
            "bigstory.ap.org",
            "news.yahoo.com",
            "www.news.yahoo.com",
            "google.com",
            "www.google.com",
            "huffingtonpost.com",
            "www.huffingtonpost.com",
        ),
        preserve_normalized_hosts=(
            "bigstory.ap.org",
            "news.yahoo.com",
            "www.google.com",
            "www.huffingtonpost.com",
        ),
    ),
    "wsj": ArchiveSourceSpec(
        publisher="wsj",
        canonical_host="www.wsj.com",
        wayback_patterns=tuple(
            f"www.wsj.com/articles/{prefix}*"
            for prefix in _SLUG_PREFIXES
        )
        + (
            "online.wsj.com/article/*",
            # The legacy WSJ CMS also exposed stories below the plural
            # ``/news/articles/`` route.  This family is especially useful
            # for 2010--2013 captures; omitting it leaves those years with
            # an artificially small Wayback candidate pool.
            "online.wsj.com/news/articles/*",
            "www.wsj.com/news/articles/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/articles/",
            r"^/article/",
            r"^/news/.+",
            r"^/(?:[a-z0-9-]+/)+[a-z0-9-]+-[0-9a-f]{8}$",
        ),
        rejected_path_patterns=_patterns(
            r"/(?:video|podcasts?|newsletters?|livecoverage)(?:/|$)",
            r"^/articles/[^/]*-crossword(?:-|$)",
        ),
    ),
    "bloomberg": ArchiveSourceSpec(
        publisher="bloomberg",
        canonical_host="www.bloomberg.com",
        wayback_patterns=(
            "www.bloomberg.com/news/articles/*",
            "www.bloomberg.com/opinion/articles/*",
            "www.bloomberg.com/features/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/news/articles/",
            r"^/opinion/articles/",
            r"^/features/",
        ),
    ),
    "nyt": ArchiveSourceSpec(
        publisher="nyt",
        canonical_host="www.nytimes.com",
        wayback_patterns=(
            "www.nytimes.com/{year}/*",
            "nytimes.com/{year}/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/20\d{2}/\d{2}/\d{2}/",
            r"^/interactive/20\d{2}/",
        ),
        rejected_path_patterns=_patterns(
            r"/(?:video|podcasts?|crosswords?|games|wirecutter)(?:/|$)",
        ),
    ),
    "reuters": ArchiveSourceSpec(
        publisher="reuters",
        canonical_host="www.reuters.com",
        # Reuters migrated away from the legacy ``/article/<slug>`` URL
        # family during the 2010s.  Keep the legacy per-prefix queries (they
        # are still the best source for early wire stories), but also index
        # the section-root URLs used by the newer CMS.  Without these roots,
        # the 2016-2020 shard can appear capacity-deficient even though
        # Common Crawl/Wayback contain valid ``/world/...`` and
        # ``/business/...`` stories.
        wayback_patterns=tuple(
            f"www.reuters.com/article/{prefix}*"
            for prefix in _SLUG_PREFIXES
        ) + tuple(
            f"www.reuters.com/{section}/*"
            for section in (
                "world",
                "business",
                "markets",
                "technology",
                "legal",
                "sports",
                "lifestyle",
                "science",
                "fact-check",
                "breakingviews",
                "investigates",
            )
        ),
        accepted_path_patterns=_patterns(
            r"^/article/",
            (
                r"^/(?:world|business|markets|technology|legal|sports|"
                r"lifestyle|science|fact-check|breakingviews|"
                r"investigates)/.+"
            ),
        ),
        rejected_path_patterns=_patterns(
            r"/(?:video|pictures|graphics)(?:/|$)",
            r"^/article/(?:comments|slideshow)(?:/|$)",
            r"%3c|%3e",
        ),
    ),
    "ft": ArchiveSourceSpec(
        publisher="ft",
        canonical_host="www.ft.com",
        wayback_patterns=(
            "www.ft.com/content/*",
            "ft.com/content/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/content/[0-9a-f-]{20,}$",
        ),
    ),
    "axios": ArchiveSourceSpec(
        publisher="axios",
        canonical_host="www.axios.com",
        wayback_patterns=(
            "axios.com/{year}/*",
            "www.axios.com/{year}/*",
            "axios.com/*/{year}/*",
            "www.axios.com/*/{year}/*",
            "axios.com/local/*/{year}/*",
            "www.axios.com/local/*/{year}/*",
            "axios.com/local/*",
            "www.axios.com/local/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/(?:local/[^/]+/|[^/]+/)?20\d{2}/"
        ),
        rejected_path_patterns=_patterns(r"^/(?:newsletters?|signup|about)(?:/|$)"),
    ),
    "npr": ArchiveSourceSpec(
        publisher="npr",
        canonical_host="www.npr.org",
        # Internet Archive indexes the bare and www hosts as distinct URL
        # keys.  Normalize both to www below, but query both so articles that
        # were only captured under npr.org are not omitted from discovery.
        wayback_patterns=(
            "www.npr.org/{year}/*",
            "npr.org/{year}/*",
        ),
        accepted_path_patterns=_patterns(
            r"^/20\d{2}/",
            r"^/sections/[^/]+/20\d{2}/",
            r"^/templates/story/story\.php(?:&storyId=\d+)?$",
        ),
        rejected_path_patterns=_patterns(
            r"^/(?:programs|podcasts?|music)(?:/|$)",
            r"/(?:election-\d{4}-.+-results|excerpt-[a-z0-9-]+|nprs?-toy-stories|makeover-photos)(?:/|$)",
        ),
    ),
    "nikkei": ArchiveSourceSpec(
        publisher="nikkei",
        canonical_host="www.nikkei.com",
        wayback_patterns=("www.nikkei.com/article/*",),
        # URL-key CDX pages also contain every intermediate prefix and static
        # asset requested below an article URL. A real Nikkei article uses a
        # long alphanumeric story id; accepting the directory alone inflated
        # the catalog with `/article/D`, JavaScript files, and similar keys.
        accepted_path_patterns=_patterns(
            r"^/article/(?:[A-Z]{8}\d{5}|[A-Z]{6}\d{7}|"
            r"[A-Z0-9_]{15,})/?$",
        ),
    ),
    "zaobao": ArchiveSourceSpec(
        publisher="zaobao",
        canonical_host="www.zaobao.com.sg",
        # CDX treats the URL argument as a prefix; an infix wildcard such as
        # `* /story*` is not a recursive path glob and returns no captures.
        # Historical articles are published below /news/<section>/storyYYYY….
        wayback_patterns=("www.zaobao.com.sg/news/*",),
        # Official monthly sitemaps include realtime, news, lifestyle and
        # nested special-report desks. Their shared invariant is a dated
        # story id, not a fixed section depth.
        accepted_path_patterns=_patterns(
            r"^/(?:[a-z0-9-]+/)+story20\d{6}-\d+$"
        ),
        rejected_path_patterns=_patterns(r"^/(?:zvideos|podcast)(?:/|$)"),
    ),
    "aljazeera": ArchiveSourceSpec(
        publisher="aljazeera",
        canonical_host="www.aljazeera.com",
        wayback_patterns=(
            "www.aljazeera.com/news/{year}/*",
            "www.aljazeera.com/economy/{year}/*",
            "www.aljazeera.com/features/{year}/*",
            "www.aljazeera.com/opinions/{year}/*",
            "www.aljazeera.com/sports/{year}/*",
            "www.aljazeera.com/gallery/{year}/*",
            # The pre-migration CMS also exposed stories directly below the
            # year root (and on the bare host). Keep these additive patterns
            # so the URL-key/Common Crawl supplements can discover legacy
            # identities that never appeared in the current sitemap.
            "www.aljazeera.com/{year}/*",
            "aljazeera.com/{year}/*",
        ),
        # The official article sitemap contains several editorial desks beyond
        # the main news/features/opinions routes. Keep the explicit prefix
        # families above in sync with those historical sitemap sections so a
        # URL-key/CC catalog does not silently omit economy, sports, or
        # gallery captures. A dated one- or two-level section path plus a
        # non-empty slug is the stable canonical article shape.
        accepted_path_patterns=_patterns(
            r"^/(?:[a-z0-9-]+/){1,2}20\d{2}/"
            r"\d{1,2}/\d{1,2}/[^/]+$",
            r"^/20\d{2}/\d{1,2}/\d{1,2}/[^/]+$",
            # Al Jazeera's pre-migration CMS used compact numeric story ids
            # below a year/month path, for example
            # `/news/2010/02/2010212134228827506.html`.  The id starts with
            # the publication year but has no separate day path component.
            # Requiring the numeric year prefix keeps malformed nested URL
            # keys and ordinary HTML assets outside the article catalog.
            r"^/(?:[a-z0-9-]+/){1,2}20\d{2}/\d{2}/"
            r"20\d{6,}\.html$",
            r"^/20\d{2}/\d{2}/20\d{6,}\.html$",
        ),
        rejected_path_patterns=_patterns(r"^/(?:video|program|podcasts?)(?:/|$)"),
    ),
    "scmp": ArchiveSourceSpec(
        publisher="scmp",
        canonical_host="www.scmp.com",
        # Modern SCMP article URLs are nested below section paths (for
        # example /news/china/.../article/<id>).  Keep explicit section
        # prefixes because the Common Crawl indexer only accepts one trailing
        # wildcard; the older two-level wildcard cannot become a prefix query.
        wayback_patterns=(
            "www.scmp.com/article/*",
            "www.scmp.com/*/article/*",
            "www.scmp.com/news/*",
            "www.scmp.com/business/*",
            "www.scmp.com/sport/*",
            "www.scmp.com/lifestyle/*",
            "www.scmp.com/tech/*",
            "www.scmp.com/comment/*",
            "www.scmp.com/asia/*",
            "www.scmp.com/infographics/*",
        ),
        accepted_path_patterns=_patterns(r"^/article/\d+", r"^/.+/article/\d+"),
        rejected_path_patterns=_patterns(r"^/(?:video|magazines)(?:/|$)"),
    ),
    "caixin": ArchiveSourceSpec(
        publisher="caixin",
        canonical_host="www.caixin.com",
        wayback_patterns=(
            "www.caixin.com/*",
            "www.caixin.com/{year}-*",
            "www.caixin.com/{year}/*",
            "magazine.caixin.com/{year}/*",
        )
        + tuple(f"{host}/{{year}}-*" for host in _CAIXIN_EDITORIAL_HOSTS),
        accepted_path_patterns=_patterns(r"^/20\d{2}(?:[-/]|$)"),
        alternate_hosts=("magazine.caixin.com",) + _CAIXIN_EDITORIAL_HOSTS,
        preserve_normalized_hosts=("magazine.caixin.com",)
        + _CAIXIN_EDITORIAL_HOSTS,
    ),
}


def archive_source_spec(publisher: str) -> ArchiveSourceSpec:
    try:
        return ARCHIVE_SOURCE_SPECS[publisher]
    except KeyError as exc:
        supported = ", ".join(sorted(ARCHIVE_SOURCE_SPECS))
        raise ValueError(
            f"unsupported publisher {publisher!r}; expected one of: {supported}"
        ) from exc


def archive_source_variant(
    publisher: str,
    variant: str = "canonical",
) -> ArchiveSourceSpec:
    """Return an explicitly isolated discovery variant for a publisher.

    Variants are intended for source-capacity probes. They do not alter the
    canonical publisher spec or make the resulting manifest a parser source;
    callers must keep their checkpoints under a separate storage mode until
    the candidate family has been audited.
    """

    spec = archive_source_spec(publisher)
    if variant == "canonical":
        return spec
    if variant == "wsj-legacy-probe" and publisher == "wsj":
        return ArchiveSourceSpec(
            publisher=spec.publisher,
            canonical_host=spec.canonical_host,
            # Isolate the undated pre-epoch CMS families. The canonical WSJ
            # Common Crawl checkpoint already covers dated `/articles/`
            # slugs; mixing the two would make the capacity experiment
            # impossible to audit independently.
            wayback_patterns=(
                "online.wsj.com/article/*",
                "online.wsj.com/news/articles/*",
                "www.wsj.com/news/articles/*",
            ),
            accepted_path_patterns=spec.accepted_path_patterns,
            rejected_path_patterns=spec.rejected_path_patterns,
        )
    if variant != "nikkei-asia-probe" or publisher != "nikkei":
        raise ValueError(
            f"unsupported archive source variant {variant!r} "
            f"for publisher {publisher!r}"
        )
    return ArchiveSourceSpec(
        publisher=spec.publisher,
        canonical_host="asia.nikkei.com",
        wayback_patterns=("asia.nikkei.com/*",),
        # Nikkei Asia's legacy CMS uses desk/slug paths rather than the
        # Japanese site's /article/<id> family. Requiring at least two path
        # segments removes the home page and top-level desk landings while
        # retaining both magazine and ordinary story routes for hydration.
        accepted_path_patterns=_patterns(r"^/(?:[^/?#]+/)+[^/?#]+$"),
        rejected_path_patterns=_patterns(
            r"^/(?:about|authors?|info|login|search|subscribe|tags?|topics?|"
            r"user)(?:/|$)"
        ),
        preserve_normalized_hosts=("asia.nikkei.com",),
    )


def normalize_article_url(
    spec: ArchiveSourceSpec,
    value: str,
) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    hostname = parsed.hostname.casefold()
    allowed_hosts = {
        spec.canonical_host,
        spec.canonical_host.removeprefix("www."),
        f"www.{spec.canonical_host.removeprefix('www.')}",
    }
    allowed_hosts.update(spec.alternate_hosts)
    if spec.publisher == "wsj":
        allowed_hosts.add("online.wsj.com")
    if hostname not in allowed_hosts:
        return None
    path = re.sub(r"/+", "/", parsed.path or "/")
    if (
        spec.publisher == "nikkei"
        and path.startswith("/article/article/")
    ):
        # Three legacy CDX keys repeat the article directory but otherwise
        # contain a valid Nikkei story id. Normalize them instead of either
        # losing the article or preserving a non-canonical duplicate.
        path = "/article/" + path.removeprefix("/article/article/")
    if spec.publisher == "npr":
        legacy_story = re.search(
            r"(?i)(?:[?&]|%3f|%26)storyid(?:=|%3d)(\d+)",
            value,
        )
        if path.casefold().startswith("/templates/story/story.php"):
            if legacy_story is None:
                return None
            # Preserve the historical public URL as provenance while
            # canonicalizing malformed CDX aliases that put ``&storyId`` in
            # the path. The numeric id also deduplicates this URL against the
            # modern dated NPR canonical URL below.
            return (
                "https://www.npr.org/templates/story/story.php?storyId="
                + legacy_story.group(1)
            )
        # CDX indexes occasionally contain scraper-added line endings or a
        # trailing assignment marker. Neither can be part of NPR's article
        # slug, and leaving them in place prevents timemap fallback from
        # finding captures for the real canonical URL.
        path = re.sub(
            r"(?i)(?:%(?:0[0-9a-f]|7f))+$",
            "",
            path,
        ).rstrip("=")
        # Some CDX keys append tracking parameters to the path rather than
        # storing them as a query string. They are aliases of the same story.
        path = re.split(
            r"(?i)(?:&|%26)(?:sc|cc|ps)=",
            path,
            maxsplit=1,
        )[0]
        path = re.sub(r"(?i)(?:%5d|\])$", "", path)
    if spec.publisher == "axios":
        # Historical CDX keys include malformed aliases whose slug differs
        # from the canonical article only by trailing hyphens or encoded
        # whitespace/backslashes. Axios does not publish those suffixes;
        # treating them as separate URLs can place the same story twice in
        # an 800-item cohort.
        path = re.sub(
            r"(?i)(?:%(?:09|0a|0d|20|5c|7f))+$",
            "",
            path,
        )
        path = path.rstrip("-")
    if spec.publisher == "wsj":
        # Legacy CDX keys occasionally append encoded whitespace or control
        # characters to an otherwise valid WSJ article path.  The replay can
        # still resolve to the real story, but retaining the malformed suffix
        # creates a second validation identity for the same article.
        path = re.sub(
            r"(?i)(?:%(?:09|0a|0d|20|7f))+$",
            "",
            path.rstrip("/"),
        )
    if spec.publisher == "caixin":
        # Legacy magazine articles split long stories into numbered pages and
        # expose an ``_all`` full-text view. They are representations of one
        # article, not independent stories.
        path = re.sub(
            r"_(?:all|\d+)(\.html)$",
            r"\1",
            path,
            flags=re.IGNORECASE,
        )
    if spec.publisher == "reuters" and re.search(
        r"[|<>(){}]|%(?:28|29|3c|3e|7b|7c|7d)",
        path,
        re.IGNORECASE,
    ):
        return None
    if _NON_ARTICLE_FILE_SUFFIX_RE.search(path):
        return None
    if any(pattern.search(path) for pattern in spec.rejected_path_patterns):
        return None
    if not any(pattern.search(path) for pattern in spec.accepted_path_patterns):
        return None
    if path != "/":
        path = path.rstrip("/")
    if spec.publisher == "ap" and hostname in {
        "hosted.ap.org",
        "hosted2.ap.org",
    }:
        published = ap_hosted_publication_datetime(value)
        if published is None:
            return None
        return urlunsplit(
            (
                "https",
                "hosted.ap.org",
                path,
                "CTIME=" + published.strftime("%Y-%m-%d-%H-%M-%S"),
                "",
            )
        )
    normalized_host = (
        hostname
        if hostname in spec.preserve_normalized_hosts
        else spec.canonical_host
    )
    return urlunsplit(("https", normalized_host, path, "", ""))


def is_parser_validation_candidate(
    spec: ArchiveSourceSpec,
    value: str,
) -> bool:
    """Return whether a canonical source URL may occupy a text QA slot.

    The raw archive deliberately keeps non-text desks.  This narrower
    predicate is only for the parser-validation sampler, where a photo/video
    package cannot satisfy the article-body gate and should be skipped before
    the random 800-row draw.
    """

    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return False
    if spec.publisher == "aljazeera" and re.fullmatch(
        r"/gallery/(?:19|20)\d{2}/\d{1,2}/\d{1,2}/photo-\d+",
        urlsplit(normalized).path,
        flags=re.IGNORECASE,
    ):
        # Al Jazeera exposes individual gallery slides as self-canonical
        # ``photo-N`` pages even though their metadata, captions and complete
        # image set duplicate the named gallery article.  Preserve those raw
        # pages, but do not count them as independent validation articles.
        return False
    if spec.publisher == "aljazeera" and re.fullmatch(
        r"/(?:[a-z0-9-]+/){1,2}(?:19|20)\d{2}/\d{1,2}/\d{1,2}/hold-[^/]+",
        urlsplit(normalized).path,
        flags=re.IGNORECASE,
    ):
        # ``hold-`` routes are Al Jazeera CMS staging aliases.  The publisher
        # can expose both the staging and final slug as self-canonical pages,
        # with effectively identical article bodies.  Preserve their raw
        # captures for provenance, but never count the staging alias as an
        # independent validation article.
        return False
    if spec.publisher == "nyt" and re.fullmatch(
        r"/interactive/20\d{2}/us/[a-z0-9-]+-covid-cases\.html",
        urlsplit(normalized).path,
        flags=re.IGNORECASE,
    ):
        # NYT publishes one templated COVID data dashboard per county. The
        # pages are valid raw interactive records, but their prose and hero
        # image are almost identical across hundreds of routes; allowing
        # them into the fixed article cohort produces pseudo-independent
        # samples. Preserve the raw pages while drawing replacement news
        # articles for parser validation.
        return False
    hostname = (urlsplit(normalized).hostname or "").casefold()
    return hostname not in _PARSER_VALIDATION_NONARTICLE_HOSTS.get(
        spec.publisher,
        (),
    )


def article_deduplication_key(
    spec: ArchiveSourceSpec,
    value: str,
) -> str | None:
    """Return a stable story identity without changing its public URL."""

    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return None
    if spec.publisher == "ap":
        parsed = urlsplit(normalized)
        host = (parsed.hostname or "").casefold()
        if host in {"news.yahoo.com", "www.news.yahoo.com"}:
            match = re.match(
                r"^/s/ap(?:_[A-Za-z0-9_-]+)?/"
                r"((?:19|20)\d{2})\d{4}/[A-Za-z0-9_-]+/"
                r"([A-Za-z0-9_-]+)$",
                parsed.path,
            )
            if match is not None:
                # Yahoo exposed the same AP wire item below multiple desk
                # paths, capture dates and revision suffixes.  The year plus
                # wire slug is the stable story identity; retaining the year
                # avoids collapsing recurring AP slugs across annual cohorts.
                slug = re.sub(r"_\d+$", "", match.group(2).casefold())
                return f"ap-yahoo:{match.group(1)}:{slug}"
    if spec.publisher == "npr":
        legacy_story = re.search(
            r"(?i)[?&]storyid=(\d+)",
            normalized,
        )
        if legacy_story is not None:
            return f"npr:{legacy_story.group(1)}"
        match = re.match(
            r"^/(?:sections/[^/]+/)?\d{4}/\d{2}/\d{2}/(\d+)(?:/|$)",
            urlsplit(normalized).path,
        )
        if match is not None:
            return f"npr:{match.group(1)}"
    if spec.publisher == "aljazeera":
        path = urlsplit(normalized).path
        match = re.match(
            r"^/(?:[a-z0-9-]+/){1,2}"
            r"((?:19|20)\d{2}/\d{1,2}/\d{1,2}/[^/]+)$",
            path,
            flags=re.IGNORECASE,
        )
        if match is not None:
            # Al Jazeera occasionally publishes one story under two desks,
            # for example /news/YYYY/M/D/slug and /sports/YYYY/M/D/slug.
            # Both routes remain useful public aliases, but they must occupy
            # one independent validation slot rather than two.
            return f"aljazeera:{match.group(1).casefold()}"
    return normalized


def article_url_publication_year(
    spec: ArchiveSourceSpec,
    value: str,
) -> int | None:
    normalized = normalize_article_url(spec, value)
    if normalized is None:
        return None
    path = urlsplit(normalized).path
    if spec.publisher == "wsj":
        published = wsj_article_publication_datetime(normalized)
        return published.year if published is not None else None
    if spec.publisher == "ap":
        published = ap_hosted_publication_datetime(normalized)
        if published is not None:
            return published.year
        host = (urlsplit(normalized).hostname or "").casefold()
        if host in {"news.yahoo.com", "www.news.yahoo.com"}:
            match = re.match(
                r"^/s/ap(?:_[A-Za-z0-9_-]+)?/(20\d{6})/",
                path,
            )
            if match is not None:
                return int(match.group(1)[:4])
        if host in {"huffingtonpost.com", "www.huffingtonpost.com"}:
            match = re.match(r"^/huff-wires/(20\d{6})/", path)
            if match is not None:
                return int(match.group(1)[:4])
        return None
    if spec.publisher == "nikkei":
        # Legacy Nikkei article IDs encode the publication year and month in
        # segments such as R10C13A9 (2013-09) or Z20C11A4 (2011-04).
        # Wayback may replay a later generic/member page whose visible date is
        # the capture year, so use this stable identifier to reject misplaced
        # validation rows. Newer opaque IDs intentionally return no year.
        match = re.search(
            r"[A-Z]\d{2}C(\d{2})A(?:1[0-2]|[1-9])",
            path,
            flags=re.IGNORECASE,
        )
        return 2000 + int(match.group(1)) if match is not None else None
    if spec.publisher == "nyt":
        # NYT interactives encode their publication year after the
        # ``/interactive`` namespace rather than at the path root.
        match = re.match(
            r"^/(?:interactive/)?((?:19|20)\d{2})(?:/|$)",
            path,
        )
        return int(match.group(1)) if match is not None else None
    if spec.publisher == "npr":
        match = re.match(
            r"^/(?:sections/[^/]+/)?((?:19|20)\d{2})/\d{2}/\d{2}/"
            r"\d+(?:/|$)",
            path,
        )
        return int(match.group(1)) if match is not None else None
    if spec.publisher != "reuters":
        return None
    if not path.startswith("/article/"):
        return None
    matches = re.findall(
        r"((?:19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])",
        path,
    )
    return int(matches[-1]) if matches else None


def ft_content_uuid_creation_year(value: str) -> int | None:
    """Return the creation year encoded by an FT UUIDv1 content id.

    This is a candidate-screening hint, not a publication timestamp: an FT
    draft can be created before it is published. Validation therefore keeps
    the adjacent following year and lets parsed article metadata make the
    final publication-year decision.
    """

    parsed = urlsplit(value.strip())
    if (parsed.hostname or "").casefold() not in {"ft.com", "www.ft.com"}:
        return None
    match = re.fullmatch(
        r"/content/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
        r"[0-9a-f]{4}-[0-9a-f]{12})",
        parsed.path,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    try:
        article_uuid = UUID(match.group(1))
    except ValueError:
        return None
    if article_uuid.version != 1:
        return None
    created = datetime(1582, 10, 15, tzinfo=timezone.utc) + timedelta(
        microseconds=article_uuid.time // 10
    )
    return created.year


def ap_hosted_publication_datetime(value: str) -> datetime | None:
    """Parse the story-revision timestamp used by legacy Hosted AP URLs."""
    parsed = urlsplit(value.strip())
    if (parsed.hostname or "").casefold() not in {
        "hosted.ap.org",
        "hosted2.ap.org",
    }:
        return None
    ctime = next(
        (
            query_value
            for key, query_value in parse_qsl(
                parsed.query,
                keep_blank_values=True,
            )
            if key.casefold() == "ctime"
        ),
        "",
    )
    match = re.fullmatch(
        r"((?:19|20)\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})",
        ctime,
    )
    if match is None:
        return None
    try:
        return datetime(
            *(int(value) for value in match.groups()),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def wsj_article_publication_datetime(value: str) -> datetime | None:
    normalized = normalize_article_url(archive_source_spec("wsj"), value)
    if normalized is None:
        return None
    match = re.search(
        r"/articles/[^/?#]+-(\d{10,12})$",
        urlsplit(normalized).path,
    )
    if match is None:
        return None
    raw_identifier = match.group(1)
    if len(raw_identifier) == 10:
        raw_epoch = raw_identifier
    elif len(raw_identifier) == 11 and raw_identifier.startswith("1"):
        raw_epoch = raw_identifier[1:]
    elif len(raw_identifier) == 12:
        raw_epoch = raw_identifier[2:]
    else:
        return None
    published = datetime.fromtimestamp(int(raw_epoch), tz=timezone.utc)
    if not 2008 <= published.year <= 2038:
        return None
    return published.replace(hour=0, minute=0, second=0, microsecond=0)
