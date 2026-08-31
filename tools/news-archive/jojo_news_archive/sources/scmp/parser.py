from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit
from bs4 import BeautifulSoup, NavigableString, Tag
from jojo_news_archive.models import (
    Author,
    BlockType,
    ContentBlock,
    ContentType,
    ImageCandidate,
)
from jojo_news_archive.parsing.images import (
    generic_image_identity as _generic_image_identity,
)
from jojo_news_archive.parsing.primitives import (
    block_plain_text as _block_plain_text,
    clean_text as _clean_text,
    first_text as _first_text,
    meta_content as _meta_content,
    normalized_url as _normalized_url,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _scmp_source_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() not in {
        "cdn.i-scmp.com",
        "cdn1.i-scmp.com",
        "img.i-scmp.com",
    }:
        return None
    path = unquote(parts.path)
    path = re.sub(
        r"^/cdn-cgi/image/[^/]+/(?=sites/default/files/)",
        "/",
        path,
        flags=re.IGNORECASE,
    )
    path = re.sub(
        r"^/sites/default/files/styles/[^/]+/public/",
        "/sites/default/files/",
        path,
        flags=re.IGNORECASE,
    )
    path = re.sub(
        r"_(?:image_hires|\d+x\d*)_(\d+)(\.[a-z0-9]+)$",
        r"_\1\2",
        path,
        flags=re.IGNORECASE,
    )
    path = re.sub(
        r"_(?:image_hires|\d+x\d*)(\.[a-z0-9]+)$",
        r"\1",
        path,
        flags=re.IGNORECASE,
    )
    if path.casefold().startswith("/sites/default/files/"):
        return f"scmp-image:{path.casefold()}"
    return None


def _image_identity(url: str) -> str:
    generic = _generic_image_identity(url)
    return (
        _scmp_source_image_identity(url)
        or _scmp_source_image_identity(generic)
        or generic
    )


def _scmp_apollo_body(soup: BeautifulSoup) -> Tag | None:
    """Render article paragraphs retained in SCMP's Apollo state cache.

    Around 2016--2021 SCMP captures often contain a complete ``body`` JSON
    tree in ``window.__APOLLO_STATE__`` but no server-rendered article node.
    Ads and recommendation rows are intentionally ignored; the raw capture
    remains available for any future structured-field expansion.
    """

    decoder = json.JSONDecoder()
    body_arrays: list[list[Any]] = []
    body_array_identities: set[str] = set()
    current_article_body_identities: set[str] = set()
    apollo_images: list[dict[str, Any]] = []
    canonical_paths = {
        urlsplit(value).path.rstrip("/")
        for value in (
            _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
            _tag_attribute(
                soup.select_one("meta[property='og:url']"), "content"
            ),
        )
        if value and urlsplit(value).path
    }
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if (
            "__APOLLO_STATE__" not in value
            or ("body(" not in value and '"body"' not in value)
        ):
            continue
        for match in re.finditer(
            r"window\.__APOLLO_STATE__\s*=\s*(?=\{)",
            value,
        ):
            try:
                payload, _ = decoder.raw_decode(value[match.end() :])
            except (json.JSONDecodeError, TypeError):
                continue
            # Cooking and other verticals store article images as Apollo
            # references instead of embedding URL-bearing objects in the
            # article. Resolve only the image references owned by the same
            # entity that owns a recoverable body; this excludes recommendation
            # and queue artwork elsewhere in the cache.
            for cache in payload.values() if isinstance(payload, dict) else ():
                if not isinstance(cache, dict):
                    continue
                for entity in cache.values():
                    if not isinstance(entity, dict):
                        continue
                    direct_body = entity.get("body")
                    if not isinstance(direct_body, dict):
                        direct_body = next(
                            (
                                candidate
                                for key, candidate in entity.items()
                                if str(key).startswith("body(")
                                and isinstance(candidate, dict)
                            ),
                            None,
                        )
                    entity_path = urlsplit(
                        _string_or_none(entity.get("urlAlias")) or ""
                    ).path.rstrip("/")
                    entity_matches_current = bool(
                        canonical_paths and entity_path in canonical_paths
                    )
                    if (
                        entity_matches_current
                        and isinstance(direct_body, dict)
                        and isinstance(direct_body.get("json"), list)
                    ):
                        current_article_body_identities.add(
                            json.dumps(
                                direct_body["json"],
                                ensure_ascii=False,
                                sort_keys=True,
                                separators=(",", ":"),
                            )
                        )
                    if not (
                        isinstance(direct_body, dict)
                        and isinstance(direct_body.get("json"), list)
                        and isinstance(entity.get("images"), list)
                        and (not canonical_paths or entity_matches_current)
                    ):
                        continue
                    for reference in entity["images"]:
                        if not isinstance(reference, dict):
                            continue
                        referenced = cache.get(reference.get("id"))
                        if not isinstance(referenced, dict):
                            continue
                        image_url = _string_or_none(referenced.get("url"))
                        if not image_url:
                            style_references = next(
                                (
                                    styles
                                    for style_key, styles in referenced.items()
                                    if str(style_key).startswith("styles(")
                                    and isinstance(styles, list)
                                ),
                                [],
                            )
                            preferred = next(
                                (
                                    style
                                    for style in style_references
                                    if isinstance(style, dict)
                                    and "/styles/1920x1080/" in str(style.get("id"))
                                ),
                                None,
                            )
                            if preferred is None:
                                preferred = next(
                                    (
                                        style
                                        for style in reversed(style_references)
                                        if isinstance(style, dict)
                                        and _string_or_none(style.get("id"))
                                    ),
                                    None,
                                )
                            if isinstance(preferred, dict):
                                style_id = _string_or_none(preferred.get("id"))
                                style_entity = cache.get(style_id) if style_id else None
                                image_url = _first_text(
                                    _string_or_none(
                                        style_entity.get("url")
                                        if isinstance(style_entity, dict)
                                        else None
                                    ),
                                    style_id,
                                )
                        if image_url:
                            apollo_images.append(
                                {
                                    "url": image_url,
                                    "title": _first_text(
                                        _string_or_none(referenced.get("title")),
                                        _string_or_none(referenced.get("caption")),
                                    ),
                                    "__jojo_article_scoped": True,
                                }
                            )
            for key, node in _scmp_apollo_walk_items(payload):
                key_text = str(key)
                if not (
                    key_text.startswith("body(")
                    or key_text == "body"
                ):
                    if key == "images" and isinstance(node, list):
                        apollo_images.extend(
                            item
                            for item in node
                            if isinstance(item, dict)
                            and _string_or_none(item.get("url"))
                        )
                    elif re.search(r"\.images\.\d+$", key_text) and isinstance(
                        node, dict
                    ):
                        if _string_or_none(node.get("url")):
                            apollo_images.append(node)
                    continue
                if isinstance(node, dict):
                    body_json = node.get("json")
                    if isinstance(body_json, list):
                        identity = json.dumps(
                            body_json,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        )
                        if (
                            current_article_body_identities
                            and identity not in current_article_body_identities
                        ):
                            continue
                        if identity not in body_array_identities:
                            body_array_identities.add(identity)
                            body_arrays.append(body_json)
    if not body_arrays:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='scmp-apollo-body'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None

    def append_value(parent: Tag, value: Any) -> None:
        if isinstance(value, str):
            parent.append(value)
            return
        if isinstance(value, list):
            for child in value:
                append_value(parent, child)
            return
        if not isinstance(value, dict):
            return
        node_type = _string_or_none(value.get("type"))
        if node_type == "text":
            append_value(parent, value.get("data"))
            return
        if node_type in {"ad", "ad2", "newsletter", "more-on-this"} or (
            node_type and node_type.startswith("outstream")
        ):
            return
        attributes = value.get("attribs")
        attribute_classes = {
            item.casefold()
            for item in str(
                attributes.get("class", "")
                if isinstance(attributes, dict)
                else ""
            ).split()
            if item
        }
        if "scmp-research-healthcare-earlybird" in attribute_classes:
            # The 2020 Apollo article tree injected the same paid SCMP
            # Research early-bird offer into unrelated editorial stories.
            # Its stable wrapper class distinguishes this promotion from
            # genuine healthcare reporting and preserves adjacent prose.
            return
        if node_type == "h3" and any(
            isinstance(child, dict)
            and child.get("type") == "a"
            and "/article/"
            in str(child.get("attribs", {}).get("href", ""))
            for child in value.get("children", [])
        ):
            # Apollo inserts related-story cards as linked h3 nodes directly
            # inside the body array. They are recirculation UI, not article
            # section headings; the surrounding editorial paragraphs remain.
            return
        if node_type in {"image", "img", "photo"}:
            source = _first_text(
                _string_or_none(value.get("url")),
                _string_or_none(value.get("src")),
                _string_or_none(value.get("imageUrl")),
            )
            if source:
                figure = document.new_tag("figure")
                image = document.new_tag("img", src=source)
                figure.append(image)
                caption = _first_text(
                    _string_or_none(value.get("caption")),
                    _string_or_none(value.get("alt")),
                )
                if caption:
                    figcaption = document.new_tag("figcaption")
                    figcaption.string = caption
                    figure.append(figcaption)
                parent.append(figure)
            return
        if node_type == "iframe":
            if not isinstance(attributes, dict):
                attributes = {}
            source = _first_text(
                _string_or_none(attributes.get("src")),
                _string_or_none(attributes.get("data-original")),
                _string_or_none(attributes.get("data-src")),
            )
            normalized = (
                _normalized_url(source, base_url="https://www.scmp.com/")
                if source
                else None
            )
            hostname = (urlsplit(normalized or "").hostname or "").casefold()
            if normalized and (
                hostname == "scmp.com" or hostname.endswith(".scmp.com")
            ):
                iframe = document.new_tag("iframe", src=normalized)
                iframe["title"] = "SCMP interactive content"
                iframe["data-interactive-provider"] = "scmp-apollo"
                parent.append(iframe)
            return
        tag_name = {
            "paragraph": "p",
            "heading": "h2",
            "quote": "blockquote",
            "list": "ul",
            "list-item": "li",
        }.get(node_type or "", node_type or "")
        if tag_name not in {"p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "tr", "td", "th"}:
            tag_name = "span"
        element = document.new_tag(tag_name)
        append_value(element, value.get("children", value.get("content")))
        if element.get_text(" ", strip=True) or element.find(["img", "iframe"]):
            parent.append(element)

    for body_json in body_arrays:
        for node in body_json:
            append_value(article, node)
    # SCMP's Apollo body tree often omits inline photos even though the
    # article object retains them in its direct ``images`` list.  The cache
    # also contains queue/more-on-this images; those are not part of the
    # article and were previously appended as body media.  When Apollo gives
    # us normalized ``content(...).images`` references, keep only those
    # article-scoped images.  Older fixtures expose an unscoped list, for
    # which retaining everything after the cover preserves the legacy path.
    scoped_article_images = [
        item for item in apollo_images
        if _scmp_apollo_article_image(item)
    ]
    selected_images = (
        scoped_article_images
        if scoped_article_images
        # A canonical, URL-matched article body proves that the surrounding
        # normalized Apollo cache belongs to the modern application shell.
        # Its unscoped image nodes include topic/reverse-section artwork and
        # must not be appended as article media. Older captures without a
        # URL-bound body retain the legacy cover-plus-inline fallback below.
        else []
        if current_article_body_identities
        else apollo_images[1:]
    )
    seen_images: set[str] = set()
    for item in selected_images:
        source = _string_or_none(item.get("url"))
        if not source:
            continue
        identity = _image_identity(source)
        if identity in seen_images:
            continue
        seen_images.add(identity)
        figure = document.new_tag("figure")
        figure.append(document.new_tag("img", src=source))
        title = _string_or_none(item.get("title"))
        caption = (
            _clean_text(BeautifulSoup(title, "html.parser").get_text(" ", strip=True))
            if title
            else None
        )
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        article.append(figure)
    return (
        article
        if article.get_text(" ", strip=True)
        or article.find(["img", "iframe"])
        else None
    )


def _scmp_apollo_article_image(item: dict[str, Any]) -> bool:
    """Identify images referenced by the current Apollo article object."""

    if item.get("__jojo_article_scoped") is True:
        return True
    pending: list[Any] = [item]
    has_article_reference = False
    has_related_reference = False
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            for key, child in value.items():
                for text in (
                    key if isinstance(key, str) else "",
                    child if isinstance(child, str) else "",
                ):
                    if ".content(" in text:
                        has_article_reference = True
                    if ".moreOnThisArticles" in text:
                        has_related_reference = True
                if isinstance(child, (dict, list)):
                    pending.append(child)
        elif isinstance(value, list):
            pending.extend(value)
    return has_article_reference and not has_related_reference


def _scmp_apollo_walk_items(value: Any) -> Iterable[tuple[Any, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from _scmp_apollo_walk_items(child)
    elif isinstance(value, list):
        for child in value:
            yield from _scmp_apollo_walk_items(child)


def _promote_scmp_image_candidates(candidates: list[str]) -> list[str]:
    """Put the least transformed SCMP rendition first for archival fetches."""

    order = {candidate: index for index, candidate in enumerate(candidates)}

    def score(candidate: str) -> tuple[int, int]:
        path = unquote(urlsplit(candidate).path).casefold()
        unstyled = bool(
            "/sites/default/files/" in path
            and "/sites/default/files/styles/" not in path
            and "/cdn-cgi/image/" not in path
        )
        hires = "_image_hires." in path or "_image_hires_" in path
        dimensions = re.search(r"_(\d{2,5})x(\d{2,5})(?:_|\.)", path)
        largest_dimension = (
            max(int(dimensions.group(1)), int(dimensions.group(2)))
            if dimensions is not None
            else 0
        )
        return (
            (10_000 if unstyled else 0)
            + (5_000 if hires else 0)
            + min(largest_dimension, 4_000),
            -order[candidate],
        )

    return sorted(dict.fromkeys(candidates), key=score, reverse=True)


def _restore_scmp_lazy_body_images(soup: BeautifulSoup) -> None:
    """Materialize publisher-marked SCMP images left as SVG placeholders."""

    for container in soup.select("[itemprop]"):
        itemprops = {
            value.casefold()
            for value in str(container.get("itemprop") or "").split()
        }
        if "associatedmedia" not in itemprops:
            continue
        existing_image = container.select_one("img[src]")
        if isinstance(existing_image, Tag):
            # Young Post visual stories sometimes put the only editorial
            # payload inside a paragraph. Mark the already materialized image
            # as publisher-owned body media so block extraction can retain it
            # alongside the paragraph's short credit.
            existing_image["data-jojo-scmp-associated-media"] = "true"
            continue
        source_meta = container.select_one("meta[itemprop='url'][content]")
        if not isinstance(source_meta, Tag):
            continue
        source = _normalized_url(
            source_meta.get("content"),
            base_url="https://www.scmp.com/",
        )
        hostname = (urlsplit(source or "").hostname or "").casefold()
        if not source or not (
            hostname == "i-scmp.com" or hostname.endswith(".i-scmp.com")
        ):
            continue
        image = soup.new_tag("img", src=source)
        image["data-jojo-scmp-associated-media"] = "true"
        for dimension in ("width", "height"):
            value = container.select_one(
                f"meta[itemprop='{dimension}'][content]"
            )
            if isinstance(value, Tag) and str(value.get("content") or "").isdigit():
                image[dimension] = str(value["content"])
        placeholder = container.select_one("svg")
        if isinstance(placeholder, Tag):
            placeholder.replace_with(image)
        else:
            container.append(image)


def _remove_scmp_body_chrome(soup: BeautifulSoup) -> None:
    """Remove recurring SCMP site chrome from recovered article bodies."""

    # SCMP's 2023 React template places follow/share/comment/bookmark controls
    # inside the same broad content node as the story. They are dead in a
    # static archive and caused hundreds of otherwise complete articles to
    # retain button/SVG chrome in normalized body HTML.
    for widget in list(
        soup.select(
            "[data-qa='FollowTooltip-ChildrenContainer'], "
            "[data-qa='ContentShareWidget-Container'], "
            "[data-qa='ArticleActionWidget-Container'], "
            "[data-qa='TextToSpeechPlayer-Container']"
        )
    ):
        widget.decompose()
    # Unknown template revisions may omit the stable wrapper while retaining
    # form controls.  SCMP article prose is never authored as a button or an
    # input/select/textarea, so remove those dead controls rather than
    # serializing them as editorial HTML.  Keep surrounding labels because
    # their text can describe a chart or poll option in an infographic.
    for control in list(soup.select("button, input, select, textarea")):
        control.decompose()

    # Archived Young Post Apollo bodies can append a recommendation package
    # directly to the editorial block list.  Unlike a separately wrapped
    # related-story card, this package is serialized as an ordinary heading
    # followed by linked paragraphs, so selector-only chrome removal cannot
    # distinguish it.  The exact heading is the stable boundary: retain the
    # editor credit immediately above it, but drop the marker and every later
    # sibling from the same body container.
    for marker in list(soup.select("h1, h2, h3, h4, h5, h6, p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True))
        if marker_text.rstrip(":").casefold() != "you might also like":
            continue
        boundary: Any = marker
        # Styled-components wraps each semantic marker in its own generated
        # ``div``.  Climb through wrappers that contain only the marker text,
        # otherwise deleting siblings of the nested ``h2`` would merely leave
        # the following recommendation paragraphs untouched.
        while isinstance(boundary.parent, Tag) and (
            _clean_text(boundary.parent.get_text(" ", strip=True))
            == marker_text
        ):
            boundary = boundary.parent
        previous = boundary.previous_sibling
        while isinstance(previous, NavigableString) and not str(previous).strip():
            earlier = previous.previous_sibling
            previous.extract()
            previous = earlier
        if isinstance(previous, Tag) and (
            previous.name == "hr"
            or str(previous.get("type") or "").casefold() == "hr"
        ):
            previous.extract()
        sibling: Any = boundary
        while sibling is not None:
            next_sibling = sibling.next_sibling
            sibling.extract()
            sibling = next_sibling

    # The Apollo ``articleBody`` for Letter to the Editor pages prepends a
    # site-wide invitation to submit letters.  It is JSON-LD/Apollo chrome,
    # not part of the recovered letter, and repeats across many unrelated
    # captures.  Match the stable contact/submission wording rather than a
    # broad ``letter`` selector so ordinary editorial prose is preserved.
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True)).casefold()
        # SCMP's inline related-story cards sometimes collapse to a bare
        # ``<p><span>Read more</span></p>`` in archived Apollo payloads.
        # It is navigation chrome, while a real editorial paragraph is never
        # the two-word label by itself.
        if text.rstrip(":") == "read more":
            paragraph.decompose()
            continue
        if (
            text.startswith("feel strongly about these letters")
            and "letters@scmp.com" in text
            and "submissions should not exceed" in text
        ):
            paragraph.decompose()
            continue

        # Older SCMP JSON-LD/Apollo captures flatten promotional cards into
        # ordinary ``p`` nodes.  These cards are especially common in the
        # 2019--2020 business and technology corpus, where they can recur in
        # hundreds of otherwise unrelated articles.  Require the stable
        # campaign wording so that ordinary reporting that mentions a report,
        # survey, or social network is retained.
        is_china_ai_promo = (
            "china ai report" in text
            and (
                "scmp research" in text
                or text.startswith("purchase the china ai report")
                or text.startswith("sign up now and get")
            )
        )
        is_china_tech_promo = (
            text.startswith("for more insights into china tech")
            and ("china internet report" in text or "abacus" in text)
        )
        is_china_internet_report_promo = (
            "china internet report 2020 pro edition" in text
            and (
                text.startswith("sign up now for a 50% early bird discount")
                or text.startswith("purchase the ")
            )
            and (
                "offer valid until" in text
                or "original price us$400" in text
                or "to purchase" in text
            )
        )
        is_scmp_survey_cta = (
            text.startswith("help us understand what you are interested in")
            and "five-minute survey" in text
        )
        is_social_cta = text.startswith(
            (
                "want more articles like this? follow scmp film",
                "want more stories like this? sign up here",
                "connect with us on twitter and facebook",
            )
        )
        is_lifestyle_social_cta = (
            text.startswith(
                "like what you read? follow scmp lifestyle on facebook"
            )
            and "twitter" in text
            and "instagram" in text
            and "sign up for our enewsletter here" in text
        )
        is_presented_copyright = re.fullmatch(
            r"all rights reserved\.?\s*copyright\s+(?:19|20)\d{2}\.?",
            text,
        )
        if (
            is_china_ai_promo
            or is_china_tech_promo
            or is_china_internet_report_promo
            or is_scmp_survey_cta
            or is_social_cta
            or is_lifestyle_social_cta
            or is_presented_copyright
        ):
            paragraph.decompose()


def _scmp_legacy_gallery_body(soup: BeautifulSoup) -> Tag | None:
    """Recover SCMP's Drupal-era inline gallery and short introduction."""

    slides = soup.select(
        ".pane-node-field-images .scmp_gallery "
        ".gallery-slide a[href]"
    )
    if len(slides) < 2:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='scmp-legacy-gallery'></article>",
        "html.parser",
    )
    wrapper = document.select_one("article")
    if not isinstance(wrapper, Tag):
        return None
    for slide in slides:
        image = slide.select_one("img")
        source = _string_or_none(slide.get("href"))
        if not isinstance(image, Tag) or not source:
            continue
        figure = document.new_tag("figure")
        copied_image = document.new_tag("img")
        copied_image["src"] = source
        alt = _string_or_none(image.get("alt"))
        if alt:
            copied_image["alt"] = alt
        figure.append(copied_image)
        caption = _string_or_none(slide.get("title"))
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        wrapper.append(figure)
    body = soup.select_one(".field-name-body")
    if isinstance(body, Tag):
        fragment = BeautifulSoup(str(body), "html.parser")
        copied_body = fragment.select_one(".field-name-body")
        if isinstance(copied_body, Tag):
            for child in list(copied_body.contents):
                wrapper.append(child)
    return wrapper if len(wrapper.select("figure img")) >= 2 else None


def _scmp_non_editorial_image_url(url: str) -> bool:
    """Recognize SCMP sharing, loading and author chrome, not story media."""
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    return (
        (
            host == "i-scmp.com" or host.endswith(".i-scmp.com")
        )
        and "/images/author/" in path
    ) or (
        host in {
            "cdn1.i-scmp.com",
            "cdn.i-scmp.com",
            "m.scmp.com",
            "www.scmp.com",
        }
        and bool(
            re.search(
                r"/(?:bookmark-icon|share-icon|print-icon)(?:[-_][^/]*)?\."
                r"(?:gif|jpe?g|png|webp)$",
                path,
                flags=re.IGNORECASE,
            )
        )
    ) or (
        host == "assets-v2.i-scmp.com"
        and re.search(
            r"/production/_next/static/media/(?:wheel-on-gray|"
            r"mascot-(?:desktop|mobile)|top-background|img-pippa)\."
            r"[a-f0-9]+\.(?:gif|jpe?g|png|webp)$",
            path,
            flags=re.IGNORECASE,
        )
        is not None
    ) or (
        host == "img.i-scmp.com"
        and "/sites/default/files/styles/118x118/public/" in path
    )


def _scmp_live_article(soup: BeautifulSoup) -> bool:
    """Recognize SCMP's legacy live packages from explicit page metadata."""
    article_type = _meta_content(soup, "name", "cse_articletype")
    if article_type and article_type.casefold().strip() in {
        "live",
        "liveblog",
        "live blog",
    }:
        return True
    for iframe in soup.find_all("iframe"):
        source = _first_text(
            _string_or_none(iframe.get("src")),
            _string_or_none(iframe.get("data-original")),
            _string_or_none(iframe.get("data-src")),
        )
        if source and "embed.scribblelive.com/" in source.casefold():
            return True
    return bool(
        soup.select_one(
            "[class*='live-article__body'], "
            "[class*='live-blog__body']"
        )
    )


def _scmp_multimedia_text_body(
    soup: BeautifulSoup,
    *,
    multimedia_url: str | None,
) -> Tag | None:
    """Recover prose-rich SCMP multimedia documents selected by Wayback."""
    if (
        not multimedia_url
        or (urlsplit(multimedia_url).hostname or "").casefold()
        != "multimedia.scmp.com"
    ):
        return None

    page_class = _clean_text(
        _meta_content(soup, "name", "cXenseParse:pageclass") or ""
    ).casefold()
    studio_body = soup.select_one("#msapp main#content")
    sources: tuple[Tag, ...] = ()
    if (
        page_class == "multimedia"
        and isinstance(studio_body, Tag)
        and len(studio_body.select("p")) >= 5
        and len(_clean_text(studio_body.get_text(" ", strip=True))) >= 1000
    ):
        sources = (studio_body,)
    else:
        standard_body = soup.select_one("body > section.standar")
        if (
            isinstance(standard_body, Tag)
            and len(standard_body.select("p")) >= 5
            and len(_clean_text(standard_body.get_text(" ", strip=True)))
            >= 1000
        ):
            intro = soup.select_one("body > section.intro")
            sources = (
                (intro, standard_body)
                if isinstance(intro, Tag)
                else (standard_body,)
            )
    if not sources:
        return None

    fragment = BeautifulSoup(
        "<article data-jojo-source='scmp-multimedia-text'></article>",
        "html.parser",
    )
    article = fragment.select_one("article")
    if not isinstance(article, Tag):
        return None
    for source in sources:
        for child in list(source.children):
            article.append(copy.copy(child))

    # The Morning Studio template nests ad placeholders and hover-only author
    # cards inside ``main``. They are page chrome, not editorial media.
    for node in list(article.select(".zj-banner, .creater-popup, #IE_hack")):
        node.decompose()

    for image in list(article.select("img")):
        source = _first_text(
            _tag_attribute(image, "src"),
            _tag_attribute(image, "data-src"),
            _tag_attribute(image, "data-original"),
        )
        normalized = (
            _normalized_url(source, base_url=multimedia_url)
            if source
            else None
        )
        if not normalized:
            continue
        path = unquote(urlsplit(normalized).path).casefold()
        if re.search(
            r"/images/(?:banner_[^/]+|ico_touch)\.(?:gif|jpe?g|png|webp)$",
            path,
        ):
            image.decompose()
            continue
        image["src"] = normalized
        image.attrs.pop("data-src", None)
        image.attrs.pop("data-original", None)

    # Legacy SCMP Graphics documents render their static charts with
    # ``<object data='...svg'>``. Convert those publisher-owned SVGs to images
    # so the normal block/image pipeline can retain them in reading order.
    for embedded in list(article.select("object[data]")):
        source = _normalized_url(
            _tag_attribute(embedded, "data"),
            base_url=multimedia_url,
        )
        if not source or not urlsplit(source).path.casefold().endswith(".svg"):
            continue
        image = fragment.new_tag("img", src=source)
        image["alt"] = _tag_attribute(embedded, "aria-label") or (
            "SCMP infographic"
        )
        embedded.replace_with(image)
    return article


def _scmp_standalone_infographic_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Return the editorial payload of SCMP's standalone graphic template."""
    multimedia_url = next(
        (
            normalized
            for value in (
                _meta_content(soup, "property", "og:url"),
                _tag_attribute(
                    soup.select_one("link[rel~='canonical']"),
                    "href",
                ),
            )
            if (
                (normalized := _normalized_url(value, base_url=canonical_url))
                and (urlsplit(normalized).hostname or "").casefold()
                == "multimedia.scmp.com"
            )
        ),
        None,
    )
    multimedia_host = (
        urlsplit(multimedia_url or "").hostname or ""
    ).casefold()
    page_class = _meta_content(soup, "name", "cXenseParse:pageclass")
    legacy_app_shell = bool(
        page_class
        and page_class.casefold().strip() == "multimedia"
        and soup.select_one("html[ng-app], body[ng-controller]")
        and soup.select_one(".container")
    )
    multimedia_path = unquote(
        urlsplit(multimedia_url or "").path
    ).casefold()
    report_body = soup.select_one("main#main")
    static_report_shell = bool(
        multimedia_path.startswith("/infographics/")
        and isinstance(report_body, Tag)
        and len(report_body.select(":scope > section")) >= 2
        and len(report_body.select("p")) >= 2
        and len(_clean_text(report_body.get_text(" ", strip=True))) >= 1000
    )
    if (
        multimedia_url
        and multimedia_host == "multimedia.scmp.com"
        and (
            soup.select_one(
                "#slider.frame-container, .frames.swiper-wrapper"
            )
            or legacy_app_shell
            or static_report_shell
        )
    ):
        # Wayback can select the publisher's complete standalone multimedia
        # document as the best representation of a regular ``/news/`` URL.
        # Legacy Angular polling packages and static report landing pages use
        # different shells. Their chart values, report download and other
        # interactions live outside the prose DOM, so flattening the page
        # would discard the actual experience. Preserve the publisher
        # document itself as an interactive embed. Both the SCMP-owned host
        # and a stable template marker are required; an arbitrary Open Graph
        # URL is never enough.
        fragment = BeautifulSoup(
            "<article data-jojo-source='scmp-multimedia-document'></article>",
            "html.parser",
        )
        article = fragment.select_one("article")
        if isinstance(article, Tag):
            iframe = fragment.new_tag("iframe", src=multimedia_url)
            iframe["title"] = (
                _meta_content(soup, "property", "og:title")
                or "SCMP interactive feature"
            )
            iframe["data-interactive-provider"] = "scmp-multimedia"
            article.append(iframe)
            return article

    multimedia_text = _scmp_multimedia_text_body(
        soup,
        multimedia_url=multimedia_url,
    )
    if multimedia_text is not None:
        return multimedia_text

    if "/infographics/" not in canonical_url.casefold():
        return None

    # The older Drupal infographic template keeps the actual graphic in a
    # dedicated multimedia field. Lazy loading moves its URL from ``src`` to
    # ``data-original``; generic body selection therefore sees an empty
    # article. Rehydrate only that editorial iframe, without admitting the
    # recommendation or advertising embeds elsewhere in the page.
    legacy_iframe = soup.select_one(
        ".pane-node-field-mutlimedia-embed .pane-content iframe"
    )
    if isinstance(legacy_iframe, Tag):
        source = _first_text(
            _string_or_none(legacy_iframe.get("src")),
            _string_or_none(legacy_iframe.get("data-original")),
            _string_or_none(legacy_iframe.get("data-src")),
        )
        normalized = (
            _normalized_url(source, base_url=canonical_url)
            if source
            else None
        )
        if normalized and re.search(
            r"(?i)^https?://(?:[^/]+\.)?scmp\.com/",
            normalized,
        ):
            fragment = BeautifulSoup(
                "<article data-jojo-source='scmp-legacy-infographic'></article>",
                "html.parser",
            )
            article = fragment.select_one("article")
            if isinstance(article, Tag):
                iframe = fragment.new_tag("iframe", src=normalized)
                iframe["title"] = "SCMP interactive infographic"
                iframe["data-interactive-provider"] = "scmp-multimedia"
                article.append(iframe)
                return article

    # A second Drupal template stores a complete tall infographic in the
    # node's editorial image field and lazy-loads it from ``data-original``.
    # Copy only this field (not arbitrary page images) and materialize ``src``
    # so the normal image/block pipeline can archive the actual graphic.
    legacy_image = soup.select_one(
        ".pane-node-field-images .pane-content img[data-original]"
    )
    if isinstance(legacy_image, Tag):
        source = _normalized_url(
            legacy_image.get("data-original"),
            base_url=canonical_url,
        )
        hostname = (urlsplit(source or "").hostname or "").casefold()
        if source and (
            hostname == "i-scmp.com" or hostname.endswith(".i-scmp.com")
        ):
            fragment = BeautifulSoup(
                "<article data-jojo-source='scmp-legacy-infographic-image'></article>",
                "html.parser",
            )
            article = fragment.select_one("article")
            if isinstance(article, Tag):
                figure = fragment.new_tag("figure")
                image = fragment.new_tag("img", src=source)
                image["alt"] = (
                    _tag_attribute(legacy_image, "alt")
                    or "SCMP infographic"
                )
                figure.append(image)
                article.append(figure)
                return article

    # Vue-era standalone infographic pages can render only a short
    # "tap here" handoff in the DOM.  The Apollo cache still preserves the
    # publisher-owned multimedia URL, so materialize that URL as the actual
    # editorial payload.  Restrict both the script source and destination
    # path: unrelated links elsewhere in Apollo must never become the body.
    for script in soup.find_all("script"):
        value = (script.string or script.get_text()).replace("\\/", "/")
        if "__APOLLO_STATE__" not in value:
            continue
        match = re.search(
            r"https?://multimedia\.scmp\.com/infographics/[^\"'<>\s]+",
            value,
            flags=re.IGNORECASE,
        )
        if not match:
            continue
        source = _normalized_url(match.group(0), base_url=canonical_url)
        if source:
            fragment = BeautifulSoup(
                "<article data-jojo-source='scmp-apollo-infographic'></article>",
                "html.parser",
            )
            article = fragment.select_one("article")
            if isinstance(article, Tag):
                iframe = fragment.new_tag("iframe", src=source)
                iframe["title"] = "SCMP interactive infographic"
                iframe["data-interactive-provider"] = "scmp-multimedia"
                article.append(iframe)
                return article

    # Some retired interactives no longer expose their separate multimedia
    # endpoint, while SCMP's metadata still retains the publisher-hosted
    # graphic itself. Preserve that best available editorial payload instead
    # of accepting an empty article shell. This is deliberately limited to
    # the standalone Infographics section and SCMP's image CDN.
    section = _first_text(
        _meta_content(soup, "name", "cse_sectionname"),
        _meta_content(soup, "property", "article:section"),
    )
    main_image = _normalized_url(
        _first_text(
            _meta_content(soup, "name", "cse_mainimage"),
            _meta_content(soup, "property", "og:image"),
        ),
        base_url=canonical_url,
    )
    image_hostname = (urlsplit(main_image or "").hostname or "").casefold()
    if (
        section
        and section.casefold().strip() == "infographics"
        and main_image
        and (image_hostname == "i-scmp.com" or image_hostname.endswith(".i-scmp.com"))
    ):
        fragment = BeautifulSoup(
            "<article data-jojo-source='scmp-apollo-infographic-image'></article>",
            "html.parser",
        )
        article = fragment.select_one("article")
        if isinstance(article, Tag):
            figure = fragment.new_tag("figure")
            image = fragment.new_tag("img", src=main_image)
            image["alt"] = (
                _meta_content(soup, "name", "cse_headline")
                or "SCMP infographic"
            )
            figure.append(image)
            article.append(figure)
            return article

    body = soup.select_one("body > section.standar")
    if isinstance(body, Tag) and body.select_one("img"):
        return body
    return None


def _scmp_newsletter_iframe_body(soup: BeautifulSoup) -> Tag | None:
    """Recover the externally rendered body of SCMP newsletter articles."""
    article_type = _meta_content(soup, "name", "cse_articletype")
    if not article_type or article_type.casefold().strip() != "newsletter":
        return None
    source_iframe = soup.select_one(".nl-article__iframe iframe[src]")
    source = (
        _normalized_url(
            source_iframe.get("src"),
            base_url="https://www.scmp.com/",
        )
        if isinstance(source_iframe, Tag)
        else None
    )
    if source is None:
        # Some Vue captures render only the newsletter loading skeleton. The
        # same article's Apollo ``relatedLinks`` field still retains the
        # publisher-owned iframe endpoint, so recover that exact archive URL
        # instead of treating the shell as an empty article.
        for script in soup.find_all("script"):
            value = (script.string or script.get_text()).replace("\\/", "/")
            if "__APOLLO_STATE__" not in value:
                continue
            match = re.search(
                r"https://widgets\.scmp\.com/newsletters/archive/"
                r"[^\"'<>\s]+",
                value,
                flags=re.IGNORECASE,
            )
            if match:
                source = _normalized_url(
                    match.group(0),
                    base_url="https://www.scmp.com/",
                )
                break
    if not source or not re.match(
        r"(?i)^https://widgets\.scmp\.com/newsletters/archive/",
        source,
    ):
        return None
    fragment = BeautifulSoup(
        "<article data-jojo-source='scmp-newsletter-iframe'></article>",
        "html.parser",
    )
    article = fragment.select_one("article")
    if not isinstance(article, Tag):
        return None
    iframe = fragment.new_tag("iframe", src=source)
    iframe["title"] = "SCMP newsletter body"
    iframe["data-interactive-provider"] = "scmp-newsletter"
    article.append(iframe)
    return article


def _scmp_image_led_graphic(
    *,
    canonical_url: str,
    headline: str | None,
    description: str | None,
    blocks: list[ContentBlock],
    image_count: int = 0,
) -> bool:
    """Recognize a preserved SCMP graphic whose image is the whole body.

    Legacy SCMP graphic articles can contain no prose at all: the editorial
    payload is a single linked image inside ``.article-body``. Treat only a
    clearly named, image-bearing short body as a gallery so an ordinary
    article with a missing body cannot be promoted merely because it has a
    metadata/lead image.
    """

    marker_text = " ".join(
        value
        for value in (
            canonical_url,
            headline,
            description,
            *(
                block.text or block.caption or block.credit
                for block in blocks
            ),
        )
        if value
    )
    competition_entry = bool(
        "/yp/discover/your-voice/competitions/article/"
        in canonical_url.casefold()
        and re.search(r"(?i)\bcompetition entry\b", marker_text)
    )
    restored_body_image = any(
        block.type == BlockType.IMAGE
        and block.html
        and "data-jojo-scmp-associated-media" in block.html
        for block in blocks
    )
    young_post_visual = bool(
        "/yp/" in canonical_url.casefold()
        and restored_body_image
        and re.search(
            r"(?i)\b(?:throwback edition|top stories of the week)\b",
            marker_text,
        )
    )
    young_post_image_sequence = bool(
        "/yp/" in canonical_url.casefold()
        and sum(block.type == BlockType.IMAGE for block in blocks) >= 8
    )
    named_visual = bool(
        re.search(r"(?i)\b(?:info)?graphic\b", marker_text)
        or "/english-exercises/" in canonical_url.casefold()
        or competition_entry
        or young_post_visual
        or young_post_image_sequence
    )
    if not named_visual:
        return False
    has_image_block = any(block.type == BlockType.IMAGE for block in blocks)
    if not has_image_block and not (
        competition_entry and image_count >= 1
    ):
        return False
    body_characters = sum(
        len(value)
        for block in blocks
        if (value := _block_plain_text(block))
    )
    return body_characters < _MINIMUM_BODY_CHARACTERS


def _scmp_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Read SCMP's pre-JSON-LD human-readable article timestamp."""
    value = _tag_text(
        soup.select_one(".pane-node-created .pane-content, .pane-node-created")
    )
    if not value:
        return None
    match = re.search(
        r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]+),?\s+"
        r"(?P<year>20\d{2}),?\s+"
        r"(?P<time>\d{1,2}:\d{2}\s*[ap]m)",
        value,
        flags=re.IGNORECASE,
    )
    if match is None:
        return None
    normalized = (
        f"{match.group('day')} {match.group('month')} "
        f"{match.group('year')} {match.group('time').replace(' ', '')}"
    )
    for format_string in ("%d %B %Y %I:%M%p", "%d %b %Y %I:%M%p"):
        try:
            parsed = datetime.strptime(normalized, format_string)
        except ValueError:
            continue
        return parsed.replace(
            tzinfo=timezone(timedelta(hours=8))
        ).isoformat()
    return None


def _scmp_embedded_published_at(soup: BeautifulSoup) -> str | None:
    """Read SCMP's millisecond timestamp from archived React/Apollo state."""

    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r'''["']publishedDate["']\s*:\s*(?P<millis>1[0-9]{12})''',
            value,
        )
        if match is None:
            continue
        try:
            return datetime.fromtimestamp(
                int(match.group("millis")) / 1_000,
                tz=timezone.utc,
            ).isoformat()
        except (OverflowError, OSError, ValueError):
            continue
    return None


def _scmp_yp_audio_handoff_url(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> str | None:
    """Recover the external player used by terse Young Post audio lessons."""

    if "/yp/learn/learning-resources/listening-scripts/article/" not in (
        canonical_url.casefold()
    ):
        return None
    for paragraph in soup.select("p"):
        text = _clean_text(paragraph.get_text(" ", strip=True)).casefold()
        if not text.startswith("for the video to the listening exercise"):
            continue
        for link in paragraph.select("a[href]"):
            source = _normalized_url(link.get("href"), base_url=canonical_url)
            host = (urlsplit(source or "").hostname or "").casefold()
            if host in {"youtube.com", "www.youtube.com", "youtu.be"}:
                return source
    return None


from jojo_news_archive.parsing.parser_contracts import BaseSourceParser, ParseContext


class ScmpParser(BaseSourceParser):
    def preprocess(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.structured import (
            find_video_object_json as _find_video_object_json,
        )

        context.source_data["video"] = _find_video_object_json(context.soup)

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )

        body = _select_body(context.soup, context.spec)
        newsletter = _scmp_newsletter_iframe_body(context.soup)
        if newsletter is not None:
            body = newsletter
        gallery = _scmp_legacy_gallery_body(context.soup)
        if gallery is not None and newsletter is None:
            body = gallery
            context.structured_image_gallery_selected = True
            context.source_data["legacy_gallery_selected"] = True
        standalone = _scmp_standalone_infographic_body(
            context.soup,
            canonical_url=context.canonical_url,
        )
        if standalone is not None and (
            body is None
            or (
                standalone.select_one("iframe[src]") is not None
                and body.select_one("iframe[src]") is None
            )
            or (
                standalone.select_one("figure img[src]") is not None
                and body.select_one("img[src]") is None
            )
            or len(standalone.get_text(" ", strip=True))
            > len(body.get_text(" ", strip=True))
        ):
            body = standalone
        apollo = _scmp_apollo_body(context.soup)
        if apollo is not None and (
            body is None
            or (
                apollo.select_one("iframe[src]") is not None
                and body.select_one("iframe[src]") is None
            )
            or (
                body.select_one("iframe[src]") is None
                and len(apollo.get_text(" ", strip=True))
                > len(body.get_text(" ", strip=True))
            )
        ):
            body = apollo
        context.body = _select_default_body(context, initial_body=body)

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _restore_scmp_lazy_body_images(context.clean_body)
        _remove_scmp_body_chrome(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return len(text) >= 2 and set(text) == {"_"}

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            first_text as _first_text,
            parse_datetime as _parse_datetime,
            string_or_none as _string_or_none,
            tag_text as _tag_text,
        )

        article_headline = _string_or_none(context.news_article.get("headline"))
        context.headline = _first_text(
            article_headline,
            _tag_text(context.soup.select_one("h1#page-title.title")),
            _tag_text(
                context.soup.select_one(
                    ".view-mode-level_masthead "
                    "h2.node-title[property='dc:title']"
                )
            ),
            context.headline,
        )
        if not context.authors:
            byline = _tag_text(
                context.soup.select_one(".field-name-field-byline")
            )
            if byline:
                byline = re.sub(
                    r"(?i)\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b",
                    "",
                    byline,
                )
                byline = _clean_text(byline).strip(" ,;|")
                if byline:
                    context.authors = [Author(name=byline)]
        video = context.source_data.get("video")
        video = video if isinstance(video, dict) else {}
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _first_text(
                    _string_or_none(video.get("datePublished")),
                    _string_or_none(video.get("uploadDate")),
                    _string_or_none(video.get("dateCreated")),
                    _scmp_embedded_published_at(context.soup),
                    _scmp_legacy_published_at(context.soup),
                )
            )
        video_modified = _parse_datetime(
            _string_or_none(video.get("dateModified"))
        )
        if context.modified_at is None and video_modified is not None:
            context.modified_at = video_modified
        context.source_data["audio_url"] = _scmp_yp_audio_handoff_url(
            context.soup,
            canonical_url=context.canonical_url,
        )

    def classify_content(self, context: ParseContext) -> None:
        if _scmp_live_article(context.soup):
            context.content_type = ContentType.LIVEBLOG
        elif _scmp_newsletter_iframe_body(context.soup) is not None:
            context.content_type = ContentType.NEWSLETTER
        elif _scmp_standalone_infographic_body(
            context.soup,
            canonical_url=context.canonical_url,
        ) is not None:
            context.content_type = ContentType.INTERACTIVE
        elif (
            isinstance(context.body, Tag)
            and context.body.select_one(
                "iframe[data-interactive-provider='scmp-apollo']"
            )
            is not None
            and len(context.body.get_text(" ", strip=True)) < 500
        ):
            context.content_type = ContentType.INTERACTIVE
        elif context.source_data.get("audio_url"):
            context.content_type = ContentType.AUDIO

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        return not (
            context.source_data.get("legacy_gallery_selected")
            or _scmp_non_editorial_image_url(url)
        )

    def image_identity(self, url: str) -> str | None:
        return _scmp_source_image_identity(url)

    def accept_body_image(
        self,
        context: ParseContext,
        image: ImageCandidate,
    ) -> bool:
        return not _scmp_non_editorial_image_url(image.original_url)

    def retain_nested_block(self, context: ParseContext, node: Tag) -> bool:
        return bool(
            node.name == "img"
            and node.get("data-jojo-scmp-associated-media") == "true"
            and isinstance(node.find_parent("p"), Tag)
            and node.find_parent("figure") is None
        )

    def postprocess_blocks(self, context: ParseContext) -> None:
        audio_url = context.source_data.get("audio_url")
        if not isinstance(audio_url, str) or not audio_url:
            return
        if any(
            block.type == BlockType.EMBED and block.embed_url == audio_url
            for block in context.blocks
        ):
            return
        context.blocks.append(
            ContentBlock(
                type=BlockType.EMBED,
                position=max(
                    (block.position for block in context.blocks),
                    default=-1,
                )
                + 1,
                embed_url=audio_url,
            )
        )

    def postprocess_output(self, context: ParseContext) -> None:
        for image in context.images:
            promoted = _promote_scmp_image_candidates(image.candidate_urls)
            if promoted:
                image.original_url = promoted[0]
                image.candidate_urls = promoted
        if (
            context.content_type == ContentType.ARTICLE
            and _scmp_image_led_graphic(
                canonical_url=context.canonical_url,
                headline=context.headline,
                description=context.description,
                blocks=context.blocks,
                image_count=len(context.images),
            )
        ):
            context.content_type = ContentType.GALLERY

    def accepts_short_body(self, context: ParseContext) -> bool:
        image_led = bool(
            context.content_type == ContentType.GALLERY
            and any(image.should_archive for image in context.images)
            and _scmp_image_led_graphic(
                canonical_url=context.canonical_url,
                headline=context.headline,
                description=context.description,
                blocks=context.blocks,
                image_count=len(context.images),
            )
        )
        return bool(
            super().accepts_short_body(context)
            or image_led
            or (
                context.content_type == ContentType.LIVEBLOG
                and _scmp_live_article(context.soup)
            )
            or self._structured_short_record(context)
        )

    def short_body_warning(self, context: ParseContext) -> str | None:
        return (
            "structured-short-record"
            if self._structured_short_record(context)
            else None
        )

    @staticmethod
    def _structured_short_record(context: ParseContext) -> bool:
        body = context.soup.select_one(".field-name-body")
        legacy_text = (
            _clean_text(body.get_text(" ", strip=True))
            if isinstance(body, Tag)
            else ""
        )
        plain_text = context.plain_text
        return bool(
            context.headline
            and 40 <= len(plain_text) < 100
            and plain_text == legacy_text
            and context.soup.select_one("h1#page-title.title") is not None
            and re.match(
                r"^[A-Z][A-Za-z .,'-]+\s+\(AP\)\s+[—-]",
                plain_text,
            )
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )


PARSER: ScmpParser = ScmpParser()
