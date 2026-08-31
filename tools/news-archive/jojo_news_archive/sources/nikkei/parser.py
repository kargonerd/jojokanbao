from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import re
from urllib.parse import unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Tag
from jojo_news_archive.models import ImageCandidate
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    image_urls as _image_urls,
    meta_content as _meta_content,
    tag_text as _tag_text,
)


def _nikkei_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if host == "article-image-ix.nikkei.com":
        nested = unquote(parts.path.lstrip("/"))
        nested_parts = urlsplit(nested)
        if nested_parts.scheme in {"http", "https"} and nested_parts.netloc:
            return urlunsplit(
                (
                    nested_parts.scheme.casefold(),
                    nested_parts.netloc.casefold(),
                    nested_parts.path,
                    "",
                    "",
                )
            )
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host == "imgix-proxy.n8s.jp":
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    return None


def _nikkei_legacy_article_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Join split legacy print-story paragraphs and their inline photos."""

    legacy_nodes = [
        node
        for node in soup.select(".cmn-article_text")
        if isinstance(node, Tag)
        and not any(
            isinstance(parent, Tag)
            and "cmn-article_text" in (parent.get("class") or [])
            for parent in node.parents
        )
    ]
    groups: dict[int, tuple[Tag, list[Tag]]] = {}
    for node in legacy_nodes:
        parent = node.parent
        if not isinstance(parent, Tag):
            continue
        group = groups.setdefault(id(parent), (parent, []))[1]
        group.append(node)

    candidates = [group for group in groups.values() if len(group[1]) >= 2]
    if not candidates:
        return None

    selected_group = next(
        (
            group
            for group in candidates
            if selected_body is not None
            and any(node is selected_body for node in group[1])
        ),
        None,
    )
    if selected_group is None:
        if selected_body is not None and all(
            any(node is descendant for descendant in selected_body.descendants)
            for _, nodes in candidates
            for node in nodes
        ):
            return None
        selected_group = max(
            candidates,
            key=lambda group: sum(
                len(_clean_text(node.get_text(" ", strip=True)))
                for node in group[1]
            ),
        )

    parent, nodes = selected_group
    direct_children = [
        child for child in parent.children if isinstance(child, Tag)
    ]
    node_ids = {id(node) for node in nodes}
    text_positions = [
        index
        for index, child in enumerate(direct_children)
        if id(child) in node_ids
    ]
    if len(text_positions) < 2:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='nikkei-legacy-split-body'></article>",
        "html.parser",
    )
    wrapper = document.select_one("article")
    if not isinstance(wrapper, Tag):
        return None

    first_text = text_positions[0]
    last_text = text_positions[-1]
    for index, child in enumerate(direct_children):
        if id(child) in node_ids:
            wrapper.append(copy.deepcopy(child))
            continue
        if not first_text < index < last_text:
            continue
        if any(
            urls
            and any(
                not _nikkei_non_editorial_image_url(url)
                for url in urls
            )
            for image in child.select("img")
            if (
                urls := _image_urls(
                    image,
                    base_url="https://www.nikkei.com/",
                )
            )
        ):
            wrapper.append(copy.deepcopy(child))

    return wrapper if wrapper.get_text(" ", strip=True) else None


def _trim_nikkei_paywall_tail(soup: BeautifulSoup) -> None:
    """Drop the signed-out paywall and all recirculation after the excerpt."""

    marker = soup.select_one(
        "[data-k2-component-name='k2-paywall-container'], "
        "[data-optimizely-selector='paywall-container'], "
        "[class*='paywall' i]"
    )
    if not isinstance(marker, Tag):
        marker = next(
            (
                node
                for node in soup.select("p, div")
                if _clean_text(node.get_text(" ", strip=True)).startswith(
                    (
                        "この記事は会員限定です。登録すると続きをお読みいただけます。",
                        "会員限定です。電子版に登録すると続きをお読みいただけます。",
                    )
                )
            ),
            None,
        )
    if not isinstance(marker, Tag):
        return
    top = soup.find()
    if not isinstance(top, Tag):
        return
    tail = marker
    while isinstance(tail.parent, Tag):
        for sibling in list(tail.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        if tail.parent is top:
            break
        tail = tail.parent
    marker.decompose()


def _remove_nikkei_body_chrome(soup: BeautifulSoup) -> None:
    """Remove modern Nikkei article controls that wrap ordinary text nodes."""

    # Modern snapshots can place the site-wide search, sharing and newsletter
    # controls inside the broad article wrapper. They are browser UI, not
    # editorial content, and their form controls fail the normalized-body
    # contract if left in the archived HTML.
    for node in list(soup.select("form, input, select, textarea, button")):
        node.decompose()

    for selector in (
        "k-image-viewer",
        "k-lock-banner",
        "k-action-bar",
        "header",
        "[class*='openAppLink' i]",
        # Legacy article wrappers include recirculation panels after the last
        # editorial paragraph.  Their generated class suffixes vary, but the
        # component prefixes are stable across archived captures.
        "[class*='relatedArticles_' i]",
    ):
        for node in list(soup.select(selector)):
            node.decompose()

    # The 2013 desktop templates append bordered navigation/promotional
    # widgets using the same ``cmn-article_text`` class as real paragraphs.
    # Their stable labels and border wrapper distinguish them from editorial
    # prose without relying on a generated class name.
    legacy_widget_markers = (
        "週刊メールマガジン配信中",
        "気になる映画の上映館情報をチェック",
        "地域、日時、映画名などから検索可能",
        "「からだマップ」",
        "気になる部位をクリックして、最新情報をチェック！",
    )
    for node in list(soup.select("div.cmn-article_text")):
        style = str(node.get("style") or "").casefold()
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            "border" in style
            and len(text) < 300
            and any(marker in text for marker in legacy_widget_markers)
        ):
            node.decompose()

    # CMS-era ranking/review pages embed a separate affiliate purchase card
    # after the editorial table or review. Keep the article and its rating,
    # but not the Amazon/Rakuten shopping module.
    for node in list(soup.select(".article__embedded-html")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            "この書籍を購入する" in text
            and node.select_one(
                "a[href*='amazon.co.jp'], a[href*='rakuten.co.jp'], "
                "a[href*='rakuten.com']"
            )
            is not None
        ):
            node.decompose()

    # Some legacy snapshots serialize the remaining subscription and topic
    # panels without a useful component class.  Remove only exact UI headings
    # and their compact wrapper; matching exact text avoids trimming ordinary
    # prose that happens to mention related companies or keywords.
    chrome_markers = (
        "すべての記事が読み放題 有料会員が初回１カ月無料",
        "すべての記事が読み放題 有料会員が初回1カ月無料",
        "関連企業・業界",
        "関連キーワード",
    )
    for marker in list(soup.select("p, h2, h3")):
        if _clean_text(marker.get_text(" ", strip=True)) not in chrome_markers:
            continue
        parent = marker.parent
        if (
            isinstance(parent, Tag)
            and parent is not soup
            and len(parent.get_text(" ", strip=True)) < 500
        ):
            parent.decompose()
        else:
            marker.decompose()

    for image in list(soup.select("img")):
        urls = _image_urls(
            image,
            base_url="https://www.nikkei.com/",
        )
        if not urls or not all(
            _nikkei_non_editorial_image_url(url) for url in urls
        ):
            continue
        figure = image.find_parent("figure")
        image.decompose()
        if (
            isinstance(figure, Tag)
            and not _clean_text(figure.get_text(" ", strip=True))
        ):
            figure.decompose()


def _nikkei_non_editorial_image_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    if (
        host
        in {
            "assets.nikkei.jp",
            "parts.nikkei.jp",
            "partsa.nikkei.jp",
        }
        and "/parts/ds/images/common/" in path
        and re.search(r"/icon_(?:ogp|twittercard|zoom_)", path)
    ):
        return True
    if (
        host in {"parts.nikkei.com", "partsa.nikkei.com"}
        and path.endswith("/parts/nstyle/nikkei-style-close-message.png")
    ):
        return True
    decoded = unquote(url).casefold()
    return any(
        marker in decoded
        for marker in (
            "/.resources/k-components/icon/",
            "/.resources/k-components/banner/",
            "/.resources/k-components/rectangle.rev-",
            "/.resources/k-components/square.rev-",
            "paid-banner",
        )
    )


def _nikkei_non_editorial_image_candidate(image: ImageCandidate) -> bool:
    """Reject Nikkei chrome images whose legacy markup only exposes size."""
    return _nikkei_non_editorial_image_url(image.original_url) or (
        image.width is not None
        and image.height is not None
        and image.width <= 120
        and image.height <= 50
    )


def _nikkei_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Read dates rendered by legacy Japanese and Nikkei Asia templates."""

    # Nikkei Asian Review serialized local Japan time without an offset.
    # Treating this value as UTC shifts the instant by nine hours and can move
    # midnight-adjacent stories into the wrong validation day or year.
    metadata_date = _meta_content(soup, "name", "date")
    if metadata_date:
        for format_string in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                parsed = datetime.strptime(metadata_date, format_string)
            except ValueError:
                continue
            return parsed.replace(
                tzinfo=timezone(timedelta(hours=9))
            ).isoformat()

    asia_visible_date = _tag_text(soup.select_one(".date-area"))
    if asia_visible_date:
        normalized = re.sub(r"\s+JST\s*$", "", asia_visible_date).strip()
        for format_string in ("%B %d, %Y %I:%M %p", "%b %d, %Y %I:%M %p"):
            try:
                parsed = datetime.strptime(normalized, format_string)
            except ValueError:
                continue
            return parsed.replace(
                tzinfo=timezone(timedelta(hours=9))
            ).isoformat()

    value = _tag_text(soup.select_one(".cmnc-publish"))
    if not value:
        return None
    match = re.search(
        r"(?P<year>20\d{2})\s*(?:/|年)\s*"
        r"(?P<month>\d{1,2})\s*(?:/|月)\s*"
        r"(?P<day>\d{1,2})(?:日)?",
        value,
    )
    if match is None:
        return None
    try:
        parsed = datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            tzinfo=timezone(timedelta(hours=9)),
        )
    except ValueError:
        return None
    return parsed.isoformat()


def _nikkei_legacy_headline(soup: BeautifulSoup) -> str | None:
    """Recover old Nikkei headlines that only survive in ``<title>``."""

    if soup.title is None:
        return None
    title = _clean_text(soup.title.get_text(" ", strip=True))
    title = re.sub(
        r"(?:\s*[：:]\s*日本経済新聞(?:\s*電子版)?|"
        r"\s*[-–—]\s*Nikkei(?:\s+Asian\s+Review|\s+Asia))\s*$",
        "",
        title,
        flags=re.IGNORECASE,
    ).strip()
    return title or None


def _nikkei_truncated_body(
    soup: BeautifulSoup,
    *,
    plain_text: str,
) -> bool:
    """Detect signed-out Nikkei excerpts in legacy and current shells."""

    if not plain_text:
        return False
    page_text = _clean_text(soup.get_text(" ", strip=True))
    if (
        "会員限定です。電子版に登録すると続きをお読みいただけます。"
        in page_text
        or re.search(r"残り\s*[\d,]+\s*文字", page_text)
    ):
        return True
    if len(plain_text) >= 2_000:
        return False
    return (
        "この記事は会員限定です。登録すると続きをお読みいただけます。"
        in page_text
        or "有料登録すると続きをお読みいただけます。" in page_text
        or plain_text.rstrip().endswith(("…", "..."))
    )


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class NikkeiParser(BaseSourceParser):
    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_default_body as _select_default_body,
        )

        body = _select_default_body(context)
        legacy = _nikkei_legacy_article_body(
            context.soup,
            selected_body=body,
        )
        context.body = legacy if legacy is not None else body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _trim_nikkei_paywall_tail(context.clean_body)
        _remove_nikkei_body_chrome(context.clean_body)

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            first_text as _first_text,
            parse_datetime as _parse_datetime,
        )

        context.headline = _first_text(
            _nikkei_legacy_headline(context.soup),
            context.headline,
        )
        if context.headline:
            context.headline = re.sub(
                r"(?i)\s*[-–—]\s*Nikkei(?:\s+Asian\s+Review|\s+Asia)\s*$",
                "",
                context.headline,
            ).strip()
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _nikkei_legacy_published_at(context.soup)
            )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not _nikkei_non_editorial_image_url(url)

    def image_identity(self, url: str) -> str | None:
        return _nikkei_image_identity(url)

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _nikkei_non_editorial_image_candidate(image)

    def quality_warnings(self, context: ParseContext) -> list[str]:
        return (
            ["truncated-body"]
            if _nikkei_truncated_body(
                context.soup,
                plain_text=context.plain_text,
            )
            else []
        )


PARSER: NikkeiParser = NikkeiParser()
