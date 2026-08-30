from __future__ import annotations

import ast
import copy
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
import hashlib
import html as html_module
import json
import re
from typing import Any, Iterable
from urllib.parse import (
    parse_qsl,
    urlencode,
    unquote,
    urljoin,
    urlsplit,
    urlunsplit,
)

from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from dateutil.parser import isoparse

from .news_models import (
    ARCHIVABLE_IMAGE_ROLES,
    ArticleStatus,
    Author,
    BlockType,
    CaptureProvider,
    CaptureReference,
    ContentBlock,
    ContentType,
    Extraction,
    ImageCandidate,
    ImageRole,
    JojoArticle,
    Quality,
    RawCapture,
)
from .publisher_specs import COMMON_REMOVE_SELECTORS, PublisherSpec, publisher_spec


_SPACE_RE = re.compile(r"\s+")
_WINDOWS_1252_C1_TRANSLATION = {
    0x80: "€",
    0x81: "",
    0x82: "‚",
    0x83: "ƒ",
    0x84: "„",
    0x85: "…",
    0x86: "†",
    0x87: "‡",
    0x88: "ˆ",
    0x89: "‰",
    0x8A: "Š",
    0x8B: "‹",
    0x8C: "Œ",
    0x8D: "",
    0x8E: "Ž",
    0x8F: "",
    0x90: "",
    0x91: "‘",
    0x92: "’",
    0x93: "“",
    0x94: "”",
    0x95: "•",
    0x96: "–",
    0x97: "—",
    0x98: "˜",
    0x99: "™",
    0x9A: "š",
    0x9B: "›",
    0x9C: "œ",
    0x9D: "",
    0x9E: "ž",
    0x9F: "Ÿ",
}
_CREDIT_RE = re.compile(
    r"(?i)(?:^|\s)(photographer|photo|credit|illustration|graphic|source)s?\s*:"
)
_NOISE_RE = re.compile(
    r"(?i)(advert|sponsor|promo|recommend|related|newsletter|subscribe|"
    r"paywall|cookie|tracking|pixel|logo|icon|avatar)"
)
_TRACKING_RE = re.compile(r"(?i)(pixel|tracking|spacer|transparent)")
_GRAPHIC_RE = re.compile(r"(?i)(chart|graphic|infographic|interactive)")
_MINIMUM_BODY_CHARACTERS = 100
_MINIMUM_SYNDICATED_BODY_CHARACTERS = 400
_EXACT_NOISE_TEXT = {
    ".",
    "##",
    "advertisement",
    "advertiser content",
    "sponsored content",
    "trending stories",
}
_NYT_ATTENDEE_RE = re.compile(
    r'name:"((?:\\.|[^"\\])*)",caption:"((?:\\.|[^"\\])*)"'
)


def stable_article_id(publisher: str, canonical_url: str) -> str:
    digest = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()
    return f"{publisher}:{digest}"


def parse_article(
    html_bytes: bytes,
    *,
    publisher: str,
    canonical_url: str,
    raw_capture: RawCapture | None = None,
    dependent_resources: dict[str, bytes] | None = None,
    parsed_at: datetime | None = None,
    allow_generic_syndication: bool = False,
) -> JojoArticle:
    spec = publisher_spec(publisher)
    declared_latin1 = re.search(
        rb"(?i)charset\s*=\s*[\"']?(?:iso-8859-1|latin-?1)\b",
        html_bytes[:8192],
    )
    has_windows_1252_punctuation = any(
        byte in html_bytes for byte in range(0x80, 0xA0)
    )
    soup = BeautifulSoup(
        html_bytes,
        "html.parser",
        from_encoding=(
            "windows-1252"
            if declared_latin1 and has_windows_1252_punctuation
            else None
        ),
    )
    if spec.publisher == "nyt":
        _repair_nyt_replacement_characters(soup, html_bytes)
    if spec.publisher == "ft":
        _repair_ft_damaged_smart_quotes(soup)
    news_article = _find_news_article_json(soup)
    scmp_video = (
        _find_video_object_json(soup)
        if spec.publisher == "scmp"
        else {}
    )
    nyt_preloaded_metadata = (
        _nyt_preloaded_article_metadata(soup, canonical_url=canonical_url)
        if spec.publisher == "nyt"
        else {}
    )
    axios_next_story = (
        _axios_next_story(soup, canonical_url=canonical_url)
        if spec.publisher == "axios"
        else None
    )
    body = None
    structured_image_gallery_selected = False
    caixin_legacy_gallery_selected = False
    nyt_interactive_body_selected = False
    nyt_legacy_multi_url_story_selected = False
    nyt_op_art_gallery_found = False
    nyt_linked_slideshow_card_found = False
    nyt_books_review_sketchbook_selected = False
    ft_crossword_selected = False
    scmp_legacy_gallery_selected = False
    npr_legacy_transcript_selected = False
    npr_legacy_gallery_selected = False
    npr_legacy_interactive_selected = False
    if spec.publisher == "ap":
        gallery_body = _ap_carousel_gallery(soup)
        if gallery_body is not None:
            body = gallery_body
            structured_image_gallery_selected = True
        else:
            body = _ap_structured_race_call_body(news_article)
            if body is None:
                body = _ap_structured_description_body(news_article)
            if body is None:
                body = _ap_structured_data_bulletin_body(
                    news_article,
                    canonical_url,
                )
        ap_dom_body = _select_body(soup, spec)
        if ap_dom_body is not None and (
            body is None
            or len(_clean_text(ap_dom_body.get_text(" ", strip=True)))
            > len(_clean_text(body.get_text(" ", strip=True)))
        ):
            body = ap_dom_body
    if spec.publisher == "nyt":
        body = _nyt_story_body_companions(soup)
    if spec.publisher in {"reuters", "bloomberg"} and _is_yahoo_syndication(
        soup,
        raw_capture=raw_capture,
    ):
        body = _yahoo_syndication_body(
            soup,
            stop_at_reporting_by=spec.publisher == "reuters",
        )
    generic_syndication_allowed = (
        allow_generic_syndication
        or (
            raw_capture is not None
            and (
                raw_capture.selected_candidate.provider == CaptureProvider.OTHER
                or (
                    spec.publisher == "ft"
                    and raw_capture.selected_candidate.provider
                    == CaptureProvider.INFINI_NEWS
                )
            )
        )
    )
    if (
        body is None
        and spec.publisher == "bloomberg"
        and generic_syndication_allowed
    ):
        body = _bloomberg_partner_body(
            soup,
            canonical_url=canonical_url,
        )
    if body is None and generic_syndication_allowed:
        body = _postmedia_syndication_body(soup)
    if body is None and (
        generic_syndication_allowed
    ):
        body = _newsbreak_syndication_body(soup)
    if body is None and (
        generic_syndication_allowed
    ):
        body = _generic_syndication_body(soup)
    if body is None and spec.publisher == "nyt":
        body = _nyt_legacy_article_body(soup)
    if spec.publisher == "wsj":
        partner_body = _wsj_tovima_body(soup)
        if partner_body is not None:
            body = partner_body
        legacy_video_body = _wsj_legacy_video_body(
            soup,
            canonical_url=canonical_url,
        )
        if legacy_video_body is not None:
            body = legacy_video_body
        puzzle_body = _wsj_puzzle_body(soup, canonical_url=canonical_url)
        if puzzle_body is not None:
            body = puzzle_body
    if spec.publisher == "axios" and axios_next_story is not None:
        body = _axios_next_story_body(axios_next_story)
    if (
        body is None
        and spec.publisher == "nyt"
        and "/watching/" in canonical_url.casefold()
    ):
        body = _nyt_watching_body(soup)
    if (
        spec.publisher == "nyt"
        and "/interactive/" in canonical_url.casefold()
    ):
        interactive_body = _nyt_interactive_body(
            soup,
            canonical_url=canonical_url,
        )
        if interactive_body is not None:
            body = interactive_body
            nyt_interactive_body_selected = True
            nyt_legacy_multi_url_story_selected = (
                _nyt_legacy_multi_url_story_matches(
                    interactive_body,
                    canonical_url=canonical_url,
                )
            )
    if spec.publisher == "bloomberg":
        embedded_bloomberg_body = _bloomberg_embedded_article_body(soup)
        if embedded_bloomberg_body is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(embedded_bloomberg_body.get_text(" ", strip=True))
        ):
            body = embedded_bloomberg_body
        bloomberg_feature_body = _bloomberg_feature_landing_body(soup)
        if bloomberg_feature_body is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(bloomberg_feature_body.get_text(" ", strip=True))
        ):
            body = bloomberg_feature_body
        bloomberg_quiz_body = _bloomberg_embedded_quiz_body(soup)
        if bloomberg_quiz_body is not None:
            body = bloomberg_quiz_body
    if spec.publisher == "nyt":
        preloaded_body = _nyt_preloaded_article_body(
            soup,
            canonical_url=canonical_url,
        )
        if preloaded_body is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(preloaded_body.get_text(" ", strip=True))
        ):
            body = preloaded_body
        embedded_interactive_body = _nyt_preloaded_embedded_interactive_body(
            soup,
            canonical_url=canonical_url,
        )
        if embedded_interactive_body is not None and (
            body is None
            or len(embedded_interactive_body.get_text(" ", strip=True))
            > len(body.get_text(" ", strip=True))
        ):
            body = embedded_interactive_body
            nyt_interactive_body_selected = True
        adventure_body = _nyt_adventure_resource_body(
            soup,
            dependent_resources=dependent_resources or {},
        )
        if adventure_body is not None:
            body = adventure_body
        document_card_body = _nyt_document_card_body(soup)
        if document_card_body is not None:
            body = document_card_body
        books_review_sketchbook_body = _nyt_books_review_sketchbook_body(
            soup,
            canonical_url=canonical_url,
            metadata=nyt_preloaded_metadata,
        )
        image_led_body = (
            books_review_sketchbook_body
            or _nyt_single_image_comics_body(soup)
            or _nyt_preloaded_editorial_cartoon_body(soup)
        )
        if image_led_body is not None:
            body = image_led_body
            structured_image_gallery_selected = True
            nyt_books_review_sketchbook_selected = (
                books_review_sketchbook_body is not None
            )
    if body is None:
        body = _select_body(soup, spec)
    if spec.publisher == "wsj" and (
        body is None
        or _wsj_selected_body_is_comment(body)
        or (
            soup.select_one("#wsj-article-wrap") is None
            and re.search(
                rb"(?i)id\s*=\s*[\"']wsj-article-wrap[\"']",
                html_bytes,
            )
            is not None
        )
    ):
        # A subset of legacy WSJ captures contains malformed HTML that
        # Python's built-in ``html.parser`` treats as an unclosed comment.
        # It may still expose a later Livefyre ``article`` node, so checking
        # only ``body is None`` can mistake a reader comment for the story.
        # The same bytes are recoverable with lxml.
        try:
            fallback_soup = BeautifulSoup(html_bytes, "lxml")
        except Exception:
            fallback_soup = None
        if fallback_soup is not None:
            fallback_body = _select_body(fallback_soup, spec)
            if (
                fallback_body is not None
                and not _wsj_selected_body_is_comment(fallback_body)
            ):
                soup = fallback_soup
                body = fallback_body
    if spec.publisher == "scmp":
        newsletter_body = _scmp_newsletter_iframe_body(soup)
        if newsletter_body is not None:
            body = newsletter_body
        legacy_gallery = _scmp_legacy_gallery_body(soup)
        if legacy_gallery is not None and newsletter_body is None:
            body = legacy_gallery
            structured_image_gallery_selected = True
            scmp_legacy_gallery_selected = True
        standalone_infographic_body = _scmp_standalone_infographic_body(
            soup,
            canonical_url=canonical_url,
        )
        if standalone_infographic_body is not None and (
            body is None
            or (
                standalone_infographic_body.select_one("iframe[src]")
                is not None
                and body.select_one("iframe[src]") is None
            )
            or (
                standalone_infographic_body.select_one("figure img[src]")
                is not None
                and body.select_one("img[src]") is None
            )
            or len(standalone_infographic_body.get_text(" ", strip=True))
            > len(body.get_text(" ", strip=True))
        ):
            body = standalone_infographic_body
        # The Vue-era SCMP pages frequently put the complete article in the
        # Apollo cache while the visible DOM contains only an empty shell.
        # Prefer that structured body when it is longer than the selected DOM
        # node; this keeps modern/legacy DOM extraction authoritative whenever
        # it already contains the full story.
        apollo_body = _scmp_apollo_body(soup)
        if apollo_body is not None and (
            body is None
            or (
                apollo_body.select_one("iframe[src]") is not None
                and body.select_one("iframe[src]") is None
            )
            or (
                body.select_one("iframe[src]") is None
                and len(apollo_body.get_text(" ", strip=True))
                > len(body.get_text(" ", strip=True))
            )
        ):
            body = apollo_body
    if spec.publisher == "caixin":
        legacy_gallery = _caixin_legacy_gallery_body(soup)
        if legacy_gallery is not None:
            body = legacy_gallery
            structured_image_gallery_selected = True
            caixin_legacy_gallery_selected = True
        else:
            legacy_body = soup.select_one("#Main_Content_Val")
        if legacy_gallery is None and isinstance(legacy_body, Tag):
            # Legacy subscription snapshots can leave only a short login
            # roadblock in the real article node.  Falling back to the much
            # broader ``.content`` wrapper then turns recommendations, live
            # tickers, rankings and share controls into a false complete
            # article.  Keep the authoritative node even when it is short;
            # Caixin chrome cleanup will remove the roadblock and quality
            # assessment will correctly reject the empty capture.
            body = legacy_body
    if spec.publisher == "nikkei":
        legacy_body = _nikkei_legacy_article_body(
            soup,
            selected_body=body,
        )
        if legacy_body is not None:
            body = legacy_body
    if spec.publisher == "aljazeera":
        visual_body = _aljazeera_visual_body(
            soup,
            canonical_url=canonical_url,
        )
        if visual_body is not None:
            body = visual_body
        gallery_body = _aljazeera_gallery_body(
            soup,
            canonical_url=canonical_url,
        )
        if gallery_body is not None:
            body = gallery_body
            structured_image_gallery_selected = True
    if spec.publisher == "npr":
        legacy_interactive = (
            _npr_legacy_election_results_body(
                soup,
                canonical_url=canonical_url,
            )
            or _npr_legacy_iframe_interactive_body(
                soup,
                canonical_url=canonical_url,
            )
            or _npr_legacy_flash_interactive_body(
                soup,
                canonical_url=canonical_url,
            )
            or _npr_legacy_inline_interactive_body(soup)
        )
        if legacy_interactive is not None:
            body = legacy_interactive
            npr_legacy_interactive_selected = True
        else:
            legacy_gallery = _npr_legacy_gallery_body(soup)
            if legacy_gallery is not None:
                body = legacy_gallery
                npr_legacy_gallery_selected = True
            else:
                legacy_cartoon = _npr_legacy_cartoon_body(
                    soup,
                    selected_body=body,
                )
                if legacy_cartoon is not None:
                    body = legacy_cartoon
                    npr_legacy_gallery_selected = True
                else:
                    legacy_book_list = _npr_legacy_book_list_body(
                        soup,
                        selected_body=body,
                    )
                    if legacy_book_list is not None:
                        body = legacy_book_list
                    else:
                        legacy_transcript = _npr_legacy_transcript_body(
                            soup,
                            selected_body=body,
                        )
                        if legacy_transcript is not None:
                            body = legacy_transcript
                            npr_legacy_transcript_selected = True
    if spec.publisher == "nyt":
        # Keep an immutable copy of the exact URL-addressed story. Several
        # older recovery helpers intentionally inspect page-level freeform
        # shells, which is correct for an anthology root but would otherwise
        # replace a selected profile with the whole multi-article issue.
        addressed_anthology_story_html = (
            str(body)
            if nyt_legacy_multi_url_story_selected
            and isinstance(body, Tag)
            else None
        )
        legacy_interactive = _nyt_legacy_interactive_graphic(soup)
        if legacy_interactive is not None:
            body = legacy_interactive
        embedded_interactive = _nyt_embedded_interactive_lede(soup)
        if embedded_interactive is not None and (
            body is None
            or _nyt_noninteractive_body_length(body)
            < len(embedded_interactive.get_text(" ", strip=True))
        ):
            body = embedded_interactive
        legacy_newsgraphic = _nyt_legacy_newsgraphic_body(soup)
        if legacy_newsgraphic is not None:
            body = legacy_newsgraphic
        standalone_newsgraphic = _nyt_legacy_standalone_newsgraphic_body(soup)
        if standalone_newsgraphic is not None:
            body = standalone_newsgraphic
        escaped_interactive = _nyt_escaped_legacy_interactive_body(soup)
        if escaped_interactive is not None:
            body = escaped_interactive
        flex_interactive = _nyt_legacy_flex_body(soup)
        if flex_interactive is not None:
            body = flex_interactive
        interactive_documents = _nyt_interactive_document_body(
            soup,
            canonical_url=canonical_url,
        )
        if interactive_documents is not None:
            body_text = (
                _clean_text(body.get_text(" ", strip=True))
                if body is not None
                else ""
            )
            has_document_pages = bool(
                body is not None
                and body.select_one(
                    "img[data-src*='/data/documenttools/']"
                )
            )
            if (
                body is None
                or (
                    len(body_text) < 2 * _MINIMUM_BODY_CHARACTERS
                    and not has_document_pages
                )
            ):
                body = interactive_documents
            else:
                # A source-document link supplements a prose interactive; it
                # must not replace the complete narrative or a rendered page
                # sequence with its short metadata description. Append only
                # the linked document embeds because the description is
                # already represented by the selected body or article metadata.
                for embed in list(interactive_documents.select("iframe")):
                    body.append(embed)
        inline_interactive = _nyt_inline_interactive_media(
            soup,
            canonical_url=canonical_url,
        )
        if inline_interactive is not None:
            body_text = (
                _clean_text(body.get_text(" ", strip=True))
                if body is not None
                else ""
            )
            if body is None or len(body_text) < _MINIMUM_BODY_CHARACTERS:
                body = inline_interactive
            else:
                # Media-only wrappers supplement a prose interactive; they
                # must not replace an anthology's complete article text.
                for child in list(inline_interactive.children):
                    body.append(child)
        ballot_interactive = _nyt_balloteer_body(
            soup,
            canonical_url=canonical_url,
        )
        if ballot_interactive is not None:
            if body is None:
                body = ballot_interactive
            else:
                for child in list(ballot_interactive.children):
                    body.append(child)
        if "/interactive/" in canonical_url.casefold():
            redirect_interactive = _nyt_interactive_redirect_body(soup)
            if redirect_interactive is not None:
                body = redirect_interactive
            metadata_interactive = _nyt_interactive_metadata_body(soup)
            body_text = (
                _clean_text(body.get_text(" ", strip=True))
                if body is not None
                else ""
            )
            metadata_text = (
                _clean_text(
                    metadata_interactive.get_text(" ", strip=True)
                )
                if metadata_interactive is not None
                else ""
            )
            if metadata_interactive is not None and (
                body is None
                or body.select_one(
                    "p, h1, h2, h3, h4, li, table, figure, iframe, img[src]"
                )
                is None
                or (
                    len(body_text) < 2 * _MINIMUM_BODY_CHARACTERS
                    and body.select_one("img[src], figure, iframe") is None
                    and len(metadata_text) > len(body_text)
                    and metadata_text.casefold()
                    not in body_text.casefold()
                )
            ):
                body = metadata_interactive
        if addressed_anthology_story_html is not None:
            addressed_document = BeautifulSoup(
                addressed_anthology_story_html,
                "html.parser",
            )
            restored_story = addressed_document.select_one(
                "article.story[data-slug]"
            )
            if isinstance(restored_story, Tag):
                body = restored_story
    if spec.publisher == "reuters":
        reuters_live_blog = _reuters_live_blog_body(soup)
        if reuters_live_blog is not None:
            body = reuters_live_blog
        else:
            modern_legacy_body = soup.select_one(
                "#rcs-articleContent #article-text"
            )
            if isinstance(modern_legacy_body, Tag):
                body = modern_legacy_body
            legacy_reuters_body = _reuters_legacy_article_body(soup)
            if legacy_reuters_body is not None:
                body = legacy_reuters_body
    if spec.publisher == "wsj":
        gallery_body = _structured_image_gallery(soup)
        if gallery_body is None:
            gallery_body = _wsj_amp_story_gallery(soup)
        if gallery_body is None:
            gallery_body = _wsj_webui_slideshow(soup)
        if gallery_body is None:
            gallery_body = _wsj_legacy_slideshow(soup)
        if gallery_body is None:
            gallery_body = _wsj_unsupported_media_gallery(soup)
        if gallery_body is not None:
            inline_gallery_body = _wsj_inline_slideshow_article_body(
                body,
                gallery_body=gallery_body,
            )
            if inline_gallery_body is not None:
                body = inline_gallery_body
            else:
                body = gallery_body
                structured_image_gallery_selected = True
    if spec.publisher == "nyt":
        gallery_body = _nyt_preloaded_image_gallery(soup)
        if gallery_body is None:
            gallery_body = _nyt_legacy_op_art_gallery(soup)
            nyt_op_art_gallery_found = gallery_body is not None
        if gallery_body is None:
            gallery_body = _nyt_linked_slideshow_card_body(soup)
            nyt_linked_slideshow_card_found = gallery_body is not None
        if (
            gallery_body is not None
            and not nyt_linked_slideshow_card_found
            and not nyt_interactive_body_selected
            and (not nyt_op_art_gallery_found or body is None)
            and _nyt_should_select_gallery_body(soup, body=body)
        ):
            body = gallery_body
            structured_image_gallery_selected = True
        elif (
            gallery_body is not None
            and body is not None
            and not nyt_interactive_body_selected
            and (
                _nyt_linked_slideshow_page(soup)
                or nyt_op_art_gallery_found
            )
        ):
            # Some long-form stories keep their prose in the article body and
            # publish the attached photo essay only in slideshow state.  Do
            # not replace the reporting, but do preserve the explicitly
            # linked gallery after it instead of emitting a media-less gallery.
            document = BeautifulSoup("<article></article>", "html.parser")
            combined = document.article
            if isinstance(combined, Tag):
                sources = (
                    (gallery_body, body)
                    if nyt_op_art_gallery_found
                    else (body, gallery_body)
                )
                for source in sources:
                    for child in list(source.children):
                        combined.append(copy.copy(child))
                body = combined
                structured_image_gallery_selected = True
        legacy_video_body = _nyt_legacy_lede_video_body(soup, body=body)
        if (
            legacy_video_body is not None
            and not structured_image_gallery_selected
            and not nyt_interactive_body_selected
        ):
            body = legacy_video_body
    if spec.publisher == "ft":
        crossword_body = _ft_crossword_body(soup, body=body)
        if crossword_body is not None:
            body = crossword_body
            ft_crossword_selected = True
    if spec.embedded_html_body_keys and (
        body is None
        or body.select_one(
            "p, h2, h3, h4, h5, h6, blockquote, ul, ol, table"
        )
        is None
    ):
        embedded_body = _embedded_html_body(
            soup,
            keys=spec.embedded_html_body_keys,
        )
        if embedded_body is not None:
            body = embedded_body
    if spec.use_structured_article_body:
        structured_body = _structured_article_body(
            news_article,
            extract_ft_embedded_media=spec.publisher == "ft",
        )
        if body is None:
            body = structured_body
        elif structured_body is not None:
            body = _prefer_structured_body_with_media(
                body,
                structured_body=structured_body,
                force=(
                    spec.publisher == "zaobao"
                    and _zaobao_structured_visual_body_is_more_complete(
                        news_article,
                        body=body,
                        structured_body=structured_body,
                    )
                ),
            )
    if spec.publisher == "nyt":
        birdkit_body = _nyt_birdkit_attendee_body(soup)
        if birdkit_body is not None:
            body = birdkit_body
    nyt_legacy_multi_url_story_selected = bool(
        nyt_legacy_multi_url_story_selected
        and _nyt_legacy_multi_url_story_matches(
            body,
            canonical_url=canonical_url,
        )
    )
    clean_body = BeautifulSoup(str(body), "html.parser") if body else BeautifulSoup("", "html.parser")
    wsj_selected_sign_in = bool(
        spec.publisher == "wsj"
        and any(
            _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith("already a member? sign in")
            for node in clean_body.select("p")
        )
    )
    if spec.publisher == "ap":
        _remove_ap_body_promos(clean_body)
    if spec.publisher == "reuters":
        _trim_reuters_recirculation_tail(clean_body)
    if spec.publisher == "bloomberg":
        _trim_bloomberg_subscription_tail(clean_body)
        _remove_bloomberg_damaged_attribution(clean_body)
    if spec.publisher == "wsj":
        _trim_wsj_roadblock_tail(clean_body)
    if spec.publisher == "nyt":
        _remove_nyt_body_chrome(clean_body)
        # Some archived templates reconstruct their article body from
        # preloaded JSON after the page-level noise pass. Apply the same
        # narrowly matched promo cleanup to that final body copy as well.
        _remove_nyt_promos(clean_body)
        _trim_nyt_access_shell_tail(clean_body)
    if spec.publisher == "nikkei":
        _trim_nikkei_paywall_tail(clean_body)
        _remove_nikkei_body_chrome(clean_body)
    if spec.publisher == "zaobao":
        _remove_zaobao_body_chrome(clean_body)
    if spec.publisher == "caixin":
        _remove_caixin_body_chrome(clean_body)
    if spec.publisher == "axios":
        _remove_axios_body_chrome(clean_body)
    if spec.publisher == "npr":
        _remove_npr_body_chrome(clean_body)
    if spec.publisher == "aljazeera":
        _remove_aljazeera_body_chrome(clean_body)
    if spec.publisher == "scmp":
        _restore_scmp_lazy_body_images(clean_body)
        _remove_scmp_body_chrome(clean_body)
    _remove_noise(clean_body, spec)
    if spec.publisher == "wsj":
        inset_tables = _wsj_inset_table_body(soup)
        if inset_tables is not None:
            existing_text = _clean_text(
                clean_body.get_text(" ", strip=True)
            ).casefold()
            for child in list(inset_tables.children):
                if (
                    isinstance(child, Tag)
                    and child.name in {"h2", "h3"}
                    and _clean_text(child.get_text(" ", strip=True))
                    .casefold()
                    in existing_text
                ):
                    continue
                clean_body.append(child)

    headline = _first_text(
        (
            "Bloomberg Tax Quiz"
            if (
                spec.publisher == "bloomberg"
                and "/features/2017-tax-quiz" in canonical_url.casefold()
                and soup.select_one("#quiz-container section.question")
            )
            else None
        ),
        (
            _tag_text(
                soup.select_one(
                    "#quiz-container section.question h1, "
                    "#quiz-container section.question h2"
                )
            )
            if spec.publisher == "bloomberg"
            else None
        ),
        _string_or_none(nyt_preloaded_metadata.get("headline")),
        (
            _string_or_none(axios_next_story.get("headline"))
            if axios_next_story is not None
            else None
        ),
        _ap_structured_headline(news_article)
        if spec.publisher == "ap"
        else (
            _string_or_none(news_article.get("headline"))
            if news_article
            else None
        ),
        _ap_data_bulletin_headline(news_article)
        if spec.publisher == "ap"
        else None,
        _ap_wire_keyword_headline(news_article)
        if spec.publisher == "ap"
        else None,
        _ap_hosted_headline(soup) if spec.publisher == "ap" else None,
        _wsj_legacy_headline(soup)
        if spec.publisher == "wsj"
        else None,
        _nikkei_legacy_headline(soup)
        if spec.publisher == "nikkei"
        else None,
        _caixin_legacy_headline(soup)
        if spec.publisher == "caixin"
        else None,
        (
            _tag_text(soup.select_one("h1#page-title.title"))
            if spec.publisher == "scmp"
            else None
        ),
        (
            _tag_text(
                soup.select_one(
                    ".view-mode-level_masthead "
                    "h2.node-title[property='dc:title']"
                )
            )
            if spec.publisher == "scmp"
            else None
        ),
        _meta_content(soup, "property", "og:title"),
        _meta_content(soup, "name", "twitter:title"),
        _tag_text(soup.select_one("article h1, main h1, h1")),
        (
            _tag_text(soup.select_one("#article-summary"))
            if spec.publisher == "nyt"
            else None
        ),
    )
    if spec.publisher == "ft" and headline:
        headline = re.sub(
            r"(?i)\s*[-–—]\s*FT\.com\s*$",
            "",
            headline,
        ).strip()
    if spec.publisher == "npr" and headline:
        headline = re.sub(r"(?i)\s*:\s*NPR\s*$", "", headline).strip()
    if spec.publisher == "nikkei" and headline:
        headline = re.sub(
            r"(?i)\s*[-–—]\s*Nikkei(?:\s+Asian\s+Review|\s+Asia)\s*$",
            "",
            headline,
        ).strip()
    description = _first_text(
        _string_or_none(nyt_preloaded_metadata.get("description")),
        (
            _string_or_none(axios_next_story.get("og_description"))
            if axios_next_story is not None
            else None
        ),
        _string_or_none(news_article.get("description")) if news_article else None,
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    if (
        spec.publisher == "bloomberg"
        and description
        and (
            re.match(
                r"(?i)^sign up to receive (?:the )?.+ newsletter\b",
                description,
            )
            or re.match(
                r"(?i)^want to receive this post in your inbox\b.*"
                r"\bsign up for\b.*\bnewsletter\b",
                description,
            )
            or re.match(
                r"(?i)^for even more:\s*subscribe to bloomberg all access\b",
                description,
            )
        )
    ):
        description = None
    authors = _extract_authors(
        news_article,
        soup,
        publisher=spec.publisher,
    )
    if spec.publisher == "ap" and not authors:
        authors = _ap_hosted_authors(soup)
    metadata_authors = nyt_preloaded_metadata.get("authors")
    if isinstance(metadata_authors, list) and metadata_authors:
        authors = [
            Author(name=value)
            for value in metadata_authors
            if isinstance(value, str) and value.strip()
        ]
    published_at = _parse_datetime(
        _first_text(
            _string_or_none(nyt_preloaded_metadata.get("published_at")),
            (
                _string_or_none(axios_next_story.get("published_date"))
                if axios_next_story is not None
                else None
            ),
            _string_or_none(news_article.get("datePublished"))
            if news_article
            else None,
            _first_text(
                _string_or_none(scmp_video.get("datePublished")),
                _string_or_none(scmp_video.get("uploadDate")),
                _string_or_none(scmp_video.get("dateCreated")),
            )
            if scmp_video
            else None,
            _meta_content(soup, "property", "article:published_time"),
            _meta_content(soup, "property", "og:article:published_time"),
            _meta_content(soup, "name", "pub_date"),
            _meta_content(soup, "name", "pdate"),
            _meta_content(
                soup,
                "name",
                "analyticsAttributes.articleDate",
            ),
            _meta_content(soup, "name", "sailthru.date"),
            (
                _meta_content(soup, "name", "date")
                if spec.publisher == "npr"
                else None
            ),
            _ap_hosted_published_at(soup)
            if spec.publisher == "ap"
            else None,
            (
                _bloomberg_legacy_published_at(soup)
                if spec.publisher == "bloomberg"
                else None
            ),
            _nyt_visible_published_at(soup),
            _ft_legacy_published_at(soup) if spec.publisher == "ft" else None,
            (
                _wsj_legacy_published_at(soup)
                if spec.publisher == "wsj"
                else None
            ),
            (
                _nikkei_legacy_published_at(soup)
                if spec.publisher == "nikkei"
                else None
            ),
            (
                _first_text(
                    _scmp_embedded_published_at(soup),
                    _scmp_legacy_published_at(soup),
                )
                if spec.publisher == "scmp"
                else None
            ),
            (
                _zaobao_embedded_published_at(soup)
                if spec.publisher == "zaobao"
                else None
            ),
            (
                _caixin_legacy_published_at(soup)
                if spec.publisher == "caixin"
                else None
            ),
            _tag_attribute(
                soup.select_one(
                    '[itemprop="datePublished"][datetime], '
                    'time[datetime][data-testid*="timestamp" i]'
                ),
                "datetime",
            ),
        )
    )
    if published_at is None and raw_capture is not None:
        published_at = raw_capture.published_at
    modified_at = _parse_datetime(
        _first_text(
            _string_or_none(nyt_preloaded_metadata.get("modified_at")),
            _string_or_none(news_article.get("dateModified"))
            if news_article
            else None,
            _string_or_none(scmp_video.get("dateModified"))
            if scmp_video
            else None,
            _meta_content(soup, "property", "article:modified_time"),
            _meta_content(soup, "name", "lastmod"),
            _tag_attribute(
                soup.select_one('[itemprop="dateModified"][datetime]'),
                "datetime",
            ),
        )
    )
    section = _first_text(
        _string_or_none(news_article.get("articleSection"))
        if news_article
        else None,
        raw_capture.section if raw_capture else None,
        _meta_content(soup, "name", "section"),
        _meta_content(soup, "property", "article:section"),
    )
    language = _document_language(soup, default=spec.default_language)
    scmp_yp_audio_url = (
        _scmp_yp_audio_handoff_url(
            soup,
            canonical_url=canonical_url,
        )
        if spec.publisher == "scmp"
        else None
    )
    content_type = _content_type(news_article, canonical_url)
    if spec.publisher == "scmp" and _scmp_live_article(soup):
        # SCMP marks its legacy live-sport pages with a ``cse_articletype``
        # metadata value even when JSON-LD still says ``NewsArticle``. Keep
        # the semantic type so validation can distinguish a missing replayed
        # update stream from a broken text-article extraction.
        content_type = ContentType.LIVEBLOG
    elif (
        spec.publisher == "scmp"
        and _scmp_newsletter_iframe_body(soup) is not None
    ):
        content_type = ContentType.NEWSLETTER
    elif (
        spec.publisher == "scmp"
        and _scmp_standalone_infographic_body(
            soup,
            canonical_url=canonical_url,
        )
        is not None
    ):
        content_type = ContentType.INTERACTIVE
    elif (
        spec.publisher == "scmp"
        and isinstance(body, Tag)
        and body.select_one(
            "iframe[data-interactive-provider='scmp-apollo']"
        )
        is not None
        and len(body.get_text(" ", strip=True)) < 500
    ):
        content_type = ContentType.INTERACTIVE
    elif spec.publisher == "scmp" and scmp_yp_audio_url:
        # Some Young Post listening exercises hand the media off to an
        # explicitly linked YouTube player instead of rendering an <audio>
        # element. The two short instructional paragraphs are the complete
        # package, not a truncated text article.
        content_type = ContentType.AUDIO
    npr_audio_url: str | None = None
    if any(
        value.get("@type") == "LiveBlogPosting"
        for value in _json_ld_objects(soup)
    ):
        content_type = ContentType.LIVEBLOG
    ft_missing_legacy_visual = bool(
        spec.publisher == "ft"
        and _ft_missing_legacy_visual(soup)
    )
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_article_narration(soup)
    ):
        content_type = ContentType.ARTICLE
    if spec.publisher == "nyt":
        content_type = _nyt_media_content_type(
            soup,
            default=content_type,
            structured_image_gallery_selected=structured_image_gallery_selected,
            interactive_body_selected=nyt_interactive_body_selected,
            canonical_url=canonical_url,
        )
    if (
        spec.publisher == "wsj"
        and _wsj_interactive_puzzle(soup, news_article, canonical_url)
    ):
        content_type = ContentType.INTERACTIVE
    if spec.publisher == "wsj" and _wsj_is_legacy_video(soup):
        content_type = ContentType.VIDEO
    if spec.publisher == "wsj":
        wsj_page_content_type = _clean_text(
            _meta_content(soup, "name", "page.content.type") or ""
        ).casefold()
        if (
            content_type == ContentType.INTERACTIVE
            and wsj_page_content_type == "article"
            and re.search(
                r"(?i)/articles/interactive-brokers(?:-|$)",
                urlsplit(canonical_url).path,
            )
        ):
            # ``Interactive Brokers`` is a company name, not a WSJ page-type
            # marker.  The generic URL fallback sees the first word in the
            # article slug and otherwise mislabels ordinary company coverage
            # as an interactive, despite WSJ's explicit article metadata.
            content_type = ContentType.ARTICLE
        if wsj_page_content_type in {
            "gallery",
            "photo gallery",
            "photo-gallery",
            "slideshow",
        } or soup.select_one(".slideshow-article"):
            content_type = ContentType.GALLERY
    if (
        spec.publisher == "ap"
        and _is_ap_data_bulletin(news_article, canonical_url)
    ):
        content_type = ContentType.INTERACTIVE
    if spec.publisher == "axios":
        axios_content_type = _axios_next_story_content_type(axios_next_story)
        if axios_content_type is not None:
            content_type = axios_content_type
        axios_embedded_content_type = _axios_embedded_content_type(clean_body)
        if axios_embedded_content_type is not None:
            content_type = axios_embedded_content_type
    if npr_legacy_interactive_selected:
        content_type = ContentType.INTERACTIVE
    elif npr_legacy_gallery_selected:
        content_type = ContentType.GALLERY
    elif npr_legacy_transcript_selected:
        content_type = ContentType.TRANSCRIPT
    npr_legacy_metadata_audio = (
        spec.publisher == "npr"
        and _npr_legacy_metadata_audio_story(
            soup,
            body=clean_body,
        )
    )
    npr_legacy_unavailable_audio = (
        spec.publisher == "npr"
        and _npr_legacy_unavailable_audio_story(
            soup,
            body=clean_body,
        )
    )
    npr_legacy_named_audio = (
        spec.publisher == "npr"
        and _npr_legacy_named_audio_story(
            soup,
            body=clean_body,
            canonical_url=canonical_url,
        )
    )
    if (
        spec.publisher == "npr"
        and not npr_legacy_interactive_selected
        and (
            npr_legacy_metadata_audio
            or npr_legacy_unavailable_audio
            or npr_legacy_named_audio
            or _npr_short_audio_story(
                soup,
                body=clean_body,
            )
        )
    ):
        content_type = ContentType.AUDIO
        npr_audio_url = _npr_story_audio_url(
            soup,
            base_url=canonical_url,
        )
    if spec.publisher == "ft" and ft_crossword_selected:
        content_type = ContentType.INTERACTIVE
    if ft_missing_legacy_visual:
        content_type = ContentType.GALLERY
    if (
        spec.publisher == "ft"
        and soup.select_one(
            ".flashcomponent a.flashlink[href*='.swf' i]"
        )
    ):
        content_type = ContentType.INTERACTIVE
    if (
        content_type == ContentType.ARTICLE
        and soup.select_one(
            "audio[data-audio-subtype='podcast'], "
            "audio source[type^='audio/']"
        )
        and not (
            spec.publisher == "bloomberg"
            and (
                _bloomberg_article_narration(soup)
                or (
                    isinstance(body, Tag)
                    and body.get("data-jojo-source")
                    == "bloomberg-arabamerica-syndication"
                )
            )
        )
    ):
        content_type = ContentType.AUDIO

    images_by_url: dict[str, ImageCandidate] = {}
    blocks: list[ContentBlock] = []
    wsj_standalone_truncation_marker = False
    bloomberg_lightbox_thumbnails = (
        _bloomberg_legacy_lightbox_thumbnail_identities(
            soup,
            base_url=canonical_url,
        )
        if spec.publisher == "bloomberg"
        else set()
    )
    for url in _lead_image_urls(soup, news_article, canonical_url):
        if (
            spec.publisher == "nyt"
            and nyt_legacy_multi_url_story_selected
        ):
            # A 2017 multi-URL anthology preloads the entire issue's image
            # inventory on every profile URL.  The selected article contains
            # its own correctly positioned figure, so page-level lead images
            # would reintroduce dozens of sibling-profile photographs.
            continue
        if (
            spec.publisher == "nyt"
            and nyt_books_review_sketchbook_selected
        ):
            # Sketchbook pages expose a social-card crop whose filename is
            # unrelated to the full-resolution illustration in the body.  The
            # selected figure is the best surviving rendition and already
            # preserves its exact reading position.
            continue
        if (
            spec.publisher == "aljazeera"
            and _aljazeera_non_editorial_image_url(url)
        ):
            # Current Al Jazeera JSON-LD image arrays append the shared
            # social-card logo after the editorial lead renditions.  It is
            # site chrome, not a fifth version of the story photograph.
            continue
        if spec.publisher == "scmp" and scmp_legacy_gallery_selected:
            # Every editorial image is already represented at its full-size
            # gallery URL; the metadata lead is only a duplicate thumbnail.
            continue
        if spec.publisher == "npr" and (
            npr_legacy_gallery_selected
            or _npr_non_editorial_image_url(url)
        ):
            # Legacy multimedia pages expose a full-size slideshow image in
            # the selected body. Their metadata image is often a duplicate
            # thumbnail; old transcript pages sometimes expose only the NPR
            # chrome logo as metadata.
            continue
        if (
            spec.publisher == "nikkei"
            and _nikkei_non_editorial_image_url(url)
        ):
            continue
        if (
            spec.publisher == "zaobao"
            and _zaobao_non_editorial_image_url(url)
        ):
            continue
        if (
            spec.publisher == "caixin"
            and _caixin_non_editorial_image_url(url)
        ):
            continue
        if (
            spec.publisher == "scmp"
            and _scmp_non_editorial_image_url(url)
        ):
            continue
        if (
            spec.publisher == "nyt"
            and _nyt_non_editorial_lead_image(
                url,
                canonical_url=canonical_url,
            )
        ):
            continue
        if (
            spec.publisher == "bloomberg"
            and (
                _bloomberg_author_avatar_url(url)
                or _image_identity(url) in bloomberg_lightbox_thumbnails
            )
        ):
            continue
        image = _image_candidate(
            url=url,
            candidate_urls=[url],
            role=ImageRole.LEAD,
            spec=spec,
            reasons=["structured-lead-image"],
        )
        image_key = _image_identity(image.original_url)
        existing = images_by_url.get(image_key)
        if existing is None:
            images_by_url[image_key] = image
        else:
            _merge_candidate_urls(existing, image)

    if clean_body:
        blocks, body_images = _extract_blocks(
            clean_body,
            base_url=canonical_url,
            spec=spec,
            starting_position=0,
            preserve_nyt_interactive_caption_prose=(
                spec.publisher == "nyt" and nyt_interactive_body_selected
            ),
        )
        for image in body_images:
            if (
                spec.publisher == "aljazeera"
                and _aljazeera_non_editorial_image_url(image.original_url)
            ):
                continue
            if (
                spec.publisher == "npr"
                and _npr_non_editorial_image_url(image.original_url)
            ):
                continue
            if (
                spec.publisher == "nikkei"
                and _nikkei_non_editorial_image_candidate(image)
            ):
                continue
            if (
                spec.publisher == "zaobao"
                and _zaobao_non_editorial_image_url(image.original_url)
            ):
                continue
            if (
                spec.publisher == "caixin"
                and _caixin_non_editorial_image_url(image.original_url)
            ):
                continue
            if (
                spec.publisher == "scmp"
                and _scmp_non_editorial_image_url(image.original_url)
            ):
                continue
            if (
                spec.publisher == "bloomberg"
                and _bloomberg_author_avatar_url(image.original_url)
            ):
                continue
            image_key = _image_identity(image.original_url)
            existing = images_by_url.get(image_key)
            if (
                existing is None
                and spec.publisher == "bloomberg"
                and _bloomberg_low_resolution_image(image)
            ):
                caption_key = _clean_text(
                    image.caption or ""
                ).casefold()
                existing = next(
                    (
                        candidate
                        for candidate in images_by_url.values()
                        if candidate.role == ImageRole.LEAD
                        and caption_key
                        and _clean_text(
                            candidate.caption or ""
                        ).casefold()
                        == caption_key
                    ),
                    None,
                )
            if existing is None:
                images_by_url[image_key] = image
                continue
            if not existing.should_archive and image.should_archive:
                # A metadata rendition can look like an author/social image
                # while a matching high-resolution rendition is explicitly
                # present in the article body.  Prefer the body occurrence;
                # otherwise the non-editorial metadata role can suppress the
                # real illustration even though both URLs share one identity.
                _merge_candidate_urls(image, existing)
                if not image.caption and existing.caption:
                    image.caption = existing.caption
                if not image.credit and existing.credit:
                    image.credit = existing.credit
                if not image.alt and existing.alt:
                    image.alt = existing.alt
                image.selection_reasons = sorted(
                    set(image.selection_reasons + existing.selection_reasons)
                    - {
                        "author-avatar-url",
                        "social-or-author-icon-url",
                    }
                )
                images_by_url[image_key] = image
                continue
            # A body occurrence provides position/caption evidence that metadata alone
            # does not. Keep the lead role but merge useful descriptive fields.
            _merge_candidate_urls(existing, image)
            if not existing.caption and image.caption:
                existing.caption = image.caption
            if not existing.credit and image.credit:
                existing.credit = image.credit
            if not existing.alt and image.alt:
                existing.alt = image.alt
            existing.selection_reasons = sorted(
                set(existing.selection_reasons + image.selection_reasons)
            )
            for block in blocks:
                if block.asset_id == image.asset_id:
                    block.asset_id = existing.asset_id
        selected_asset_ids = {
            image.asset_id for image in images_by_url.values()
        }
        blocks = [
            block
            for block in blocks
            if not (
                block.type == BlockType.IMAGE
                and block.asset_id
                and block.asset_id not in selected_asset_ids
            )
        ]
        blocks = _deduplicate_blocks(
            blocks,
            deduplicate_contained_pull_quotes=spec.publisher == "ft",
            deduplicate_bloomberg_dateline_variants=spec.publisher
            == "bloomberg",
        )
        if spec.publisher == "wsj":
            trailing_text = (
                _clean_text(blocks[-1].text or "") if blocks else ""
            )
            wsj_standalone_truncation_marker = bool(
                blocks
                and blocks[-1].type == BlockType.PARAGRAPH
                and len(trailing_text) <= 80
                and (
                    trailing_text == "…"
                    or re.search(r"\.{3,}$", trailing_text)
                )
            )
            if wsj_standalone_truncation_marker:
                blocks.pop()

    if npr_audio_url and not any(
        block.type == BlockType.EMBED
        and block.embed_url == npr_audio_url
        for block in blocks
    ):
        blocks.append(
            ContentBlock(
                type=BlockType.EMBED,
                position=max((block.position for block in blocks), default=-1)
                + 1,
                embed_url=npr_audio_url,
            )
        )

    if scmp_yp_audio_url and not any(
        block.type == BlockType.EMBED
        and block.embed_url == scmp_yp_audio_url
        for block in blocks
    ):
        blocks.append(
            ContentBlock(
                type=BlockType.EMBED,
                position=max((block.position for block in blocks), default=-1)
                + 1,
                embed_url=scmp_yp_audio_url,
            )
        )

    if content_type == ContentType.ARTICLE and (
        structured_image_gallery_selected
        or _looks_like_gallery(
            blocks,
            allow_uncaptioned=spec.publisher == "ft",
        )
        or (
            spec.publisher == "zaobao"
            and "/forum/comic/" in canonical_url.casefold()
            and (
                any(block.type == BlockType.IMAGE for block in blocks)
                or len(images_by_url) >= 1
            )
        )
        or (
            spec.publisher == "aljazeera"
            and "/gallery/" in canonical_url.casefold()
            and (
                sum(block.type == BlockType.IMAGE for block in blocks) >= 1
                or len(images_by_url) >= 1
            )
        )
        or (
            spec.publisher == "scmp"
            and _scmp_image_led_graphic(
                canonical_url=canonical_url,
                headline=headline,
                description=description,
                blocks=blocks,
                image_count=len(images_by_url),
            )
        )
    ):
        content_type = ContentType.GALLERY
    plain_text = "\n\n".join(
        value
        for block in blocks
        if (value := _block_plain_text(block))
    )
    body_html = _inner_html(clean_body)
    if spec.publisher == "scmp":
        for image in images_by_url.values():
            promoted = _promote_scmp_image_candidates(
                image.candidate_urls
            )
            if promoted:
                image.original_url = promoted[0]
                image.candidate_urls = promoted
    images = list(images_by_url.values())
    if spec.publisher == "aljazeera":
        content_type = _aljazeera_body_content_type(
            default=content_type,
            headline=headline,
            plain_text=plain_text,
            blocks=blocks,
            visual_tags=_first_text(
                _meta_content(soup, "name", "tags"),
                _meta_content(soup, "name", "primaryTag"),
                _meta_content(soup, "name", "taxonomy-tags"),
            ),
        )
    if (
        spec.publisher == "zaobao"
        and content_type == ContentType.ARTICLE
        and _zaobao_visual_short_record(
            news_article,
            body_characters=len(plain_text),
            images=images,
        )
    ):
        content_type = ContentType.GALLERY
    if (
        spec.publisher == "ft"
        and content_type == ContentType.ARTICLE
        and _ft_image_led_article(
            news_article,
            body_characters=len(plain_text),
            images=images,
        )
    ):
        content_type = ContentType.GALLERY
    warnings: list[str] = []
    if not headline:
        warnings.append("missing-headline")
    image_block_count = sum(
        block.type == BlockType.IMAGE for block in blocks
    )
    image_led_gallery = (
        content_type == ContentType.GALLERY
        and (
            image_block_count >= 1
            or (
                spec.publisher in {"nyt", "ft"}
                and any(image.should_archive for image in images)
            )
            or (
                spec.publisher == "zaobao"
                and len(images) >= 1
                and (
                    "/forum/comic/" in canonical_url.casefold()
                    or _zaobao_visual_short_record(
                        news_article,
                        body_characters=len(plain_text),
                        images=images,
                    )
                )
            )
            or (
                spec.publisher == "aljazeera"
                and "/gallery/" in canonical_url.casefold()
                and len(images) >= 1
            )
            or (
                spec.publisher == "scmp"
                and any(image.should_archive for image in images)
                and _scmp_image_led_graphic(
                    canonical_url=canonical_url,
                    headline=headline,
                    description=description,
                    blocks=blocks,
                    image_count=len(images),
                )
            )
        )
    )
    # A small set of NYT visual features (notably T Magazine) is published
    # as one or two figures plus captions and only a short editorial dek.  It
    # is still a recoverable image-led article: the figure/caption payload is
    # the body, rather than an empty interactive shell.  Do not manufacture
    # prose, but do allow the preserved image/caption record to pass the
    # short-body gate.
    nyt_image_led_editorial = (
        spec.publisher == "nyt"
        and content_type in {ContentType.ARTICLE, ContentType.OPINION}
        and _nyt_image_led_editorial(
            soup,
            body=clean_body,
            canonical_url=canonical_url,
            metadata=nyt_preloaded_metadata,
        )
    )
    embedded_nontext_content = bool(
        content_type
        in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.TRANSCRIPT,
            ContentType.LIVEBLOG,
            ContentType.NEWSLETTER,
        }
        and (
            any(
                block.type
                in (
                    {BlockType.EMBED}
                    if content_type == ContentType.NEWSLETTER
                    else {BlockType.EMBED, BlockType.IMAGE}
                )
                for block in blocks
            )
            # Axios visual fallback SVGs are interaction payloads but do not
            # always expose an <img> or iframe block in archived markup.
            or (
                spec.publisher == "axios"
                and clean_body.select_one(
                    ".axios-visual-apple-fallback-image, "
                    ".axios-visual-newsletter-fallback-image"
                )
                is not None
            )
            # Legacy NYT interactive packages often place their rendered
            # experience in external scripts. Their archived document still
            # proves the item is a non-text interactive and preserves the
            # source URL/HTML for later replay, rather than being a short
            # Opinion article.
            or (
                spec.publisher == "nyt"
                and content_type == ContentType.INTERACTIVE
                and _nyt_legacy_interactive_shell_document(
                    soup,
                    canonical_url=canonical_url,
                )
            )
            # Standalone legacy interactives advertise their page type in
            # metadata even when the archived shell contains only a lede and
            # an external graphic bundle. Preserve that package as a valid
            # non-text record instead of reporting an extraction failure.
            or (
                spec.publisher == "nyt"
                and content_type == ContentType.INTERACTIVE
                and len(plain_text) < _MINIMUM_BODY_CHARACTERS
                and _nyt_has_interactive_metadata(soup)
            )
            # NPR's pre-HTML5 story template represented some intentionally
            # short radio segments with only the editorial description in
            # #storytext and an explicit ``medium=audio`` marker.  The player
            # was supplied outside the archived document, so absence of an
            # inline MP3/embed is not evidence that the description parser
            # truncated the page.
            or npr_legacy_metadata_audio
            or npr_legacy_unavailable_audio
            or npr_legacy_named_audio
            or (
                spec.publisher == "scmp"
                and content_type == ContentType.LIVEBLOG
                and _scmp_live_article(soup)
            )
        )
    )
    publisher_notice = _is_publisher_notice(
        headline=headline,
        description=description,
        plain_text=plain_text,
    )
    structured_short_record = _is_structured_short_record(
        spec=spec,
        soup=soup,
        news_article=news_article,
        canonical_url=canonical_url,
        headline=headline,
        plain_text=plain_text,
    )
    structured_empty_newsletter = bool(
        spec.publisher == "axios"
        and _axios_empty_newsletter_story(axios_next_story)
    )
    structured_short_newsletter = bool(
        spec.publisher == "axios"
        and _axios_short_newsletter_story(axios_next_story)
    )
    minimum_body_characters = (
        _MINIMUM_BODY_CHARACTERS
        if (
            spec.publisher == "wsj"
            and _wsj_is_editorial_letter(soup)
        )
        # Zaobao carries short wire briefs whose complete Chinese body can
        # legitimately be under sixty characters; keep a small floor above
        # an empty shell while accepting those fully reported briefs.
        else 20
        if (
            spec.publisher == "zaobao"
            and content_type == ContentType.ARTICLE
        )
        else 500
        if (
            spec.publisher == "wsj"
            and content_type == ContentType.ARTICLE
        )
        # Al Jazeera publishes legitimate short briefs and image-led
        # explainers; use the parser's normal 100-character floor for those,
        # while retaining the stricter floor for sparse interactive shells.
        else _MINIMUM_BODY_CHARACTERS
        if (
            spec.publisher == "aljazeera"
            and content_type == ContentType.ARTICLE
        )
        else 500
        if (
            spec.publisher == "aljazeera"
            and content_type == ContentType.INTERACTIVE
        )
        else _MINIMUM_BODY_CHARACTERS
    )
    if (
        len(plain_text) < minimum_body_characters
        and not image_led_gallery
        and not nyt_image_led_editorial
        and not embedded_nontext_content
        and not publisher_notice
        and not structured_short_record
        and not structured_empty_newsletter
        and not structured_short_newsletter
    ):
        warnings.append("body-too-short")
    if publisher_notice:
        warnings.append("publisher-notice")
    if structured_short_record:
        warnings.append("structured-short-record")
    if structured_empty_newsletter:
        warnings.append("structured-empty-newsletter")
    if structured_short_newsletter:
        warnings.append("structured-short-newsletter")
    if spec.publisher == "ft" and _ft_explicit_truncation_notice(soup):
        warnings.append("truncated-body")
    if (
        spec.publisher == "ft"
        and _ft_infini_access_shell(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "nikkei"
        and _nikkei_truncated_body(
            soup,
            plain_text=plain_text,
        )
    ):
        warnings.append("truncated-body")
    if spec.publisher == "bloomberg" and _bloomberg_teaser_shell(soup):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_parcel_industry_teaser(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_pv_magazine_teaser(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_partner_full_story_teaser(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_macdailynews_excerpt(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_origin_abrupt_quote_truncation(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_origin_incomplete_for_more_tail(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_origin_trailing_heading_truncation(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_john_lothian_summary(soup)
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and _bloomberg_short_source_link_excerpt(
            soup,
            plain_text=plain_text,
        )
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and len(plain_text) < 500
        and soup.select_one("article.artData.paywall") is not None
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and soup.select_one(".ai-block") is not None
        and "signalpro" in _clean_text(
            soup.get_text(" ", strip=True)
        ).casefold()
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and "linkedin.com/" in _clean_text(
            _first_text(
                _meta_content(soup, "property", "og:url"),
                _tag_attribute(
                    soup.select_one("link[rel='canonical']"),
                    "href",
                ),
            )
            or ""
        ).casefold()
        and any(
            marker in _clean_text(soup.get_text(" ", strip=True)).casefold()
            for marker in (
                "cut through the ai noise",
                "full article below with no paywall",
                "read my latest, for free",
                "humbled to see our journey featured in bloomberg",
                "excited to be quoted in bloomberg news",
                "had the pleasure of joining bloomberg podcasts",
                "always-superb editing by",
            )
        )
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and "the practical value is the source trail" in _clean_text(
            soup.get_text(" ", strip=True)
        ).casefold()
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and "as international investment experts report" in _clean_text(
            soup.get_text(" ", strip=True)
        ).casefold()
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and "abitech analysis" in _clean_text(
            soup.get_text(" ", strip=True)
        ).casefold()
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "bloomberg"
        and "biggo finance appears first in google search" in _clean_text(
            soup.get_text(" ", strip=True)
        ).casefold()
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "wsj"
        and content_type == ContentType.ARTICLE
        and (
            wsj_standalone_truncation_marker
            or _wsj_legacy_ellipsis_truncation(plain_text)
            or _wsj_missing_best_seller_chart(
                headline=headline,
                plain_text=plain_text,
            )
        )
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "wsj"
        and _wsj_subscription_truncation(
            soup,
            content_type=content_type,
            plain_text=plain_text,
            selected_sign_in=wsj_selected_sign_in,
        )
    ):
        warnings.append("truncated-body")
    if (
        spec.publisher == "wsj"
        and content_type == ContentType.GALLERY
        and soup.select_one(".slideshow-article")
        and sum(image.should_archive for image in images) < 3
    ):
        warnings.append("incomplete-gallery")
    if (
        caixin_legacy_gallery_selected
        and _caixin_legacy_gallery_expected_images(soup)
        > sum(image.should_archive for image in images)
    ):
        warnings.append("incomplete-gallery")
    if (
        spec.publisher == "nyt"
        and content_type == ContentType.GALLERY
        and not any(image.should_archive for image in images)
    ):
        # An author portrait or social-card rendition is not sufficient to
        # make an image-led record complete.  This catches archived Opinion
        # cartoon shells whose actual article-body illustration was missed.
        warnings.append("incomplete-gallery")
    if (
        ft_missing_legacy_visual
        and not any(image.should_archive for image in images)
        and not any(
            block.type in {BlockType.IMAGE, BlockType.EMBED}
            for block in blocks
        )
    ):
        warnings.append("incomplete-gallery")
    if (
        spec.publisher == "nyt"
        and _nyt_unhydrated_interactive_shell(
            soup,
            content_type=content_type,
            plain_text=plain_text,
            blocks=blocks,
            images=images,
        )
    ):
        warnings.append("incomplete-interactive")
    if not published_at:
        warnings.append("missing-published-at")
    if body is None:
        warnings.append("article-body-not-found")

    warnings = list(dict.fromkeys(warnings))
    status = ArticleStatus.COMPLETE
    if "article-body-not-found" in warnings:
        status = ArticleStatus.UNSUPPORTED
    elif (
        "body-too-short" in warnings
        or "missing-headline" in warnings
        or "truncated-body" in warnings
        or "incomplete-gallery" in warnings
        or "incomplete-interactive" in warnings
    ):
        status = ArticleStatus.PARTIAL

    capture_reference = _capture_reference(
        raw_capture=raw_capture,
        publisher=publisher,
        canonical_url=canonical_url,
    )
    parsed_at = parsed_at or datetime.now(timezone.utc)
    return JojoArticle(
        article_id=(
            raw_capture.article_id
            if raw_capture
            else stable_article_id(publisher, canonical_url)
        ),
        publisher=publisher,
        edition=spec.edition,
        canonical_url=canonical_url,
        language=language,
        content_type=content_type,
        section=section,
        headline=headline,
        description=description,
        authors=authors,
        published_at=published_at,
        modified_at=modified_at,
        plain_text=plain_text,
        body_html=body_html,
        blocks=blocks,
        images=images,
        source_capture=capture_reference,
        extraction=Extraction(
            parser=publisher,
            parser_version=spec.parser_version,
            parsed_at=parsed_at,
            source_capture_id=capture_reference.capture_id,
        ),
        quality=Quality(
            status=status,
            body_characters=len(plain_text),
            block_count=len(blocks),
            images_referenced=len(images),
            images_selected=sum(image.should_archive for image in images),
            warnings=warnings,
        ),
    )


def _is_yahoo_syndication(
    soup: BeautifulSoup,
    *,
    raw_capture: RawCapture | None,
) -> bool:
    if raw_capture is not None:
        host = (urlsplit(raw_capture.final_url).hostname or "").casefold()
        if host == "yahoo.com" or host.endswith(".yahoo.com"):
            return True
    site_name = _meta_content(soup, "property", "og:site_name")
    return bool(site_name and "yahoo" in site_name.casefold())


def _yahoo_syndication_body(
    soup: BeautifulSoup,
    *,
    stop_at_reporting_by: bool,
) -> Tag | None:
    primary_article = soup.select_one("article")
    if primary_article is None:
        return None
    paragraphs = [
        paragraph
        for paragraph in primary_article.select("p")
        if paragraph.find_parent("article") is primary_article
    ]
    if not paragraphs:
        return None
    wrapper_document = BeautifulSoup(
        "<div data-jojo-source='yahoo-syndication'></div>",
        "html.parser",
    )
    wrapper = wrapper_document.select_one("div")
    if wrapper is None:
        return None
    skipping_bloomberg_most_read = False
    for paragraph in paragraphs:
        paragraph_text = _clean_text(paragraph.get_text(" ", strip=True))
        if paragraph_text.casefold() in {
            "most read from bloomberg",
            "most read from bloomberg businessweek",
        }:
            skipping_bloomberg_most_read = True
            continue
        if skipping_bloomberg_most_read:
            if paragraph.find_parent(("ul", "ol")) is not None:
                continue
            skipping_bloomberg_most_read = False
        ancestor_classes = " ".join(
            " ".join(parent.get("class", []))
            for parent in paragraph.parents
            if isinstance(parent, Tag)
        ).casefold()
        if (
            paragraph.find_parent(("header", "button", "nav", "footer"))
            or paragraph.select_one("button") is not None
            or any(
                marker in ancestor_classes
                for marker in ("key-takeaway", "yahoo-scout")
            )
        ):
            continue
        copy = BeautifulSoup(str(paragraph), "html.parser").select_one("p")
        if copy is not None:
            wrapper.append(copy)
        if stop_at_reporting_by and re.match(
            r"^\s*\((?:additional )?reporting by\b",
            paragraph_text,
            re.IGNORECASE,
        ):
            break
    return wrapper if wrapper.select_one("p") is not None else None


def _generic_syndication_body(soup: BeautifulSoup) -> Tag | None:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    partner_hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if (
        partner_hostname == "mql5.com"
        or partner_hostname.endswith(".mql5.com")
    ):
        # MQL5 wraps navigation, recommendations, and both sidebars in the
        # outer article element. Only this nested content node is the
        # syndicated report.
        node = soup.select_one(
            ".postContent.view > .container > .content"
        )
        if isinstance(node, Tag):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.select_one(".content")
            if isinstance(copy, Tag) and len(
                _clean_text(copy.get_text(" ", strip=True))
            ) >= _MINIMUM_SYNDICATED_BODY_CHARACTERS:
                for link in list(copy.select("a[href*='/signals/']")):
                    link.decompose()
                # MQL5 stores each prose paragraph as a direct child ``div``.
                # Normalize those nodes so the common block extractor keeps
                # their text and any inline article image.
                for child in copy.find_all("div", recursive=False):
                    child.name = "p"
                return copy
    if (
        partner_hostname == "investinglive.com"
        or partner_hostname.endswith(".investinglive.com")
    ):
        # Migrated InvestingLive URLs can retain the historical headline and
        # publication date while omitting the old article body entirely. The
        # remaining ``article`` element is then only current "Most Popular"
        # and broker-advertising chrome, which must not be accepted as the
        # Bloomberg report.
        for node in soup.select(
            "[class*='articleContent' i], [class*='expandedContent' i]"
        ):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.find(node.name)
            if not isinstance(copy, Tag):
                continue
            paragraphs = [
                _clean_text(paragraph.get_text(" ", strip=True))
                for paragraph in copy.select("p")
            ]
            if (
                len([value for value in paragraphs if value]) >= 2
                and sum(len(value) for value in paragraphs)
                >= _MINIMUM_SYNDICATED_BODY_CHARACTERS
            ):
                return copy
        placeholder = BeautifulSoup(
            "<div data-jojo-source='investinglive-empty-migration'></div>",
            "html.parser",
        )
        return placeholder.div
    selectors = (
        "[itemprop='articleBody']",
        ".news__body__center__article",
        ".article-text",
        ".post-content",
        ".article-content",
        ".entry-content",
        ".article-body",
        ".story-body",
        "[class*='article-body' i]",
        "[class*='story-body' i]",
        "article",
        "main",
    )
    for selector in selectors:
        for node in soup.select(selector):
            document = BeautifulSoup(str(node), "html.parser")
            copy = document.select_one(selector)
            if copy is None:
                copy = document.find(node.name)
            if not isinstance(copy, Tag):
                continue
            if (
                partner_hostname == "blogspot.com"
                or partner_hostname.endswith(".blogspot.com")
            ):
                # Blogger permits substantive prose as a direct text node
                # after a blockquote. The common block extractor intentionally
                # ignores loose text, so normalize only substantial direct
                # nodes into paragraphs before extracting the licensed copy.
                for child in list(copy.children):
                    if not isinstance(child, NavigableString):
                        continue
                    if len(_clean_text(str(child))) < 40:
                        continue
                    paragraph = document.new_tag("p")
                    child.wrap(paragraph)
            for noise in copy.select(
                "aside, header, nav, footer, form, button, "
                "[class*='recommend' i], [class*='related' i], "
                "[class*='newsletter' i], [class*='advert' i], "
                "[class*='subscription' i], [class*='get-app' i], "
                "[class*='whatsapp-group' i], "
                "[class*='content-loader' i], .lazy-widgets, "
                ".watchOrListen-bottom-section-v3, .liveEventMain_widget, "
                ".primeSWrapper, .ts-dots, .bottomTopics, "
                ".topicListContainer, .topicListTitle, .tags, "
                "[id^='views-bootstrap-article-node-view-block-'], "
                "[data-animation-role='button'], "
                "[data-content-field='tags']"
            ):
                noise.decompose()
            for control in list(copy.select("[role='button']")):
                if control.name == "a" and control.select_one("img") is not None:
                    control.unwrap()
                else:
                    control.decompose()
            _remove_generic_syndication_partner_noise(
                copy,
                source_document=soup,
            )
            paragraphs = [
                _clean_text(paragraph.get_text(" ", strip=True))
                for paragraph in copy.select("p")
            ]
            body_characters = sum(
                len(paragraph) for paragraph in paragraphs if paragraph
            )
            if len([value for value in paragraphs if value]) >= 2 and (
                body_characters
                >= _MINIMUM_SYNDICATED_BODY_CHARACTERS
            ):
                return copy
    return None


def _remove_generic_syndication_partner_noise(
    body: Tag,
    *,
    source_document: BeautifulSoup,
) -> None:
    """Remove partner-site recirculation without trimming licensed copy."""
    partner_url = _first_text(
        _meta_content(source_document, "property", "og:url"),
        _tag_attribute(
            source_document.select_one("link[rel='canonical']"),
            "href",
        ),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "mediapart.fr" or hostname.endswith(".mediapart.fr"):
        for node in list(body.select("p")):
            text = _clean_text(node.get_text(" ", strip=True))
            if re.match(
                r"(?i)^read more of this bloomberg report "
                r"published by the\b",
                text,
            ):
                node.decompose()
    if hostname == "euro2day.gr" or hostname.endswith(".euro2day.gr"):
        # Euro2day's FT republication wraps the licensed review in a broad
        # ``.article-content`` node that also contains the site's popular/
        # commented sidebar, ad slots, social controls, and a copyright logo.
        # Keep the nested article prose and publication line, but discard
        # those partner-owned modules before block and image extraction.
        for node in list(
            body.select(
                ".sidebar, #cpContent_pnlCopyright, #cpContent_pnlFTsponsor, "
                ".article-socail-bar-comments, .social-bottom, .bnrwrp, "
                ".adsbygoogle, .comments, .e2ddiscover, .thumbnail"
            )
        ):
            node.decompose()
    if (
        hostname == "eco-business.com"
        or hostname.endswith(".eco-business.com")
    ):
        # Eco-Business places its membership CTA inside the article section,
        # immediately after licensed Bloomberg copy. Its class names only
        # refer to the site's "circle" program, not an advertisement.
        for node in list(body.select(".eb-article__eb-circle-banner")):
            node.decompose()
    if (
        hostname == "insurancejournal.com"
        or hostname.endswith(".insurancejournal.com")
    ):
        # Insurance Journal nests article tags and an in-content subscription
        # card inside the same entry-content element as licensed copy.
        for node in list(
            body.select(
                "p.tagtag, .subscribe-banner, "
                "[class*='subscribe-banner' i]"
            )
        ):
            node.decompose()
    if hostname == "linkedin.com" or hostname.endswith(".linkedin.com"):
        for node in list(body.select("section.comment, .comment__body")):
            node.decompose()
        for node in list(body.select("p, li")):
            text = _clean_text(node.get_text(" ", strip=True))
            if (
                "full article below" in text.casefold()
                and "read more from bloomberg news" in text.casefold()
            ):
                node.decompose()
                continue
            if re.fullmatch(r"[\d,.]+\s+followers?", text, re.IGNORECASE):
                node.decompose()
                continue
            if text.casefold() == "report this post":
                node.decompose()
                continue
            hashtag = re.search(r"\s+#[\w-]+", text)
            if hashtag is None or len(re.findall(r"#[\w-]+", text)) < 5:
                continue
            cleaned = text[:hashtag.start()].rstrip()
            if cleaned.startswith('"') and '" "' in cleaned:
                cleaned = cleaned.split('" "', 1)[0]
            cleaned = cleaned.strip().strip('"').strip()
            if cleaned:
                node.clear()
                node.string = cleaned
            else:
                node.decompose()
    if hostname == "benzinga.com" or hostname.endswith(".benzinga.com"):
        marker = next(
            (
                node
                for node in body.select("p, h2, h3, h4")
                if re.match(
                    r"(?i)^(?:see also|read next)\s*:",
                    _clean_text(node.get_text(" ", strip=True)),
                )
            ),
            None,
        )
        if isinstance(marker, Tag):
            tail = marker
            while isinstance(tail.parent, Tag):
                for sibling in list(tail.next_siblings):
                    if isinstance(sibling, Tag):
                        sibling.decompose()
                    else:
                        sibling.extract()
                if tail.parent is body:
                    break
                tail = tail.parent
            marker.decompose()
    if hostname == "newsbreak.com" or hostname.endswith(".newsbreak.com"):
        for card in list(body.select("section")):
            link = card.select_one("a[href][target='_blank']")
            if (
                isinstance(link, Tag)
                and card.select_one("p.textoverflow-3") is not None
            ):
                card.decompose()
    if hostname == "ctrmcenter.com" or hostname.endswith(".ctrmcenter.com"):
        # CTRM Center appends its own republication disclaimer inside the
        # article element, after the licensed Bloomberg copy. It is partner
        # chrome rather than reporting and therefore survives generic footer
        # selectors unless removed explicitly.
        for node in list(body.select(".cat_postinfo, .postinfo, span.bio")):
            text = _clean_text(node.get_text(" ", strip=True)).casefold()
            if (
                "republished on the ctrm center" in text
                and "if you have any issue with this post" in text
            ):
                node.decompose()
    if hostname == "biasly.com" or hostname.endswith(".biasly.com"):
        body.clear()
        return
    if (
        hostname == "bnnbloomberg.ca"
        or hostname.endswith(".bnnbloomberg.ca")
    ):
        for node in list(body.select("p, li, ul, ol")):
            text = _clean_text(node.get_text(" ", strip=True)).casefold()
            if text == "latest updates on company news here":
                node.decompose()
    if (
        hostname == "marketscreener.com"
        or hostname.endswith(".marketscreener.com")
        or hostname == "zonebourse.com"
        or hostname.endswith(".zonebourse.com")
    ):
        for node in list(body.select("p")):
            text = _clean_text(node.get_text(" ", strip=True))
            if not re.fullmatch(r"[.,;:!?]+", text):
                continue
            previous = node.find_previous_sibling("p")
            if not isinstance(previous, Tag):
                node.decompose()
                continue
            previous_text = _clean_text(
                previous.get_text(" ", strip=True)
            ).rstrip()
            previous.clear()
            previous.append(f"{previous_text}{text}")
            node.decompose()


def _postmedia_syndication_body(soup: BeautifulSoup) -> Tag | None:
    """Join Postmedia's paragraph-per-section body without page widgets."""
    paragraphs = soup.select(
        "article.story-v2-article-content-story "
        ".story-v2-content-element-inline > p"
    )
    substantive = [
        paragraph
        for paragraph in paragraphs
        if _clean_text(paragraph.get_text(" ", strip=True))
    ]
    if len(substantive) < 2 or sum(
        len(_clean_text(paragraph.get_text(" ", strip=True)))
        for paragraph in substantive
    ) < _MINIMUM_SYNDICATED_BODY_CHARACTERS:
        return None
    document = BeautifulSoup(
        "<div data-jojo-source='postmedia-syndication'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if not isinstance(wrapper, Tag):
        return None
    for paragraph in substantive:
        copy = BeautifulSoup(str(paragraph), "html.parser").select_one("p")
        if isinstance(copy, Tag):
            wrapper.append(copy)
    return wrapper


def _newsbreak_syndication_body(soup: BeautifulSoup) -> Tag | None:
    """Recover the licensed article payload without NewsBreak feed cards."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    if not partner_url or "newsbreak.com/" not in partner_url.casefold():
        return None
    script = soup.select_one("script#__NEXT_DATA__")
    if not isinstance(script, Tag):
        return None
    try:
        payload = json.loads(script.string or script.get_text())
    except (json.JSONDecodeError, TypeError):
        return None
    page = payload.get("props", {}).get("pageProps", {})
    content = page.get("content")
    authors = page.get("authors", [])
    if (
        not isinstance(content, str)
        or "bloomberg" not in " ".join(map(str, authors)).casefold()
    ):
        return None
    document = BeautifulSoup(content, "html.parser")
    body = document.body or document.find()
    if not isinstance(body, Tag):
        return None
    if len(_clean_text(body.get_text(" ", strip=True))) < 300:
        return None
    return body


def _wsj_tovima_body(soup: BeautifulSoup) -> Tag | None:
    """Select only the licensed WSJ copy from To Vima partner pages."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    if not partner_url or "tovima.com/" not in partner_url.casefold():
        return None
    body = soup.select_one(".post-body.main-content, .post-body.article-wrapper")
    return body if isinstance(body, Tag) else None


def _bloomberg_partner_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    partner_host = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if (
        partner_host == "johnlothiannews.com"
        or partner_host.endswith(".johnlothiannews.com")
    ):
        slug = urlsplit(canonical_url).path.rstrip("/").rsplit("/", 1)[-1]
        target_tokens = {
            token
            for token in re.findall(r"[a-z0-9]+", slug.casefold())
            if not token.isdigit()
        }
        best: tuple[float, Tag] | None = None
        for paragraph in soup.select(".entry-content > p"):
            title = paragraph.select_one(":scope > strong")
            if not isinstance(title, Tag):
                continue
            title_tokens = set(
                re.findall(
                    r"[a-z0-9]+",
                    _clean_text(title.get_text(" ", strip=True)).casefold(),
                )
            )
            if not target_tokens or not title_tokens:
                continue
            score = len(target_tokens & title_tokens) / len(
                target_tokens | title_tokens
            )
            if best is None or score > best[0]:
                best = (score, paragraph)
        if best is not None and best[0] >= 0.75:
            paragraph = best[1]
            title = paragraph.select_one(":scope > strong")
            if isinstance(title, Tag):
                title.decompose()
            for line_break in list(paragraph.select("br")):
                line_break.replace_with("\n")
            lines = [
                _clean_text(line)
                for line in paragraph.get_text("\n", strip=True).splitlines()
                if _clean_text(line)
            ]
            reporting = [
                line
                for line in lines
                if line.casefold() != "bloomberg"
                and not re.fullmatch(r"https?://\S+", line)
            ]
            if reporting:
                document = BeautifulSoup(
                    "<article><p></p></article>",
                    "html.parser",
                )
                body = document.select_one("article")
                output = document.select_one("p")
                if isinstance(body, Tag) and isinstance(output, Tag):
                    output.string = " ".join(reporting)
                    return body
    if (
        partner_host == "arabamerica.com"
        or partner_host.endswith(".arabamerica.com")
    ):
        # Arab America places its navigation, audio player, trivia, poll, and
        # footer before the licensed article inside the page-level ``main``.
        # The print node contains only the syndicated report and its byline.
        source_body = soup.select_one(".content.single .content-in > .print")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            arabamerica_body = document.select_one(".print")
            if isinstance(arabamerica_body, Tag):
                arabamerica_body["data-jojo-source"] = (
                    "bloomberg-arabamerica-syndication"
                )
                for noise in list(
                    arabamerica_body.select(
                        ".mailmunch-forms-before-post, "
                        ".mailmunch-forms-after-post, .paginationx"
                    )
                ):
                    noise.decompose()
                if len(arabamerica_body.select("p")) >= 2:
                    return arabamerica_body
    if (
        partner_host == "macdailynews.com"
        or partner_host.endswith(".macdailynews.com")
    ):
        source_body = soup.select_one(".entry-content")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            macdailynews_body = document.select_one(".entry-content")
            if isinstance(macdailynews_body, Tag):
                truncate = False
                for child in list(macdailynews_body.children):
                    if not isinstance(child, Tag):
                        continue
                    if truncate:
                        child.decompose()
                        continue
                    text = _clean_text(child.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^read more in the full article here\b",
                        text,
                    ):
                        truncate = True
                        child.decompose()
                if len(macdailynews_body.select("p")) >= 2:
                    return macdailynews_body
    if (
        partner_host == "moneyweb.co.za"
        or partner_host.endswith(".moneyweb.co.za")
    ):
        source_body = soup.select_one("#storybody")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            moneyweb_body = document.select_one("#storybody")
            if isinstance(moneyweb_body, Tag):
                for node in list(moneyweb_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.fullmatch(
                        r"(?i)(?:©|\(c\)|copyright)\s*\d{4}\s+"
                        r"bloomberg(?:\s+news|\s+l\.?p\.?)?\.?",
                        text,
                    ):
                        node.decompose()
                if len(moneyweb_body.select("p")) >= 2:
                    return moneyweb_body
    if (
        partner_host == "esmmagazine.com"
        or partner_host.endswith(".esmmagazine.com")
    ):
        # The outer ESM ``article`` also contains tags and a recommended
        # reading rail. The nested article is the licensed Bloomberg copy.
        source_body = soup.select_one(".article__content > article")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            esm_body = document.select_one("article")
            if isinstance(esm_body, Tag):
                for node in list(esm_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^(?:news by bloomberg|bloomberg news)\s*,?\s*"
                        r"edited by esm\b",
                        text,
                    ):
                        node.decompose()
                if len(esm_body.select("p")) >= 2:
                    return esm_body
    if (
        partner_host == "mediapart.fr"
        or partner_host.endswith(".mediapart.fr")
    ):
        source_body = soup.select_one(".news__body__center__article")
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            mediapart_body = document.select_one(
                ".news__body__center__article"
            )
            if isinstance(mediapart_body, Tag):
                for duplicate_visual_text in list(
                    mediapart_body.select(
                        ".dropcap-wrapper > [aria-hidden='true']"
                    )
                ):
                    duplicate_visual_text.decompose()
                for node in list(mediapart_body.select("p")):
                    text = _clean_text(node.get_text(" ", strip=True))
                    if re.match(
                        r"(?i)^read more of this bloomberg report "
                        r"published by the\b",
                        text,
                    ):
                        node.decompose()
                if len(mediapart_body.select("p")) >= 2:
                    return mediapart_body
    if (
        partner_host == "parcelindustry.com"
        or partner_host.endswith(".parcelindustry.com")
    ):
        parcel_body = soup.select_one(
            "article.article .fulltext-txt, article.article #contentText"
        )
        if isinstance(parcel_body, Tag):
            teaser = re.sub(
                r"\s+Read more\s*!?\s*$",
                "",
                _clean_text(parcel_body.get_text(" ", strip=True)),
                flags=re.IGNORECASE,
            )
            document = BeautifulSoup("<article><p></p></article>", "html.parser")
            paragraph = document.select_one("p")
            article = document.select_one("article")
            if isinstance(paragraph, Tag) and isinstance(article, Tag):
                paragraph.string = teaser
                return article

    if (
        partner_host == "pv-magazine.com"
        or partner_host.endswith(".pv-magazine.com")
    ):
        pv_magazine_body = soup.select_one(".pvmagazine-post-content")
        if isinstance(pv_magazine_body, Tag):
            return pv_magazine_body
    if (
        partner_host == "eco-business.com"
        or partner_host.endswith(".eco-business.com")
    ):
        source_body = soup.select_one(
            ".eb-article__body-content"
        )
        if isinstance(source_body, Tag):
            document = BeautifulSoup(str(source_body), "html.parser")
            eco_business_body = document.select_one(
                ".eb-article__body-content"
            )
            if isinstance(eco_business_body, Tag):
                for node in list(
                    eco_business_body.select(
                        ".eb-article__eb-circle-banner"
                    )
                ):
                    node.decompose()
                return eco_business_body

    for node in soup.select("[class*='storyContent' i]"):
        paragraphs = [
            _clean_text(paragraph.get_text(" ", strip=True))
            for paragraph in node.select("p")
        ]
        substantial = [value for value in paragraphs if value]
        if (
            len(substantial) >= 2
            and sum(len(value) for value in substantial)
            >= _MINIMUM_SYNDICATED_BODY_CHARACTERS
        ):
            return node
    return None


def _bloomberg_parcel_industry_teaser(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "parcelindustry.com"
        or hostname.endswith(".parcelindustry.com")
    ):
        return False
    return any(
        _tag_text(anchor).casefold() == "read more"
        for anchor in soup.select(
            "article.article .fulltext-txt a, article.article #contentText a"
        )
    )


def _bloomberg_pv_magazine_teaser(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "pv-magazine.com"
        or hostname.endswith(".pv-magazine.com")
    ):
        return False
    body = soup.select_one(".pvmagazine-post-content")
    if not isinstance(body, Tag):
        return False
    text = _clean_text(body.get_text(" ", strip=True))
    return bool(
        re.search(
            r"\bclick\s+here\s+to\s+read\s+the\s+(?:rest|full\s+story)\b",
            text,
            re.IGNORECASE,
        )
    )


def _bloomberg_partner_full_story_teaser(soup: BeautifulSoup) -> bool:
    """Recognize partner copies that explicitly link to Bloomberg for the rest."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "mediapart.fr" or hostname.endswith(".mediapart.fr"):
        if any(
            re.match(
                r"(?i)^read more of this bloomberg report "
                r"published by the\b",
                _clean_text(node.get_text(" ", strip=True)),
            )
            for node in soup.select(
                ".news__body__center__article p, "
                "[itemprop='articleBody'] p"
            )
        ):
            return True
    for node in soup.select("p, div"):
        text = _clean_text(node.get_text(" ", strip=True))
        explicit_full_story = re.match(
            r"(?i)^(?:"
            r"click\s+here\s+to\s+read\s+the\s+full\s+story|"
            r"read\s+(?:the\s+)?full\s+article\s+here\s+"
            r"(?:via|at|on)\s+bloomberg"
            r")\b",
            text,
        )
        excerpt_read_more = re.search(
            r"(?i)\bread\s+more\s+at\s+bloomberg\s*\.?\s*$",
            text,
        )
        if not explicit_full_story and not excerpt_read_more:
            continue
        if any(
            "bloomberg.com/" in str(anchor.get("href") or "").casefold()
            for anchor in node.select("a[href]")
        ):
            return True
    return False


def _bloomberg_macdailynews_excerpt(soup: BeautifulSoup) -> bool:
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if not (
        hostname == "macdailynews.com"
        or hostname.endswith(".macdailynews.com")
    ):
        return False
    return any(
        re.match(
            r"(?i)^read more in the full article here\b",
            _clean_text(node.get_text(" ", strip=True)),
        )
        for node in soup.select(".entry-content > p")
    )


def _bloomberg_origin_abrupt_quote_truncation(
    soup: BeautifulSoup,
) -> bool:
    """Detect archived Bloomberg bodies cut off inside their final quote."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for body in soup.select(
        ".body-copy-v2, .body-copy, .article-body__content, "
        "[data-component='article-body']"
    ):
        if body.select_one(".terminal-tout, .terminal-tout-v2") is None:
            continue
        paragraphs = body.select("p")
        if not paragraphs:
            continue
        tail = _clean_text(paragraphs[-1].get_text(" ", strip=True))
        if (
            len(tail) >= 80
            and tail.startswith("“")
            and tail.count("“") > tail.count("”")
        ):
            return True
    return False


def _bloomberg_origin_incomplete_for_more_tail(
    soup: BeautifulSoup,
) -> bool:
    """Detect legacy Bloomberg pages cut mid-sentence before a nav link."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for marker in soup.select("p"):
        if not re.fullmatch(
            r"For more,\s*click here\s*\.?",
            _clean_text(marker.get_text(" ", strip=True)),
            re.IGNORECASE,
        ):
            continue
        previous = marker.find_previous_sibling("p")
        if not isinstance(previous, Tag):
            continue
        tail = _clean_text(previous.get_text(" ", strip=True))
        if (
            len(tail) >= 30
            and len(re.findall(r"\b[\w’'-]+\b", tail)) >= 6
            and not re.search(r"""[.!?…:;)"'’”\]]$""", tail)
        ):
            return True
    return False


def _bloomberg_origin_trailing_heading_truncation(
    soup: BeautifulSoup,
) -> bool:
    """Detect an archived Bloomberg body ending at a section heading."""
    page_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(page_url).hostname or "").casefold()
        if page_url
        else ""
    )
    if not (
        hostname == "bloomberg.com"
        or hostname.endswith(".bloomberg.com")
    ):
        return False
    for body in soup.select(
        ".body-copy-v2, .body-copy, .article-body__content, "
        "[data-component='article-body']"
    ):
        meaningful = [
            child
            for child in body.find_all(recursive=False)
            if isinstance(child, Tag)
            and _clean_text(child.get_text(" ", strip=True))
        ]
        if not meaningful:
            continue
        while meaningful and (
            "terminal-tout" in (meaningful[-1].get("class") or [])
            or "terminal-tout-v2" in (meaningful[-1].get("class") or [])
        ):
            meaningful.pop()
        if meaningful and meaningful[-1].name in {
            "h1", "h2", "h3", "h4", "h5", "h6"
        }:
            return True
    return False


def _bloomberg_short_source_link_excerpt(
    soup: BeautifulSoup,
    *,
    plain_text: str,
) -> bool:
    """Recognize short partner summaries that only point to Bloomberg."""
    if len(plain_text) >= 1_000:
        return False
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    if hostname == "bloomberg.com" or hostname.endswith(".bloomberg.com"):
        return False
    if any(
        re.search(
            r"(?i)bloomberg\.com/(?:news/)?(?:articles/)?\d{4}-\d{2}-\d{2}/",
            str(anchor.get("href") or ""),
        )
        for anchor in soup.select("a[href]")
    ):
        return True
    return bool(
        re.search(
            r"(?im)^https?://(?:www\.)?bloomberg\.com/"
            r"(?:news/)?(?:articles/)?\d{4}-\d{2}-\d{2}/\S+\s*$",
            plain_text,
        )
    )


def _bloomberg_embedded_article_body(soup: BeautifulSoup) -> Tag | None:
    candidates: list[Tag] = []
    for script in soup.select('script[type="application/json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _walk_json_objects(payload):
            document = item.get("body")
            if (
                not isinstance(document, dict)
                or document.get("type") != "document"
            ):
                continue
            rendered = _render_bloomberg_document(document)
            if rendered is not None:
                candidates.append(rendered)
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda node: len(node.get_text(" ", strip=True)),
    )


def _bloomberg_feature_landing_body(soup: BeautifulSoup) -> Tag | None:
    """Recover stories and editorial indexes from legacy feature templates."""
    story = soup.select_one(
        ".dvz-page-wrapper.dvz-feature .feature-wrapper"
    )
    if isinstance(story, Tag):
        paragraphs = [
            _clean_text(paragraph.get_text(" ", strip=True))
            for paragraph in story.select("p")
        ]
        substantive = [text for text in paragraphs if text]
        if (
            len(substantive) >= 3
            and sum(len(text) for text in substantive) >= 700
        ):
            return story

    container = soup.select_one(".dvz-content2")
    if not isinstance(container, Tag):
        return None
    intro = container.select_one(".intro, .introWrap")
    index = container.select_one(".index, .grid")
    if (
        not isinstance(intro, Tag)
        or len(_clean_text(intro.get_text(" ", strip=True))) < 300
        or not isinstance(index, Tag)
        or len(index.select("a[href]")) < 3
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = _clean_text(intro.get_text(" ", strip=True))
    article.append(paragraph)
    seen_headings: set[str] = set()
    for anchor in index.select("a[href]"):
        text = _tag_text(anchor)
        if not text or text.casefold() in seen_headings:
            continue
        seen_headings.add(text.casefold())
        heading = document.new_tag("h2")
        heading.string = text
        article.append(heading)
    seen_images: set[str] = set()
    for source_image in container.select("img[src]"):
        source = _tag_attribute(source_image, "src")
        if not source:
            continue
        identity = _image_identity(source)
        if identity in seen_images:
            continue
        seen_images.add(identity)
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = source
        alt = _tag_attribute(source_image, "alt")
        if alt:
            image["alt"] = alt
        figure.append(image)
        article.append(figure)
    return article


def _bloomberg_embedded_quiz_body(soup: BeautifulSoup) -> Tag | None:
    container = soup.select_one("#quiz-container")
    if not isinstance(container, Tag):
        return None
    questions = container.select("section.question[id^='Q']")
    if len(questions) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen_images: set[str] = set()
    for question in questions:
        identifier = _string_or_none(question.get("id"))
        prompt = _tag_text(question.select_one(":scope > h2"))
        options = [
            text
            for option in question.select(
                ":scope > ol.quiz-answers > li"
            )
            if (text := _tag_text(option))
        ]
        if not prompt or len(options) < 2:
            continue
        heading = document.new_tag("h2")
        heading.string = prompt
        article.append(heading)
        image = question.select_one(".quiz-question img[src]")
        if isinstance(image, Tag):
            source = _string_or_none(image.get("src"))
            if source and _image_identity(source) not in seen_images:
                seen_images.add(_image_identity(source))
                figure = document.new_tag("figure")
                image_copy = document.new_tag("img")
                image_copy["src"] = source
                caption = _tag_text(
                    question.select_one(".quiz-question .captionline")
                )
                if caption:
                    image_copy["alt"] = caption
                figure.append(image_copy)
                credit = _tag_text(
                    question.select_one(".quiz-question .creditline")
                )
                if caption or credit:
                    figcaption = document.new_tag("figcaption")
                    figcaption.string = " ".join(
                        value for value in (caption, credit) if value
                    )
                    figure.append(figcaption)
                article.append(figure)
        option_list = document.new_tag("ul")
        for option in options:
            item = document.new_tag("li")
            item.string = option
            option_list.append(item)
        article.append(option_list)
        answer = (
            container.select_one(f"section.answer#A{identifier[1:]}")
            if identifier and identifier[1:].isdigit()
            else None
        )
        if isinstance(answer, Tag):
            explanations = [
                (len(text), text)
                for node in answer.find_all("div", recursive=False)
                if (
                    "navbuttons" not in (node.get("class") or [])
                    and "thisresult" not in (node.get("class") or [])
                    and (text := _tag_text(node))
                )
            ]
            if explanations:
                explanation = document.new_tag("p")
                explanation.string = max(explanations)[1]
                article.append(explanation)
    return (
        article
        if len(article.select("h2")) >= 3
        and len(_clean_text(article.get_text(" ", strip=True))) >= 500
        else None
    )


def _render_bloomberg_document(document: dict[str, Any]) -> Tag | None:
    parsed = BeautifulSoup(
        "<div data-jojo-source='bloomberg-embedded-body'></div>",
        "html.parser",
    )
    wrapper = parsed.select_one("div")
    if wrapper is None:
        return None

    def text_content(value: object) -> str:
        if isinstance(value, dict):
            if value.get("type") == "text":
                return _string_or_none(value.get("value")) or ""
            children = value.get("content")
            if not isinstance(children, list):
                return ""
            return "".join(
                text_content(child) for child in children
            )
        if isinstance(value, list):
            return "".join(text_content(child) for child in value)
        return ""

    for block in document.get("content", []):
        if not isinstance(block, dict):
            continue
        block_type = _string_or_none(block.get("type")) or ""
        text = _clean_text(text_content(block))
        if block_type in {"paragraph", "blockquote"} and text:
            tag = parsed.new_tag("blockquote" if block_type == "blockquote" else "p")
            tag.string = text
            wrapper.append(tag)
        elif block_type == "heading" and text:
            level = block.get("data", {}).get("level", 2)
            level = level if isinstance(level, int) and 2 <= level <= 6 else 2
            tag = parsed.new_tag(f"h{level}")
            tag.string = text
            wrapper.append(tag)
        elif block_type in {"list", "unordered-list", "ordered-list"}:
            items = [
                _clean_text(text_content(child))
                for child in block.get("content", [])
                if isinstance(child, dict)
            ]
            items = [item for item in items if item]
            if items:
                list_tag = parsed.new_tag(
                    "ol" if block_type == "ordered-list" else "ul"
                )
                for item in items:
                    item_tag = parsed.new_tag("li")
                    item_tag.string = item
                    list_tag.append(item_tag)
                wrapper.append(list_tag)
        elif block_type == "tabularData":
            table = parsed.new_tag("table")
            definitions: list[dict[str, Any]] = []
            rows: list[dict[str, Any]] = []
            for child in block.get("content", []):
                if not isinstance(child, dict):
                    continue
                if child.get("type") == "columns":
                    data = child.get("data")
                    if isinstance(data, dict) and isinstance(
                        data.get("definitions"),
                        list,
                    ):
                        definitions = [
                            value
                            for value in data["definitions"]
                            if isinstance(value, dict)
                        ]
                elif child.get("type") == "row":
                    rows.append(child)
            if definitions:
                thead = parsed.new_tag("thead")
                heading_row = parsed.new_tag("tr")
                for definition in definitions:
                    cell = parsed.new_tag("th")
                    cell.string = (
                        _string_or_none(definition.get("title")) or ""
                    )
                    heading_row.append(cell)
                thead.append(heading_row)
                table.append(thead)
            if rows:
                tbody = parsed.new_tag("tbody")
                for row in rows:
                    row_tag = parsed.new_tag("tr")
                    for source_cell in row.get("content", []):
                        if not isinstance(source_cell, dict):
                            continue
                        cell = parsed.new_tag("td")
                        cell.string = _clean_text(text_content(source_cell))
                        row_tag.append(cell)
                    if row_tag.select_one("td") is not None:
                        tbody.append(row_tag)
                if tbody.select_one("tr") is not None:
                    table.append(tbody)
            if table.select_one("tr") is not None:
                wrapper.append(table)

        for child in _walk_json_objects(block):
            if child.get("type") == "embed":
                embed_url = _first_text(
                    _string_or_none(child.get("href")),
                    _string_or_none(
                        (child.get("iframeData") or {}).get("url")
                    )
                    if isinstance(child.get("iframeData"), dict)
                    else None,
                )
                if embed_url:
                    iframe = parsed.new_tag("iframe", src=embed_url)
                    wrapper.append(iframe)
            if child.get("type") == "media":
                data = child.get("data")
                if not isinstance(data, dict):
                    continue
                video = data.get("video")
                if isinstance(video, dict):
                    source = _string_or_none(video.get("src"))
                    if source:
                        iframe = parsed.new_tag("iframe", src=source)
                        wrapper.append(iframe)
    if wrapper.select_one(
        "p, h2, h3, h4, h5, h6, blockquote, ul, ol, table, iframe"
    ):
        return wrapper
    return None


def _capture_reference(
    *,
    raw_capture: RawCapture | None,
    publisher: str,
    canonical_url: str,
) -> CaptureReference:
    if raw_capture:
        candidate = raw_capture.selected_candidate
        timestamp = (
            candidate.captured_at.isoformat()
            if candidate.captured_at
            else "unknown"
        )
        return CaptureReference(
            capture_id=(
                f"{candidate.provider.value}:{timestamp}:"
                f"{raw_capture.raw_html.sha256[:16]}"
            ),
            provider=candidate.provider,
            snapshot_url=candidate.snapshot_url,
            captured_at=candidate.captured_at,
            raw_html=raw_capture.raw_html,
        )
    digest = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()[:16]
    return CaptureReference(
        capture_id=f"other:unknown:{digest}",
        provider=CaptureProvider.OTHER,
        snapshot_url=canonical_url,
    )


def _find_news_article_json(soup: BeautifulSoup) -> dict[str, Any]:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _walk_json_objects(payload):
            types = item.get("@type")
            if isinstance(types, str):
                types = [types]
            if isinstance(types, list) and any(
                value in {"NewsArticle", "Article", "ReportageNewsArticle"}
                for value in types
            ):
                return item
    return {}


def _find_video_object_json(soup: BeautifulSoup) -> dict[str, Any]:
    """Return the primary structured video package, when one is present."""

    for item in _json_ld_objects(soup):
        types = item.get("@type")
        if isinstance(types, str):
            types = [types]
        if isinstance(types, list) and "VideoObject" in types:
            return item
    return {}


def _walk_json_objects(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_json_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json_objects(child)


def _json_ld_objects(soup: BeautifulSoup) -> Iterable[dict[str, Any]]:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        yield from _walk_json_objects(payload)


def _select_body(soup: BeautifulSoup, spec: PublisherSpec) -> Tag | None:
    for selector in spec.body_selectors:
        nodes = [node for node in soup.select(selector) if isinstance(node, Tag)]
        if nodes:
            return max(nodes, key=lambda node: len(node.get_text(" ", strip=True)))
    return None


def _wsj_selected_body_is_comment(body: Tag) -> bool:
    """Return whether a generic WSJ body candidate is Livefyre discussion."""

    classes = {
        str(value).casefold() for value in body.get("class", [])
    }
    if any(value.startswith("fyre-comment") for value in classes):
        return True
    return bool(
        body.find_parent(id="livefyre-comment")
        or body.find_parent(
            attrs={"data-module-name": re.compile("livefyre", re.IGNORECASE)}
        )
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


def _nyt_story_body_companions(soup: BeautifulSoup) -> Tag | None:
    nodes = [
        node
        for node in soup.select(".StoryBodyCompanionColumn")
        if not any(
            isinstance(parent, Tag)
            and "StoryBodyCompanionColumn" in (parent.get("class") or [])
            for parent in node.parents
        )
    ]
    if not nodes:
        return None
    linked_slideshow: Tag | None = None
    is_linked_slideshow_intro = False
    if len(nodes) == 1:
        # The React-era layout usually emits one companion column per body
        # segment, but some archived 2017 pages put the entire article in a
        # single column. Requiring two columns makes those pages fall through
        # to unrelated EmbeddedInteractive state (often a later slideshow
        # injected into the snapshot). Accept a lone column only when it is
        # unmistakably substantive. NYT's legacy Front Burner desk sometimes
        # published a complete short item as one long paragraph, so requiring
        # two blocks would discard real editorial text.
        only = nodes[0]
        text = _clean_text(only.get_text(" ", strip=True))
        substantive_blocks = only.select("p, blockquote")
        linked_slideshow = soup.select_one(
            "article a[href*='/slideshow/']"
        )
        linked_slideshow_text = (
            _clean_text(linked_slideshow.get_text(" ", strip=True))
            if isinstance(linked_slideshow, Tag)
            else ""
        )
        is_linked_slideshow_intro = bool(
            len(text) >= 100
            and linked_slideshow is not None
            and re.search(
                r"(?i)(?:view\s+slide\s*show|\b\d+\s+photos?\b)",
                linked_slideshow_text,
            )
        )
        if not is_linked_slideshow_intro and (
            len(text) < 500 or not substantive_blocks
        ):
            return None
    document = BeautifulSoup(
        "<div data-jojo-source='nyt-story-companions'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if wrapper is None:
        return None
    for node in nodes:
        node_copy = BeautifulSoup(str(node), "html.parser").select_one(
            ".StoryBodyCompanionColumn"
        )
        if node_copy is not None:
            wrapper.append(node_copy)
    if is_linked_slideshow_intro and isinstance(linked_slideshow, Tag):
        slideshow_url = linked_slideshow.get("href")
        linked_figures = linked_slideshow.select("figure")
        if slideshow_url and linked_figures:
            slideshow_anchor = document.new_tag(
                "a",
                href=str(slideshow_url),
            )
            slideshow_anchor["data-jojo-linked-slideshow"] = "true"
            for figure in linked_figures:
                slideshow_anchor.append(copy.deepcopy(figure))
            wrapper.append(slideshow_anchor)
    return wrapper if wrapper.get_text(" ", strip=True) else None


def _nyt_legacy_article_body(soup: BeautifulSoup) -> Tag | None:
    is_legacy_recipe = any(
        _clean_text(str(marker.get("content") or "")).casefold() == "recipe"
        for marker in soup.select(
            "meta[name='PST'][content], meta[name='tom'][content]"
        )
    )
    recipe_nodes = (
        [
            node
            for node in soup.select("p[itemprop='articleBody']")
            if _clean_text(node.get_text(" ", strip=True))
        ]
        if is_legacy_recipe
        else []
    )
    # Some 2010--2012 recipe pages contain a mismatched closing ``div``
    # around their ingredient list.  HTML recovery moves the preparation
    # paragraphs outside ``.articleBody``, but NYT's itemprop annotation
    # still identifies every recipe paragraph.  Restrict this wider recovery
    # to pages explicitly marked as recipes so ordinary article chrome cannot
    # be promoted into the body.
    nodes = recipe_nodes or [
        node
        for node in soup.select(".articleBody, #articleBody")
        if not any(
            isinstance(parent, Tag)
            and (
                "articleBody" in (parent.get("class") or [])
                or parent.get("id") == "articleBody"
            )
            for parent in node.parents
        )
    ]
    if not nodes:
        primary_nodes = [
            node
            for node in soup.select(
            "article.story.theme-main .story-body, "
            "article#story .story-body"
            )
            if not any(
                isinstance(parent, Tag)
                and "story-body" in (parent.get("class") or [])
                for parent in node.parents
            )
        ]
        if not primary_nodes:
            return None
        nodes = [
            node
            for primary in primary_nodes
            for node in primary.select(
                ".story-content, [itemprop='articleBody'], "
                "figure[itemprop='associatedMedia']"
                ":has(img[itemprop='url'][src])"
            )
            if not any(
                isinstance(parent, Tag)
                and parent is not primary
                and (
                    "story-content" in (parent.get("class") or [])
                    or parent.get("itemprop") == "articleBody"
                    or parent.get("itemprop") == "associatedMedia"
                )
                for parent in node.parents
            )
        ]
        if not nodes:
            nodes = [
                primary
                for primary in primary_nodes
                if primary.select_one("p, figure, table")
            ]
        if not nodes:
            return None
    document = BeautifulSoup(
        "<div data-jojo-source='nyt-legacy-article-body'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if wrapper is None:
        return None
    for node in nodes:
        copy = BeautifulSoup(str(node), "html.parser").find()
        if copy is not None:
            wrapper.append(copy)
    return wrapper if wrapper.select_one(
        '[itemprop="articleBody"], .story-content, p'
    ) else None


def _nyt_watching_body(soup: BeautifulSoup) -> Tag | None:
    main = soup.select_one("main")
    if not isinstance(main, Tag):
        return None
    document = BeautifulSoup(
        "<div data-jojo-source='nyt-watching'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if wrapper is None:
        return None
    lead = main.select_one(".WatchingHeader__header figure")
    if isinstance(lead, Tag):
        wrapper.append(BeautifulSoup(str(lead), "html.parser"))
    seen: set[str] = set()
    for node in main.select(
        ".Interactive__figure > h2, "
        ".interactive-graphic h1, "
        ".interactive-graphic .summary, "
        ".interactive-graphic .cards a, "
        ".interactive-graphic .footer .title"
    ):
        text = _clean_text(node.get_text(" ", strip=True))
        identity = text.casefold()
        if not text or identity in seen:
            continue
        seen.add(identity)
        name = node.name if node.name in {"h1", "h2", "h3"} else "p"
        rendered = document.new_tag(name)
        rendered.string = text
        wrapper.append(rendered)
    text = _clean_text(wrapper.get_text(" ", strip=True))
    return wrapper if len(text) >= _MINIMUM_BODY_CHARACTERS else None


def _structured_article_body(
    news_article: dict[str, Any],
    *,
    extract_ft_embedded_media: bool = False,
) -> Tag | None:
    value = news_article.get("articleBody")
    if not isinstance(value, str):
        return None
    raw_paragraphs = [
        paragraph
        for paragraph in re.split(r"\n\s*\n", value)
        if _clean_text(paragraph)
    ]
    if extract_ft_embedded_media:
        raw_paragraphs = _clean_ft_structured_paragraphs(raw_paragraphs)
    if not raw_paragraphs:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for raw_paragraph in raw_paragraphs:
        if extract_ft_embedded_media:
            media_nodes, paragraph = _ft_structured_media_nodes(
                document,
                raw_paragraph,
            )
            if _FT_STRUCTURED_TERMINAL_CHROME_RE.match(
                _clean_text(paragraph)
            ):
                break
            if _FT_STRUCTURED_RULE_RE.fullmatch(_clean_text(paragraph)):
                continue
            for media_node in media_nodes:
                article.append(media_node)
            if not paragraph:
                continue
            node = document.new_tag("p")
            node.string = paragraph
            article.append(node)
            continue
        image_match = re.match(
            r"^\s*\[(https?://[^\]\s]+)\]\s*(.*)$",
            raw_paragraph,
            flags=re.DOTALL | re.IGNORECASE,
        )
        if image_match is not None:
            figure = document.new_tag("figure")
            image = document.new_tag("img")
            image["src"] = image_match.group(1)
            figure.append(image)
            article.append(figure)
            paragraph = _clean_text(image_match.group(2))
            if not paragraph:
                continue
        else:
            paragraph = _clean_text(raw_paragraph)
        node = document.new_tag("p")
        node.string = paragraph
        article.append(node)
    return article


_FT_STRUCTURED_TERMINAL_CHROME_RE = re.compile(
    r"^(?:"
    r"where climate change meets business, markets and politics\b|"
    r"are you curious about the ft[’']s environmental sustainability commitments\b|"
    r"find out about our latest stories first\s*[—-]\s*follow\s+@ftweekend\b|"
    r"recommended newsletters for you\b"
    r")",
    flags=re.IGNORECASE,
)
_FT_STRUCTURED_RULE_RE = re.compile(
    r"^(?:[-–—]{6,}|[.…]{6,})$"
)
_FT_STRUCTURED_PROMO_RE = re.compile(
    r"^(?:"
    r"find out about our latest stories first\s*[—-]\s*"
    r"follow\s+@ftproperty\b|"
    r"latest coronavirus news\b.*(?:follow ft|global pandemic|"
    r"economic crisis)|"
    r"read more about the impact of coronavirus\b|"
    r"coronavirus business update\b.*(?:coronavirus newsletter|"
    r"stay briefed)|"
    r"the financial times is making key coronavirus coverage free "
    r"to read\b|"
    r"we(?:'|’)re offering a free \d+-day trial to coronavirus "
    r"business update\b.*\bsign up here\b|"
    r"our popular newsletter\b.*\bplease\s+sign\s*up\s*here\b|"
    r"(?:(?:twice weekly|britain after brexit|daily)\s+newsletter|"
    r"city bulletin)\b.*(?:\bnewsletter\b|\bsign\s*up\b|"
    r"\bin your inbox\b)|"
    r"ft\s*weekend festival\b.*\bbook your pass\b|"
    r"are you personally affected by\b.*\bshort survey\b|"
    r"ft survey:\s*.*\bshort survey\b|"
    r"(?:.*\[https?://[^\]]+\]\s*"
    r"click here to visit digital assets dashboard|"
    r"\[https?://[^\]]+\]\s*this article is from nikkei asia)\b"
    r")",
    flags=re.IGNORECASE,
)


def _clean_ft_structured_paragraphs(paragraphs: list[str]) -> list[str]:
    """Remove FT JSON-LD footer modules while retaining following products."""
    clean: list[str] = []
    skip_standalone_cta = False
    for index, paragraph in enumerate(paragraphs):
        text = _clean_text(paragraph)
        folded = text.casefold()
        if skip_standalone_cta and folded in {
            "sign up here",
            "sign up here.",
        }:
            skip_standalone_cta = False
            continue
        skip_standalone_cta = False
        next_text = (
            _clean_text(paragraphs[index + 1]).casefold()
            if index + 1 < len(paragraphs)
            else ""
        )
        if folded in {"editor's note", "editor’s note"} and next_text.startswith(
            "the financial times is making key coronavirus coverage free "
            "to read"
        ):
            continue
        if _FT_STRUCTURED_TERMINAL_CHROME_RE.match(text):
            break
        if _FT_STRUCTURED_RULE_RE.fullmatch(text):
            continue
        if _FT_STRUCTURED_PROMO_RE.search(text):
            if folded.startswith("coronavirus business update"):
                skip_standalone_cta = True
            continue
        clean.append(paragraph)
    return clean


_FT_STRUCTURED_IMAGE_RE = re.compile(
    r"\[(?P<url>https?://[^\]\s]+)\]",
    flags=re.IGNORECASE,
)
_FT_STRUCTURED_CREDIT_PREFIXES = tuple(
    sorted(
        {
            "China National Space Administration/Getty Images",
            "Charlie Bibby/Financial Times",
            "Andrew Milligan/Getty Images",
            "Felix Bensman/Dreamstime",
            "Jeff Kravitz/FilmMagic",
            "JMEnternational/Redferns",
            "AFP via Getty Images",
            "Radharc Images/Alamy",
            "Katrina Campbell",
            "Catherine Ashmore",
            "Yoshiyuki Tamai",
            "Julia Savchenko",
            "Collier Schorr",
            "London Play",
            "Mark Allan",
            "FT montage",
            "Bloomberg",
            "Reuters",
            "Getty Images",
            "Getty",
            "Dreamstime",
            "EPA",
            "AFP",
            "AP",
        },
        key=len,
        reverse=True,
    )
)
_FT_STRUCTURED_BODY_BOUNDARY_RE = re.compile(
    r"(?<=[a-z)])(?=(?:"
    r"The|A(?=\s)|An(?=\s)|As(?=\s)|At(?=\s)|After(?=\s)|"
    r"Australia|Britain|Credit|Despite|In(?=\s)|It(?=\s)|"
    r"Late(?=\s)|Mark(?=\s)|Muslim|Nasa|On(?=\s)|President|"
    r"Scams|Still(?=\s)|That(?=\s)|This(?=\s)|Through(?=\s)|"
    r"UK(?=\s)|Venezuelan|When(?=\s)|What(?=\s)|"
    r"[\"“]))"
)


def _ft_structured_credit_and_body(
    value: str,
    *,
    credit_hint: str | None = None,
) -> tuple[str | None, str]:
    """Split FT's flattened ``© creditBody`` representation."""
    clean = value.strip()
    folded = clean.casefold()
    for credit in _FT_STRUCTURED_CREDIT_PREFIXES:
        if folded.startswith(credit.casefold()):
            return clean[: len(credit)], clean[len(credit) :].strip()
    if credit_hint:
        normalized_hint = re.sub(
            r"[^a-z0-9]+",
            "",
            credit_hint.casefold(),
        )
        candidates: list[tuple[float, int]] = []
        for match in re.finditer(
            r"(?<=[a-z0-9)])(?=[A-Z])|(?<=\S)\s+(?=[A-Z“])",
            clean[:240],
        ):
            boundary = match.start()
            body = clean[match.end() :].strip()
            if len(body) < 50:
                continue
            normalized_credit = re.sub(
                r"[^a-z0-9]+",
                "",
                clean[:boundary].casefold(),
            )
            similarity = SequenceMatcher(
                None,
                normalized_credit,
                normalized_hint,
            ).ratio()
            candidates.append((similarity, boundary))
        if candidates:
            similarity, boundary = max(candidates)
            if similarity >= 0.72:
                return (
                    clean[:boundary].strip() or None,
                    clean[boundary:].strip(),
                )
    inferred_boundary = _ft_infer_structured_credit_boundary(clean)
    if inferred_boundary is not None:
        return (
            clean[:inferred_boundary].strip() or None,
            clean[inferred_boundary:].strip(),
        )
    boundary = _FT_STRUCTURED_BODY_BOUNDARY_RE.search(clean)
    if boundary is None:
        return clean or None, ""
    return (
        clean[: boundary.start()].strip() or None,
        clean[boundary.start() :].strip(),
    )


def _ft_infer_structured_credit_boundary(value: str) -> int | None:
    """Find prose glued to an unknown photo credit without a delimiter."""
    candidates: list[tuple[float, int]] = []
    agency_suffix = re.compile(
        r"(?i)(?:reuters|getty(?:\s+images)?|afp|ap|epa(?:-efe)?|"
        r"shutterstock|alamy|pa\s+wire|financial\s+times|"
        r"magnum\s+photos|eyevine|avalon\.red)$"
    )
    finite_verb = re.compile(
        r"(?i)\b(?:is|are|was|were|has|have|had|will|would|"
        r"can|could|may|might|must|agreed|filed|became|become|"
        r"comes|come|takes|took|began|starts|started|read|cannot)\b"
    )
    for match in re.finditer(
        r"(?<=[a-z0-9)])(?=[A-Z])|(?<=\S)\s+(?=[A-Z“])",
        value[:180],
    ):
        boundary = match.start()
        prefix = value[:boundary].strip()
        body = value[match.end() :].strip()
        if not 3 <= len(prefix) <= 130 or len(body) < 80:
            continue
        opening_words = " ".join(body.split()[:25])
        if finite_verb.search(opening_words) is None:
            continue
        joined = match.start() == match.end()
        score = 4.0 if joined else 0.0
        if agency_suffix.search(prefix):
            score += 8.0
        if "/" in prefix:
            score += 2.0
        if len(prefix.split()) <= 6:
            score += 1.0
        if all(
            re.match(r"^[A-Z][^\s]*$", word)
            for word in prefix.replace("/", " ").split()
        ):
            score += 2.0
        score += min(len(prefix), 80) / 80
        if re.search(r"[!?;]", prefix):
            score -= 6.0
        if re.search(r"[a-z]{3,}\.\s+[A-Z]", prefix):
            score -= 5.0
        if re.search(
            r"(?i)\b(?:is|was|were|has|have|had|to|in|"
            r"for|with|from)\b",
            prefix,
        ):
            score -= 3.0
        candidates.append((score, boundary))
    if not candidates:
        return None
    score, boundary = max(candidates)
    return boundary if score >= 2.5 else None


def _ft_structured_caption_and_body(
    value: str,
    *,
    credit_hint: str | None = None,
) -> tuple[str | None, str | None, str]:
    """Recover caption, credit and following prose from a flattened image."""
    clean = value.strip()
    if not clean:
        return None, None, ""
    if "©" in clean:
        caption, credit_tail = clean.rsplit("©", 1)
        credit, body = _ft_structured_credit_and_body(
            credit_tail,
            credit_hint=credit_hint,
        )
        return _clean_text(caption) or None, credit, _clean_text(body)
    boundary = _FT_STRUCTURED_BODY_BOUNDARY_RE.search(clean)
    if boundary is None:
        return None, None, _clean_text(clean)
    return (
        _clean_text(clean[: boundary.start()]) or None,
        None,
        _clean_text(clean[boundary.start() :]),
    )


def _ft_structured_media_nodes(
    document: BeautifulSoup,
    raw_paragraph: str,
) -> tuple[list[Tag], str]:
    """Turn image annotations flattened into FT JSON-LD back into figures."""
    matches = list(_FT_STRUCTURED_IMAGE_RE.finditer(raw_paragraph))
    if not matches:
        return [], _clean_text(raw_paragraph)
    figures: list[Tag] = []
    trailing_body = ""
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else None
        tail = raw_paragraph[match.end() : end]
        description_start = (
            matches[index - 1].end() if index > 0 else 0
        )
        description = raw_paragraph[description_start : match.start()]
        credit_match = re.search(
            r"\((?:photo(?:graph)?|image)\s+(?:by|:)\s*"
            r"(?P<credit>[^()]+)\)\s*$",
            description,
            flags=re.IGNORECASE,
        )
        credit_hint = (
            _clean_text(credit_match.group("credit"))
            if credit_match is not None
            else None
        )
        caption, credit, body = _ft_structured_caption_and_body(
            tail,
            credit_hint=credit_hint,
        )
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = match.group("url")
        figure.append(image)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Photo: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        figures.append(figure)
        if index == len(matches) - 1:
            trailing_body = body
    return figures, trailing_body


def _nyt_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    addressed_story = _nyt_addressed_anthology_story(
        soup,
        canonical_url=canonical_url,
    )
    if addressed_story is not None:
        return addressed_story
    # Some legacy packages are anthologies made from several independently
    # authored interactive articles.  Selecting the first graphic silently
    # drops all sibling stories, as on the 2019 Gamergate opinion package.
    story = soup.select_one("article.story.theme-interactive")
    if isinstance(story, Tag):
        story_sections = story.select(".rad-article")
        story_text = _clean_text(story.get_text(" ", strip=True))
        if len(story_sections) >= 2 and len(story_text) >= 400:
            return story
    candidates: list[Tag] = []
    for selector in (
        ".g-story.g-freebird",
        ".interactive-graphic",
        ".interactive-body",
        "section.interactive-content",
    ):
        for candidate in soup.select(selector):
            candidate_text = _clean_text(
                candidate.get_text(" ", strip=True)
            )
            if (
                len(candidate_text) >= 200
                or (
                    candidate.select_one("img[src], figure, iframe")
                    and (
                        selector == ".interactive-graphic"
                        or len(candidate_text) >= 30
                    )
                )
            ):
                quiz_body = _nyt_interactive_quiz_body(candidate)
                if quiz_body is not None:
                    candidates.append(quiz_body)
                    continue
                div_body = _nyt_div_only_interactive_body(candidate)
                if div_body is not None:
                    candidates.append(div_body)
                    continue
                candidates.append(candidate)
    if not candidates:
        return None
    # Modern interactive pages can contain a short navigation/result panel
    # followed by the real article body.  Selecting the first matching
    # ``.interactive-body`` silently collapses the prose to the short panel;
    # retain the most substantive rendered body instead.
    return max(
        candidates,
        key=lambda candidate: len(candidate.get_text(" ", strip=True)),
    )


def _nyt_addressed_anthology_story(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Select the URL-addressed story from a reordered anthology package."""
    canonical_path = unquote(urlsplit(canonical_url).path).rstrip("/")
    filename = canonical_path.rsplit("/", 1)[-1]
    filename_stem = re.sub(r"\.html?$", "", filename, flags=re.IGNORECASE)

    # The 2017 Lives They Lived package renders every independently
    # addressable profile inside one ``d-multi-url-article`` document.  The
    # requested profile is not reliably reordered first; its stable
    # ``data-slug`` is instead identical to the URL filename.  Match that
    # identity exactly because every entry otherwise shares the generic
    # "the-lives-they-lived" URL tokens.  The anthology root intentionally
    # matches no entry and therefore falls through to the complete package.
    legacy_articles = soup.select(
        ".d-multi-url-article .articles > article.story[data-slug]"
    )
    if len(legacy_articles) >= 2 and filename_stem:
        normalized_filename_stem = filename_stem.casefold()
        for article in legacy_articles:
            if (
                _tag_attribute(article, "data-slug") or ""
            ).casefold() == normalized_filename_stem:
                return article

    url_tokens = {
        token
        for token in re.findall(
            r"[a-z0-9]+",
            canonical_path.casefold(),
        )
        if len(token) >= 4
    }
    if not url_tokens:
        return None

    def marker_matches_url(marker: str | None) -> bool:
        if not marker:
            return False
        marker_tokens = {
            token.casefold()
            for token in re.findall(
                r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+",
                marker,
            )
            if len(token) >= 4 and token.casefold() not in {"magazine"}
        }
        return bool(marker_tokens & url_tokens)

    # The 2022 gun-violence package emits every profile in each capture, but
    # moves the requested profile to the first module and records its surname
    # on the enclosing story's ``data-page`` attribute.
    story = soup.select_one(".g-story.g-freebird[data-page]")
    if isinstance(story, Tag):
        profiles = story.select(":scope > .g-module-profile")
        first_profile = story.select_one(
            ":scope > .g-module-profile.g-module-first"
        )
        if (
            len(profiles) >= 2
            and isinstance(first_profile, Tag)
            and marker_matches_url(_tag_attribute(story, "data-page"))
        ):
            return first_profile

    # The 2024 Lives They Lived package follows the same URL-addressed model:
    # all entries are rendered, while the requested entry is reordered first.
    interactive_body = soup.select_one(
        ".interactive-body, section.interactive-content"
    )
    if isinstance(interactive_body, Tag):
        articles = interactive_body.select(":scope .g-article[data-slug]")
        if len(articles) >= 2:
            first_article = articles[0]
            if (
                "isFirst" in (first_article.get("class") or [])
                and marker_matches_url(
                    _tag_attribute(first_article, "data-slug")
                )
            ):
                return first_article
    return None


def _nyt_legacy_multi_url_story_matches(
    body: Tag | None,
    *,
    canonical_url: str,
) -> bool:
    """Return whether ``body`` is the URL's exact legacy anthology story."""

    if not isinstance(body, Tag) or body.name != "article":
        return False
    anthology = body.find_parent(class_="d-multi-url-article")
    if not isinstance(anthology, Tag):
        return False
    canonical_path = unquote(urlsplit(canonical_url).path).rstrip("/")
    filename = canonical_path.rsplit("/", 1)[-1]
    filename_stem = re.sub(r"\.html?$", "", filename, flags=re.IGNORECASE)
    return bool(
        filename_stem
        and (_tag_attribute(body, "data-slug") or "").casefold()
        == filename_stem.casefold()
    )


def _nyt_escaped_legacy_interactive_body(
    soup: BeautifulSoup,
) -> Tag | None:
    """Recover rendered graphics emitted outside the legacy article shell."""
    listings = soup.select_one(
        "body > .control-width .listings, "
        "body > div.control-width .listings"
    )
    if isinstance(listings, Tag):
        paragraphs = [
            text
            for paragraph in listings.select("p")
            if (text := _tag_text(paragraph))
        ]
        if (
            len(paragraphs) >= 5
            and sum(len(text) for text in paragraphs) >= 500
        ):
            document = BeautifulSoup("<article></article>", "html.parser")
            article = document.article
            if not isinstance(article, Tag):
                return None
            for entry in listings.select("li"):
                for source_node in entry.select(":scope > h4, :scope > p"):
                    copy = BeautifulSoup(
                        str(source_node),
                        "html.parser",
                    ).find(source_node.name)
                    if isinstance(copy, Tag):
                        article.append(copy)
                for source_image in entry.select("img[src]"):
                    figure = document.new_tag("figure")
                    image = document.new_tag("img")
                    image["src"] = str(source_image["src"])
                    alt = _tag_attribute(source_image, "alt")
                    if alt:
                        image["alt"] = alt
                    figure.append(image)
                    caption = _tag_text(
                        source_image.find_parent(class_="img")
                        .select_one(".img-caption")
                        if isinstance(
                            source_image.find_parent(class_="img"),
                            Tag,
                        )
                        else None
                    )
                    credit = _tag_text(entry.select_one(".img-credit"))
                    if caption or credit:
                        figcaption = document.new_tag("figcaption")
                        figcaption.string = " ".join(
                            value for value in (caption, credit) if value
                        )
                        figure.append(figcaption)
                    article.append(figure)
            return article

    contribution_form = soup.select_one("#g-graphic.g-form")
    if isinstance(contribution_form, Tag):
        text = _clean_text(contribution_form.get_text(" ", strip=True))
        if (
            len(text) >= 300
            and contribution_form.select_one("form, textarea, input")
        ):
            return contribution_form
    return None


def _wsj_is_legacy_video(soup: BeautifulSoup) -> bool:
    if soup.select_one(
        "#masterVideoCenter, .vcrPlayerArea, .js_videoPlayer #videoPlayer"
    ):
        return True
    return any(
        re.search(r"""articleType\s*:\s*["']Video\s*-\s*WSJ["']""", value)
        for script in soup.select("script")
        if (value := script.string or script.get_text())
    )


def _bloomberg_john_lothian_summary(soup: BeautifulSoup) -> bool:
    """John Lothian newsletters carry short summaries, never full stories."""
    partner_url = _first_text(
        _meta_content(soup, "property", "og:url"),
        _tag_attribute(soup.select_one("link[rel='canonical']"), "href"),
    )
    hostname = (
        (urlsplit(partner_url).hostname or "").casefold()
        if partner_url
        else ""
    )
    return (
        hostname == "johnlothiannews.com"
        or hostname.endswith(".johnlothiannews.com")
    )


def _wsj_legacy_video_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover descriptions and transcripts from the old WSJ Video Center."""
    if not _wsj_is_legacy_video(soup):
        return None
    description = _first_text(
        _tag_text(
            soup.select_one(
                "#videoPlayerDescription [itemprop='description'], "
                "#currentVideoInfo > p"
            )
        ),
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    transcript = _tag_text(soup.select_one(".vcrTranscriptContent"))
    video_url = _first_text(
        _tag_attribute(soup.select_one("#videoTitle[href]"), "href"),
        canonical_url,
    )
    if not description and not transcript and not video_url:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    if transcript:
        heading = document.new_tag("h2")
        heading.string = "Transcript"
        article.append(heading)
        paragraph = document.new_tag("p")
        paragraph.string = transcript
        article.append(paragraph)
    normalized_video_url = _normalized_url(
        video_url,
        base_url=canonical_url,
    )
    if normalized_video_url:
        iframe = document.new_tag("iframe")
        iframe["src"] = normalized_video_url
        iframe["title"] = "WSJ video"
        article.append(iframe)
    return article


def _nyt_div_only_interactive_body(candidate: Tag) -> Tag | None:
    """Turn old graphics made entirely from semantic divs into text blocks."""
    plain_text_fallback = candidate.select_one("#timeline_plain_text")
    if isinstance(plain_text_fallback, Tag):
        text = _clean_text(
            plain_text_fallback.get_text(" ", strip=True)
        )
        if len(text) >= _MINIMUM_BODY_CHARACTERS:
            document = BeautifulSoup("<article></article>", "html.parser")
            article = document.article
            if isinstance(article, Tag):
                paragraph = document.new_tag("p")
                paragraph.string = text
                article.append(paragraph)
                return article
    if candidate.select_one("p, h1, h2, h3, h4, li, table"):
        return None
    sections = candidate.select(".g-section")
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if len(sections) < 2:
        text = _clean_text(candidate.get_text(" ", strip=True))
        if (
            len(text) < _MINIMUM_BODY_CHARACTERS
            or candidate.select_one("img[src], iframe") is None
        ):
            return None
        paragraph = document.new_tag("p")
        paragraph.string = text
        article.append(paragraph)
        for media in candidate.select("img[src], iframe"):
            media_copy = BeautifulSoup(
                str(media),
                "html.parser",
            ).find(media.name)
            if isinstance(media_copy, Tag):
                article.append(media_copy)
        return article
    intro = _tag_text(candidate.select_one(".g-intro"))
    if intro:
        paragraph = document.new_tag("p")
        paragraph.string = intro
        article.append(paragraph)
    for section in sections:
        for selector, name in (
            (".g-source", "p"),
            (".g-translation", "blockquote"),
        ):
            text = _tag_text(section.select_one(selector))
            if not text:
                continue
            node = document.new_tag(name)
            node.string = text
            article.append(node)
    return article if len(_clean_text(article.get_text(" ", strip=True))) >= 200 else None


def _nyt_interactive_metadata_body(soup: BeautifulSoup) -> Tag | None:
    """Keep useful metadata when a legacy interactive is only a JS shell."""
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
        _meta_content(soup, "name", "twitter:description"),
    )
    if not description:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _nyt_interactive_quiz_body(candidate: Tag) -> Tag | None:
    questions = candidate.select(".multiple-choice-question")
    if len(questions) < 2:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for question in questions:
        figure = question.select_one("figure")
        if isinstance(figure, Tag):
            figure_copy = BeautifulSoup(str(figure), "html.parser").find(
                "figure"
            )
            if isinstance(figure_copy, Tag):
                article.append(figure_copy)
        prompt = _tag_text(question.select_one(".question-text"))
        if prompt:
            heading = document.new_tag("h2")
            heading.string = prompt
            article.append(heading)
        answers = [
            text
            for node in question.select(".answer-text")
            if (text := _tag_text(node))
        ]
        if answers:
            answer_list = document.new_tag("ul")
            for answer in answers:
                item = document.new_tag("li")
                item.string = answer
                answer_list.append(item)
            article.append(answer_list)
    return article if len(article.select("h2")) >= 2 else None


def _nyt_balloteer_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Preserve the data endpoint for NYT quizzes rendered by Balloteer."""
    if "/interactive/" not in canonical_url.casefold():
        return None
    ballot_slug: str | None = None
    for script in soup.select("script"):
        value = script.string or script.get_text()
        if "ballot_slug" not in value or "embed_init" not in value:
            continue
        match = re.search(
            r"""["']ballot_slug["']\s*:\s*["']([^"'\\]+)["']""",
            value,
        )
        if match:
            ballot_slug = match.group(1).strip()
            break
    if not ballot_slug or not re.fullmatch(r"[A-Za-z0-9._-]+", ballot_slug):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    iframe = document.new_tag("iframe")
    iframe["src"] = (
        "https://www.nytimes.com/svc/int/balloteer/ballot/"
        f"{ballot_slug}"
    )
    iframe["title"] = f"Interactive quiz data: {ballot_slug}"
    iframe["data-interactive-provider"] = "nyt-balloteer"
    article.append(iframe)
    return article


def _structured_image_gallery(soup: BeautifulSoup) -> Tag | None:
    for script in soup.select('script[type="application/ld+json"]'):
        value = script.string or script.get_text()
        if not value.strip():
            continue
        try:
            payload = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            continue
        for item in _walk_json_objects(payload):
            types = item.get("@type")
            if isinstance(types, str):
                types = [types]
            if not (
                isinstance(types, list)
                and "ImageGallery" in types
            ):
                continue
            media = item.get("associatedMedia")
            if not isinstance(media, list):
                continue
            rows: list[tuple[str, str, str | None]] = []
            for image in media:
                if not isinstance(image, dict):
                    continue
                image_url = _first_text(
                    _string_or_none(image.get("contentUrl")),
                    _string_or_none(image.get("url")),
                )
                caption = _string_or_none(image.get("caption"))
                if not image_url or not caption:
                    continue
                creator = image.get("creator")
                credit = (
                    _string_or_none(creator.get("name"))
                    if isinstance(creator, dict)
                    else _string_or_none(creator)
                )
                rows.append((image_url, caption, credit))
            if len(rows) < 3:
                continue
            document = BeautifulSoup("<article></article>", "html.parser")
            article = document.article
            if not isinstance(article, Tag):
                return None
            for image_url, caption, credit in rows:
                figure = document.new_tag("figure")
                image_node = document.new_tag("img")
                image_node["src"] = image_url
                image_node["alt"] = caption
                figure.append(image_node)
                figcaption = document.new_tag("figcaption")
                figcaption.string = (
                    f"{caption} Photographer: {credit}"
                    if credit
                    else caption
                )
                figure.append(figcaption)
                article.append(figure)
            return article
    return None


def _wsj_amp_story_gallery(soup: BeautifulSoup) -> Tag | None:
    pages = soup.select("amp-story > amp-story-page")
    if len(pages) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for page in pages:
        image = page.select_one(
            "amp-img[media*='landscape' i], amp-img"
        )
        if not isinstance(image, Tag):
            continue
        source = _string_or_none(image.get("src"))
        if not source:
            continue
        figure = document.new_tag("figure")
        image_node = document.new_tag("img")
        image_node["src"] = source
        width = _string_or_none(image.get("width"))
        height = _string_or_none(image.get("height"))
        if width:
            image_node["width"] = width
        if height:
            image_node["height"] = height
        caption = _tag_text(page.select_one(".wsj--caption"))
        credit = _tag_text(page.select_one(".wsj--credit"))
        if caption:
            image_node["alt"] = caption
        figure.append(image_node)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article if len(article.select("figure")) >= 3 else None


def _wsj_legacy_slideshow(soup: BeautifulSoup) -> Tag | None:
    slides = soup.select(
        ".dj-slideshow .slide-wrapper:not(.thumbgrid-wrapper), "
        ".wsj-slideshow-slide:not(.explore-more-slide)"
    )
    if len(slides) < 2:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for slide in slides:
        image = slide.select_one("img[src], img[data-src]")
        content_url = slide.select_one(
            "meta[itemprop='contentUrl'][content], "
            "meta[property='contentUrl'][content]"
        )
        source = _first_text(
            _string_or_none(content_url.get("content"))
            if isinstance(content_url, Tag)
            else None,
            _string_or_none(image.get("src"))
            if isinstance(image, Tag)
            else None,
            _string_or_none(image.get("data-src"))
            if isinstance(image, Tag)
            else None,
        )
        if not source:
            continue
        credit = _first_text(
            _string_or_none(slide.get("data-credit")),
            _tag_text(
                slide.select_one(
                    ".caption-wrapper span, "
                    "[itemprop='copyrightHolder'], "
                    ".credit"
                )
            ),
        )
        caption_node = slide.select_one(
            ".caption-wrapper p, [itemprop='caption'], "
            ".wsj-slideshow-caption, figcaption"
        )
        caption = None
        if isinstance(caption_node, Tag):
            caption_copy = BeautifulSoup(
                str(caption_node),
                "html.parser",
            )
            for credit_node in caption_copy.select("span"):
                credit_node.decompose()
            caption = _tag_text(caption_copy)
        figure = document.new_tag("figure")
        image_node = document.new_tag("img")
        image_node["src"] = source
        if caption:
            image_node["alt"] = caption
        figure.append(image_node)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article if len(article.select("figure")) >= 2 else None


def _wsj_inline_slideshow_article_body(
    body: Tag | None,
    *,
    gallery_body: Tag,
) -> Tag | None:
    """Replace an inline legacy slideshow without discarding article prose."""

    if not isinstance(body, Tag):
        return None
    document = BeautifulSoup(str(body), "html.parser")
    body_copy = document.find(body.name)
    if not isinstance(body_copy, Tag):
        return None
    slideshows = body_copy.select(".wsj-slideshow, .dj-slideshow")
    if not slideshows:
        return None
    prose_copy = BeautifulSoup(str(body_copy), "html.parser")
    for slideshow in prose_copy.select(".wsj-slideshow, .dj-slideshow"):
        slideshow.decompose()
    prose = _clean_text(prose_copy.get_text(" ", strip=True))
    if len(prose) < 400:
        return None
    replacement = document.new_tag("div")
    replacement["data-jojo-inline-gallery"] = ""
    for figure in gallery_body.select("figure"):
        replacement.append(copy.copy(figure))
    if len(replacement.select("figure")) < 2:
        return None
    slideshows[0].replace_with(replacement)
    for duplicate in slideshows[1:]:
        duplicate.decompose()
    return body_copy


def _wsj_webui_slideshow(soup: BeautifulSoup) -> Tag | None:
    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()
    decoder = json.JSONDecoder()
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if "WEBUI_SLIDESHOWS" not in value:
            continue
        for match in re.finditer(r"\bstate\s*:\s*(?=\{)", value):
            try:
                state, _ = decoder.raw_decode(value, match.end())
            except json.JSONDecodeError:
                continue
            if not isinstance(state, dict):
                continue
            context = state.get("context")
            slides = (
                context.get("slides")
                if isinstance(context, dict)
                else None
            )
            if not isinstance(slides, list):
                continue
            for slide in slides:
                if not isinstance(slide, dict):
                    continue
                source = _string_or_none(slide.get("imageSrc"))
                if not source:
                    continue
                identity = _image_identity(source)
                if identity in seen:
                    continue
                seen.add(identity)
                rows.append(
                    (
                        source,
                        _string_or_none(slide.get("caption")),
                        _string_or_none(slide.get("credit")),
                    )
                )
    if len(rows) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for source, caption, credit in rows:
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = source
        if caption:
            image["alt"] = caption
        figure.append(image)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article


def _wsj_legacy_ellipsis_truncation(plain_text: str) -> bool:
    """Recognize short legacy archive captures cut off with a literal ellipsis."""
    text = plain_text.rstrip()
    return len(text) < 1_000 and bool(re.search(r"\.{3,}$", text))


def _wsj_missing_best_seller_chart(
    *,
    headline: str | None,
    plain_text: str,
) -> bool:
    """Reject archived bestseller pages whose actual chart is absent.

    Some 2019 AMP captures preserve the headline and the common NPD
    BookScan methodology footer while their media-object chart slots are
    empty.  The shared footer is long enough to clear the generic article
    body floor, but it is not the article's editorial payload.
    """
    normalized_headline = _clean_text(headline or "").casefold()
    normalized_text = _clean_text(plain_text).casefold()
    return bool(
        normalized_headline.startswith("best-selling books")
        and "week ended" in normalized_headline
        and normalized_text.startswith("methodology ")
        and "npd bookscan gathers point-of-sale book data" in normalized_text
        and len(normalized_text) < 1_500
    )


def _wsj_subscription_truncation(
    soup: BeautifulSoup,
    *,
    content_type: ContentType,
    plain_text: str,
    selected_sign_in: bool,
) -> bool:
    """Reject metered WSJ previews while retaining substantial recovered copy."""
    # WSJ's snippet template is also used for short, complete items such as
    # Letters.  Those pages retain the generic membership overlay even when
    # the extracted body reaches the publisher-declared word count.  Check
    # that explicit completeness signal before treating the overlay as a
    # truncation marker; a real preview with a larger declared count still
    # falls through to the existing deficit checks below.
    declared_word_count = _wsj_declared_word_count(soup)
    extracted_word_count = len(
        re.findall(
            r"[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*",
            plain_text,
        )
    )
    declared_copy_is_complete = bool(
        declared_word_count is not None
        and extracted_word_count >= max(
            1,
            int(declared_word_count * 0.85),
        )
    )
    template_value = _tag_attribute(
        soup.select_one("meta[name='article.template']"), "content"
    )
    explicit_snippet_template = bool(
        (template_value or "").casefold() in {"snippet", "preview"}
        or any(
            re.search(
                r'''["']article_template["']\s*:\s*["']preview["']''',
                script.string or script.get_text(),
                re.IGNORECASE,
            )
            for script in soup.find_all("script")
        )
    )
    if content_type != ContentType.ARTICLE and not (
        explicit_snippet_template
        and declared_word_count is not None
        and declared_word_count >= 100
        and not declared_copy_is_complete
    ):
        return False
    legacy_article_panel = soup.select_one("#articleTabs_panel_article")
    if (
        isinstance(legacy_article_panel, Tag)
        and legacy_article_panel.select_one(".article.story") is None
        and (
            legacy_article_panel.select_one("#artSnippetControl") is not None
            or "available to wsj.com subscribers"
            in _clean_text(
                legacy_article_panel.get_text(" ", strip=True)
            ).casefold()
        )
    ):
        # Some 2010--2013 partner/preview captures retain the headline but
        # omit the story node entirely.  The broad legacy panel then consists
        # of MSN navigation, recommended-story snippets, sign-in controls and
        # email-dialog copy; its aggregate length can exceed the generic body
        # minimum even though no article prose survives.
        return True
    if soup.select_one("[class*='ArticleRoadblock' i]") or any(
        _clean_text(node.get_text(" ", strip=True))
        .casefold()
        .startswith("to read the full story")
        for node in soup.select("p, h2, h3, h4")
    ):
        return True
    snippet_roadblock_phrases = (
        "to read the full story",
        "continue reading your article with a wsj membership",
        "subscribe to wsj to read the rest of this article",
    )
    if any(
        any(phrase in text for phrase in snippet_roadblock_phrases)
        for node in soup.select(
            ".snippet-promotion, #cx-snippet-overlay, .snippet-content"
        )
        if (text := _clean_text(node.get_text(" ", strip=True)).casefold())
    ):
        # Archived 2020-era WSJ pages can preserve several substantial
        # preview paragraphs before an explicit membership overlay. Their
        # extracted text may exceed the generic 1,000-character safety
        # threshold even though the article ends at the paywall.
        return not declared_copy_is_complete
    if len(plain_text) >= 1_000:
        return False
    if (
        declared_copy_is_complete
    ):
        return False
    if (
        declared_word_count is not None
        and declared_word_count >= 100
        and extracted_word_count * 2 < declared_word_count
    ):
        # Some archived WSJ templates omit both the visible roadblock and
        # copyright footer while preserving only a three-paragraph preview.
        # WSJ's own article word count is still present in those captures;
        # a deficit greater than half is strong truncation evidence without
        # penalizing genuine short reports or editorial letters.
        return True
    if selected_sign_in:
        return True
    copyright_footer = any(
        (
            (text := _clean_text(node.get_text(" ", strip=True))).casefold()
            .startswith("copyright ©")
            and "dow jones & company" in text.casefold()
        )
        for node in soup.select("p")
    )
    if not copyright_footer:
        return False
    modern_body_paragraphs = [
        node
        for node in soup.select("p[data-type='paragraph']")
        if _clean_text(node.get_text(" ", strip=True))
    ]
    has_metered_controls = bool(
        soup.select_one(
            "[class*='ListenToArticle' i], "
            "[class*='MinutesLabel' i], "
            "h2[class*='SectionLabel' i]"
        )
    )
    return bool(has_metered_controls or len(modern_body_paragraphs) <= 3)


def _wsj_declared_word_count(soup: BeautifulSoup) -> int | None:
    """Read WSJ's own word count so genuine short reports are not previews."""
    raw = _first_text(
        _meta_content(soup, "name", "article:word_count"),
        _meta_content(soup, "property", "article:word_count"),
    )
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _wsj_unsupported_media_gallery(soup: BeautifulSoup) -> Tag | None:
    """Recover the synopsis when an old slideshow app cannot be replayed."""
    shell = soup.select_one(".wsj-snippet-body, .wsj-snippet-login")
    if isinstance(shell, Tag):
        shell_text = shell.get_text(" ", strip=True).casefold()
        if (
            "media that is not currently supported" not in shell_text
            or soup.select_one(".slideshow-article") is None
        ):
            return None
    else:
        # Infini-News sometimes materializes an old WSJ photo story as a tiny
        # derived document.  It has no replayable slide payload and its body
        # consists solely of the explicit unsupported-media notice followed by
        # subscription/navigation chrome.  Returning an empty article keeps
        # the record as a gallery shell while preventing interface prose from
        # entering the canonical body.
        derived = soup.select_one(
            "article[data-jojo-representation='derived-infini-news']"
        )
        if not isinstance(derived, Tag):
            return None
        derived_text = derived.get_text(" ", strip=True).casefold()
        if (
            "article not supported" not in derived_text
            or "media that is not currently supported" not in derived_text
            or "to read the full story" not in derived_text
        ):
            return None
        document = BeautifulSoup("<article></article>", "html.parser")
        article = document.article
        return article if isinstance(article, Tag) else None
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    if not description:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _bloomberg_article_narration(soup: BeautifulSoup) -> bool:
    """Distinguish Bloomberg's text-to-speech player from an audio story."""
    for heading in soup.select("h1, h2, h3, h4, [role='heading']"):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() in {
            "listen to article",
            "listen to this article",
        }:
            return True
    return bool(
        soup.select_one(
            "audio source[src*='assets.bwbx.io/s3/readings/'], "
            "audio[src*='assets.bwbx.io/s3/readings/']"
        )
    )


def _bloomberg_low_resolution_image(image: ImageCandidate) -> bool:
    return any(
        bool(
            re.search(
                r"/(?:60x-1|60x60)\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)",
                url,
                flags=re.IGNORECASE,
            )
        )
        for url in image.candidate_urls
    )


def _bloomberg_author_avatar_url(url: str) -> bool:
    return bool(
        re.search(
            r"(?i)/images/bview/columnists/"
            r"(?:\d+x\d+/)?[^/?#]+\.(?:gif|jpe?g|png|webp)(?:[?#]|$)",
            url,
        )
    )


def _bloomberg_legacy_lightbox_thumbnail_identities(
    soup: BeautifulSoup,
    *,
    base_url: str,
) -> set[str]:
    identities: set[str] = set()
    for thumbnail in soup.select(
        ".thumbnail_container.overlay_container > a.enlarge_image"
    ):
        overlay = thumbnail.find_next_sibling(
            "div",
            class_="simple_overlay",
        )
        image = thumbnail.find("img")
        if (
            not isinstance(overlay, Tag)
            or overlay.find("img") is None
            or not isinstance(image, Tag)
        ):
            continue
        identities.update(
            _image_identity(url)
            for url in _image_urls(image, base_url=base_url)
        )
    return identities


def _promote_bloomberg_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer Bloomberg's lossless-aspect 1200px rendition over a 60px lazy image."""
    promoted: list[str] = []
    for url in candidates:
        parsed = urlsplit(url)
        if parsed.hostname in {"assets.bwbx.io", "assets.bwbx.com"}:
            high_resolution = re.sub(
                r"/60x-1(?=\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$))",
                "/1200x-1",
                url,
                flags=re.IGNORECASE,
            )
            if high_resolution != url and high_resolution not in promoted:
                promoted.append(high_resolution)
        if url not in promoted:
            promoted.append(url)
    return promoted


def _promote_npr_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer NPR's full ``data-original`` asset over legacy crops."""
    indexed = list(enumerate(candidates))
    indexed.sort(
        key=lambda item: (
            bool(
                re.search(
                    r"-s\d+-c\d+(?=\.(?:gif|jpe?g|png|webp)$)",
                    urlsplit(item[1]).path,
                    flags=re.IGNORECASE,
                )
            ),
            item[0],
        )
    )
    return [url for _, url in indexed]


def _promote_ft_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer a 1200px FT Origami rendition while retaining source variants."""
    promoted: list[str] = []
    for url in candidates:
        parts = urlsplit(url)
        if (
            parts.hostname in {"ft.com", "www.ft.com"}
            and "/__origami/service/image/" in parts.path
        ):
            high_resolution = re.sub(
                r"([?&]width=)(?:[1-9]\d{0,2}|1[01]\d{2})(?=&|$)",
                r"\g<1>1200",
                url,
                flags=re.IGNORECASE,
            )
            if high_resolution != url and high_resolution not in promoted:
                promoted.append(high_resolution)
        if url not in promoted:
            promoted.append(url)
    return promoted


def _promote_reuters_image_candidates(candidates: list[str]) -> list[str]:
    """Prefer a full-size rendition for Reuters' legacy lazy image endpoint."""
    promoted: list[str] = []
    for url in candidates:
        parts = urlsplit(url)
        if (
            parts.hostname
            and parts.hostname.casefold().endswith("reutersmedia.net")
            and parts.path == "/resources/r/"
        ):
            high_resolution = re.sub(
                r"([?&]w=)(?:[1-9]\d{0,2}|1[01]\d{2})(?=&|$)",
                r"\g<1>1200",
                url,
                flags=re.IGNORECASE,
            )
            if high_resolution != url and high_resolution not in promoted:
                promoted.append(high_resolution)
        if (
            (parts.hostname or "").casefold() == "img.ksl.com"
            and re.search(
                r"(?:^|&)filter=ksl/(?:\d+x\d+|100x100)(?:&|$)",
                parts.query,
                re.IGNORECASE,
            )
        ):
            full_size = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, "", "")
            )
            if full_size not in promoted:
                promoted.append(full_size)
        if url not in promoted:
            promoted.append(url)
    return promoted


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


def _ap_carousel_gallery(soup: BeautifulSoup) -> Tag | None:
    for carousel in soup.select(
        ".Page-main bsp-carousel.Carousel, "
        ".Page-main .Carousel"
    ):
        slides = carousel.select(".Carousel-slide")
        if len(slides) < 3:
            continue
        document = BeautifulSoup("<article></article>", "html.parser")
        article = document.article
        if not isinstance(article, Tag):
            return None
        for slide in slides:
            source_image = slide.select_one("img")
            if not isinstance(source_image, Tag):
                continue
            image = BeautifulSoup(
                str(source_image),
                "html.parser",
            ).find("img")
            if not isinstance(image, Tag):
                continue
            figure = document.new_tag("figure")
            figure.append(image)
            caption = _first_text(
                _tag_text(
                    slide.select_one(
                        ".CarouselSlide-caption, "
                        ".CarouselSlide-description, "
                        "[class*='caption' i]"
                    )
                ),
                _clean_text(source_image.get("alt", "")) or None,
            )
            if caption:
                figcaption = document.new_tag("figcaption")
                figcaption.string = caption
                figure.append(figcaption)
            article.append(figure)
        if len(article.select("figure")) >= 3:
            return article
    return None


def _ap_hosted_headline(soup: BeautifulSoup) -> str | None:
    """Extract headlines from AP's pre-BigStory distribution templates."""
    return _tag_text(
        soup.select_one(
            ".ap-story-table .headline.entry-title, "
            ".ap-story-table .entry-title, "
            "#yn-story #yn-title, "
            "#hostednews-article #hn-headline, "
            ".entry h1"
        )
    )


def _ap_hosted_authors(soup: BeautifulSoup) -> list[Author]:
    """Extract bylines from AP's legacy hNews/vCard markup."""
    result: list[Author] = []
    seen: set[str] = set()
    for node in soup.select(
        ".ap-story-table .byline .author .fn, "
        ".ap-story-table .byline .vcard .fn, "
        "#yn-story .byline .vcard .fn, "
        ".entry .wire_author"
    ):
        name = _clean_text(node.get_text(" ", strip=True))
        key = name.casefold()
        if name and key not in seen:
            result.append(Author(name=name))
            seen.add(key)
    if result:
        return result
    google_byline = _tag_text(
        soup.select_one("#hostednews-article .hn-byline")
    )
    if google_byline:
        match = re.match(
            r"(?is)^\s*by\s+(.+?),\s*(?:the\s+)?associated\s+press\b",
            google_byline,
        )
        if match:
            for name in re.split(
                r"\s+(?:and|&)\s+|\s*,\s*",
                match.group(1),
            ):
                cleaned = _clean_text(name)
                key = cleaned.casefold()
                if cleaned and key not in seen:
                    result.append(Author(name=cleaned))
                    seen.add(key)
    return result


def _ap_hosted_published_at(soup: BeautifulSoup) -> str | None:
    """Return a machine-readable AP legacy timestamp, when present."""
    return _tag_attribute(
        soup.select_one(
            ".ap-story-table .timestamp.updated[title], "
            ".ap-story-table time.updated[datetime], "
            "#yn-story .byline abbr.timedate[title], "
            ".article-data .updated[title]"
        ),
        "title",
    ) or _tag_attribute(
        soup.select_one(".ap-story-table time.updated[datetime]"),
        "datetime",
    ) or _ap_huff_wire_published_at(soup)


def _ap_huff_wire_published_at(soup: BeautifulSoup) -> str | None:
    """Read the exact publication timestamp from HuffPost AP-wire pages."""
    metadata = soup.select_one(".entry .comments_datetime")
    text = _clean_text(metadata.get_text(" ", strip=True)) if metadata else ""
    match = re.search(
        r"(?i)\b([A-Z][a-z]+ \d{1,2}, 20\d{2} "
        r"\d{1,2}:\d{2} [AP]M)\s+(EST|EDT)\b",
        text,
    )
    if match is None:
        return None
    try:
        parsed = datetime.strptime(match.group(1), "%B %d, %Y %I:%M %p")
    except ValueError:
        return None
    offset = -5 if match.group(2).upper() == "EST" else -4
    return parsed.replace(
        tzinfo=timezone(timedelta(hours=offset))
    ).isoformat()


def _ap_structured_race_call_body(
    news_article: dict[str, Any],
) -> Tag | None:
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    description = _string_or_none(news_article.get("description"))
    if (
        not description
        or len(description) < _MINIMUM_BODY_CHARACTERS
        or not any("race call" in value.casefold() for value in keywords)
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _reuters_legacy_article_body(soup: BeautifulSoup) -> Tag | None:
    """Convert Reuters' pre-2011 BR-delimited articleText into paragraphs."""
    source = soup.select_one("#articleText")
    if not isinstance(source, Tag):
        return None
    if source.select_one("#div_with_disclaimer_id"):
        document = BeautifulSoup(str(source), "html.parser")
        cleaned_source = document.select_one("#articleText")
        if isinstance(cleaned_source, Tag):
            source = cleaned_source
            for disclaimer in source.select("#div_with_disclaimer_id"):
                disclaimer.decompose()
    text = _clean_text(source.get_text(" ", strip=True))
    if len(text) < _MINIMUM_BODY_CHARACTERS:
        return None
    if source.select_one("#bwbodyimg:has(img)"):
        document = BeautifulSoup(str(source), "html.parser")
        preserved = document.select_one("#articleText")
        if isinstance(preserved, Tag):
            return preserved
    fragments = re.split(
        r"(?:<br\s*/?>\s*){2,}",
        source.decode_contents(),
        flags=re.IGNORECASE,
    )
    paragraphs = [
        _clean_text(
            BeautifulSoup(fragment, "html.parser").get_text(" ")
            if "<" in fragment
            else html_module.unescape(fragment)
        )
        for fragment in fragments
    ]
    paragraphs = [
        paragraph
        for paragraph in paragraphs
        if paragraph
        and not re.fullmatch(
            r"(?i)(?:editing by|reporting by)\b.*",
            paragraph,
        )
    ]
    if not paragraphs:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for value in paragraphs:
        paragraph = document.new_tag("p")
        paragraph.string = value
        article.append(paragraph)
    return article


def _reuters_live_blog_body(soup: BeautifulSoup) -> Tag | None:
    posting = next(
        (
            value
            for value in _json_ld_objects(soup)
            if value.get("@type") == "LiveBlogPosting"
        ),
        None,
    )
    if posting is None:
        return None
    updates = posting.get("liveBlogUpdate")
    if not isinstance(updates, list):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen: set[tuple[str, str]] = set()
    for update in updates:
        if not isinstance(update, dict):
            continue
        headline = _string_or_none(update.get("headline"))
        raw_body = _string_or_none(update.get("articleBody"))
        body_text = (
            _clean_text(
                BeautifulSoup(raw_body, "html.parser").get_text(" ")
            )
            if raw_body
            else None
        )
        if body_text:
            body_text = re.sub(
                r"(?<=[a-z0-9)])(?=[A-Z](?:[a-z]{2,}|['’][a-z]))",
                ". ",
                body_text,
            )
            body_text = re.sub(
                r"(?i)\s*Trouble viewing video posts\?.*cookie settings\s*$",
                "",
                body_text,
            ).strip()
        if not headline and not body_text:
            continue
        identity = (headline or "", body_text or "")
        if identity in seen:
            continue
        seen.add(identity)
        if headline:
            heading = document.new_tag("h2")
            heading.string = headline
            article.append(heading)
        if body_text:
            paragraph = document.new_tag("p")
            paragraph.string = body_text
            article.append(paragraph)
    return article if len(article.get_text(" ", strip=True)) >= 80 else None


def _ap_structured_description_body(
    news_article: dict[str, Any],
) -> Tag | None:
    """Recover self-contained AP briefs stored only in JSON-LD descriptions."""
    if not news_article:
        return None
    description = _string_or_none(news_article.get("description"))
    keywords = _string_list(news_article.get("keywords"))
    is_score_bulletin = any(
        re.search(r"(?i)\b(?:prep\s+)?scores?\b", keyword)
        for keyword in keywords
    )
    is_archive_brief = any(
        keyword.casefold() == "archive"
        for keyword in keywords
    )
    if not description or (
        len(description) < _MINIMUM_BODY_CHARACTERS
        and not is_score_bulletin
        and not is_archive_brief
    ):
        return None
    if re.search(
        r"(?i)^(?:visit|view|click|subscribe)\b.*(?:\||edition|website)",
        description,
    ):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    return article


def _ap_structured_data_bulletin_body(
    news_article: dict[str, Any],
    canonical_url: str,
) -> Tag | None:
    """Represent AP metadata-only election/result wires without inventing prose."""
    if not _is_ap_data_bulletin(news_article, canonical_url):
        return None
    headline = _first_text(
        _string_or_none(news_article.get("headline")),
        _ap_data_bulletin_headline(news_article),
    )
    if not headline:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = headline
    article.append(paragraph)
    return article


def _ap_data_bulletin_headline(
    news_article: dict[str, Any],
) -> str | None:
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    for keyword in keywords:
        if re.search(r"(?i)(?:--.*\bbox\b|\bbox score\b)", keyword):
            return keyword
    if any(keyword.casefold() == "lotteries" for keyword in keywords):
        ignored = {"lotteries", "general news", "ap", "ap news"}
        return next(
            (
                keyword
                for keyword in keywords
                if keyword.casefold() not in ignored
            ),
            "Lottery results",
        )
    return None


def _ap_structured_headline(
    news_article: dict[str, Any],
) -> str | None:
    headline = (
        _string_or_none(news_article.get("headline"))
        if news_article
        else None
    )
    if headline and headline.casefold() in {"ap", "ap news"}:
        return None
    return headline


def _ap_wire_keyword_headline(
    news_article: dict[str, Any],
) -> str | None:
    """Use AP's descriptive wire slug when generic page metadata says AP News."""
    if not news_article:
        return None
    keywords = _string_list(news_article.get("keywords"))
    strict_wire_slug = next(
        (
            keyword
            for keyword in keywords
            if re.match(r"^[A-Z]{2,5}--\S", keyword)
        ),
        None,
    )
    if strict_wire_slug:
        return strict_wire_slug
    ignored = {
        "general news",
        "international news",
        "ap",
        "ap news",
        "archive",
    }
    return next(
        (
            keyword
            for keyword in keywords
            if keyword.casefold() not in ignored
            and "-" in keyword
            and len(keyword) >= 12
        ),
        None,
    )


def _is_ap_data_bulletin(
    news_article: dict[str, Any],
    canonical_url: str,
) -> bool:
    if not news_article:
        return False
    headline = _first_text(
        _string_or_none(news_article.get("headline")),
        _ap_data_bulletin_headline(news_article),
    )
    keywords = _string_list(news_article.get("keywords"))
    has_description = bool(
        _string_or_none(news_article.get("description"))
    )
    combined = " ".join(
        [headline or "", canonical_url, *keywords]
    ).casefold()
    metadata_only_election_slug = bool(
        not has_description
        and headline
        and any(headline.casefold() == keyword.casefold() for keyword in keywords)
        and re.fullmatch(
            r"[a-z]{2}-(?=[a-z0-9-]*(?:"
            r"uncontested|nominated|winners?|topraces|"
            r"camend|house|sthou|delg-dist|cnty"
            r"))[a-z0-9-]+",
            headline.casefold(),
        )
    )
    return bool(
        re.search(r"--.*\bbox\b|\bbox score\b", combined)
        or re.search(
            r"(?:^|[-/])(?:[a-z]{2}-)?house-\d+-nominated(?:-|$)",
            combined,
        )
        or (
            not has_description
            and any(
                "race call" in keyword.casefold()
                for keyword in keywords
            )
        )
        or (
            not has_description
            and any(
                keyword.casefold() == "lotteries"
                for keyword in keywords
            )
        )
        or (
            not has_description
            and any(
                re.fullmatch(r"[a-z]{2}-winners", keyword.casefold())
                for keyword in keywords
            )
        )
        or metadata_only_election_slug
    )


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _nyt_preloaded_state(soup: BeautifulSoup) -> dict[str, Any]:
    payload = _nyt_preloaded_payload(soup)
    state = payload.get("initialState")
    if isinstance(state, dict) and state:
        return state

    # Newer NYT Oak pages serialize the GraphQL result under
    # ``initialData.data.article`` while leaving ``initialState`` empty.  The
    # older parser helpers intentionally operate on a normalized reference
    # map, so index the nested GraphQL objects and expose the sprinkled body
    # blocks under the same key shape used by the legacy payload.
    initial_data = payload.get("initialData")
    article = (
        initial_data.get("data", {}).get("article")
        if isinstance(initial_data, dict)
        and isinstance(initial_data.get("data"), dict)
        else None
    )
    if not isinstance(article, dict):
        return {}
    normalized: dict[str, Any] = {}

    def index(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                index(child)
            return
        if not isinstance(value, dict):
            return
        identifier = value.get("id")
        if isinstance(identifier, str):
            normalized[identifier] = value
        for child in value.values():
            index(child)

    index(article)
    article_id = article.get("id")
    if isinstance(article_id, str):
        normalized[article_id] = article
    sprinkled = article.get("sprinkledBody")
    content = sprinkled.get("content") if isinstance(sprinkled, dict) else None
    if isinstance(article_id, str) and isinstance(content, list):
        for index_value, block in enumerate(content):
            if isinstance(block, dict):
                block_path = (
                    f"{article_id}.sprinkledBody.content.{index_value}"
                )

                def index_block(value: Any, path: str) -> None:
                    if isinstance(value, list):
                        for child_index, child in enumerate(value):
                            index_block(child, f"{path}.{child_index}")
                        return
                    if not isinstance(value, dict):
                        return
                    if "__typename" in value:
                        normalized[path] = value
                    for key, child in value.items():
                        if isinstance(child, (dict, list)):
                            index_block(child, f"{path}.{key}")

                index_block(block, block_path)
    return normalized


def _nyt_preloaded_payload(soup: BeautifulSoup) -> dict[str, Any]:
    marker = "window.__preloadedData = "
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if marker not in value:
            continue
        serialized = value.split(marker, 1)[1].strip().rstrip(";")
        # Some NYT releases serialize JavaScript `undefined` in otherwise valid
        # JSON. Those values are configuration-only and safely map to null.
        serialized = re.sub(
            r":\s*undefined(?=\s*[,}])",
            ": null",
            serialized,
        )
        try:
            payload = json.loads(serialized)
        except (json.JSONDecodeError, TypeError):
            payload = {}
            for key in ("initialData", "initialState"):
                recovered = _json_object_after_key(
                    serialized,
                    key=key,
                )
                if recovered is not None:
                    payload[key] = recovered
        if isinstance(payload, dict):
            return payload
    return {}


def _json_object_after_key(
    serialized: str,
    *,
    key: str,
) -> dict[str, Any] | None:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*', serialized)
    if match is None:
        return None
    start = serialized.find("{", match.end())
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(serialized)):
        character = serialized[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(serialized[start:index + 1])
                except (json.JSONDecodeError, TypeError):
                    return None
                return value if isinstance(value, dict) else None
    return None


def _nyt_state_reference(
    state: dict[str, Any],
    value: Any,
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    reference = value.get("id")
    if isinstance(reference, str):
        resolved = state.get(reference)
        if isinstance(resolved, dict):
            return resolved
    return value


def _nyt_image_renditions(
    state: dict[str, Any],
    image: dict[str, Any],
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    pending: list[Any] = [image]
    visited: set[str] = set()
    while pending:
        value = pending.pop()
        if isinstance(value, list):
            pending.extend(value)
            continue
        if not isinstance(value, dict):
            continue
        reference = value.get("id")
        if isinstance(reference, str) and reference in state:
            if reference in visited:
                continue
            visited.add(reference)
            pending.append(state[reference])
            continue
        if value.get("__typename") == "ImageRendition" and isinstance(
            value.get("url"), str
        ):
            found.append(value)
            continue
        pending.extend(value.values())
    return found


def _nyt_preloaded_image_gallery(soup: BeautifulSoup) -> Tag | None:
    state = _nyt_preloaded_state(soup)
    image_blocks = [
        value
        for key, value in state.items()
        if ".sprinkledBody.content" in key
        and isinstance(value, dict)
        and value.get("__typename") == "ImageBlock"
    ]
    rows: list[tuple[str, str | None, str | None]] = []
    seen_media: set[str] = set()
    for block in image_blocks:
        media_reference = block.get("media")
        media_id = (
            media_reference.get("id")
            if isinstance(media_reference, dict)
            else None
        )
        if not isinstance(media_id, str) or media_id in seen_media:
            continue
        seen_media.add(media_id)
        media = _nyt_state_reference(state, media_reference)
        if media is None:
            continue
        renditions = _nyt_image_renditions(state, media)
        if not renditions:
            continue
        rendition = max(
            renditions,
            key=lambda item: (
                int(item.get("width") or 0) * int(item.get("height") or 0),
                int(item.get("width") or 0),
            ),
        )
        caption_value = _nyt_state_reference(state, media.get("caption"))
        caption = None
        if caption_value is not None:
            caption = _first_text(
                _string_or_none(caption_value.get("text")),
                _string_or_none(caption_value.get("html")),
            )
        rows.append(
            (
                str(rendition["url"]),
                caption,
                _string_or_none(media.get("credit")),
            )
        )
    if len(rows) < 3:
        rows = _nyt_preloaded_slideshow_rows(state)
    if len(rows) < 3:
        rows = _nyt_preloaded_visual_story_rows(state)
    if len(rows) < 3:
        rows = _nyt_denormalized_gallery_rows(soup)
    if len(rows) < 3:
        rows = _nyt_legacy_slideshow_json_rows(soup)
    if len(rows) < 3:
        rows = _nyt_itemprop_gallery_rows(soup)
    if len(rows) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for image_url, caption, credit in rows:
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = image_url
        if caption:
            image["alt"] = caption
        figure.append(image)
        if caption or credit:
            figcaption = document.new_tag("figcaption")
            figcaption.string = " ".join(
                value
                for value in (
                    caption,
                    f"Credit: {credit}" if credit else None,
                )
                if value
            )
            figure.append(figcaption)
        article.append(figure)
    return article


def _nyt_should_select_gallery_body(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    """Do not replace substantive NYT prose merely because it has 3+ images."""
    # Slideshow state is also used for a figure embedded in an ordinary
    # article. It proves that gallery rows exist, not that they are the page's
    # primary body. Prefer it only for an explicit gallery page or when the
    # selected prose body is absent/sparse.
    page_type = _first_text(
        _meta_content(soup, "name", "PT"),
        _meta_content(soup, "name", "page.content.type"),
        _meta_content(soup, "name", "article.type"),
    )
    if page_type and page_type.casefold() in {
        "gallery",
        "photo gallery",
        "slideshow",
    }:
        return True
    if body is None:
        return True
    paragraphs = [
        _clean_text(paragraph.get_text(" ", strip=True))
        for paragraph in body.select("p")
        if paragraph.find_parent("figcaption") is None
    ]
    substantive = [text for text in paragraphs if text]
    return sum(len(text) for text in substantive) < 300


def _nyt_linked_slideshow_page(soup: BeautifulSoup) -> bool:
    linked_slideshow = soup.select_one("article a[href*='/slideshow/']")
    return bool(
        isinstance(linked_slideshow, Tag)
        and re.search(
            r"(?i)(?:view\s+slide\s*show|\b\d+\s+photos?\b)",
            _clean_text(linked_slideshow.get_text(" ", strip=True)),
        )
    )


def _nyt_linked_slideshow_card_body(soup: BeautifulSoup) -> Tag | None:
    """Preserve linked slideshow covers when slide payloads are placeholders."""
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen: set[str] = set()
    for link in soup.select("article a[href*='/slideshow/']"):
        label = _clean_text(link.get_text(" ", strip=True))
        if not re.search(
            r"(?i)(?:view\s+slide\s*show|\b\d+\s+photos?\b)",
            label,
        ):
            continue
        source = _normalized_url(
            _tag_attribute(link, "href"),
            base_url="https://www.nytimes.com/",
        )
        image_node = link.select_one("img[src], img[srcset]")
        if not source or source in seen or not isinstance(image_node, Tag):
            continue
        seen.add(source)
        figure = document.new_tag("figure")
        copied_link = document.new_tag("a", href=source)
        copied_image = document.new_tag("img")
        copied_image.attrs = dict(image_node.attrs)
        copied_link.append(copied_image)
        figure.append(copied_link)
        if label:
            caption = document.new_tag("figcaption")
            caption_link = document.new_tag("a", href=source)
            caption_link.string = label
            caption.append(caption_link)
            figure.append(caption)
        article.append(figure)
    return article if article.select_one("figure img") else None


def _nyt_image_led_editorial(
    soup: BeautifulSoup,
    *,
    body: BeautifulSoup,
    canonical_url: str,
    metadata: dict[str, Any],
) -> bool:
    """Recognize short NYT visual features whose figures are the body.

    These pages are ordinary ``ARTICLE`` records rather than NYT galleries:
    the HTML contains a short dek followed by figure/caption blocks.  Keep
    the rule deliberately narrow so an unhydrated interactive shell cannot
    satisfy the short-body exemption.
    """
    if "/interactive/" in canonical_url.casefold():
        return False
    article_body = body.select_one(
        "[name='articleBody'], section[name='articleBody'], article"
    )
    if not isinstance(article_body, Tag):
        article_body = soup.select_one(
            "[name='articleBody'], section[name='articleBody'], article"
        )
    if isinstance(article_body, Tag):
        figures = article_body.select("figure")
        captions = [
            _clean_text(caption.get_text(" ", strip=True))
            for caption in article_body.select("figure figcaption")
        ]
        caption_characters = sum(len(value) for value in captions)
        has_media = bool(
            figures
            and article_body.select_one(
                "figure img[src], figure source[srcset], "
                "figure [data-testid='lazy-image']"
            )
        )
        if has_media and caption_characters >= 60:
            return True

        path = urlsplit(canonical_url).path.casefold()
        html_classes = {
            str(value).casefold()
            for value in (soup.html.get("class", []) if soup.html else [])
        }
        story_paragraphs = soup.select(
            "article p.story-body-text.story-content[data-total-count]"
        )
        declared_totals: list[int] = []
        for paragraph in story_paragraphs:
            raw_total = paragraph.get("data-total-count")
            if isinstance(raw_total, str) and raw_total.isdigit():
                declared_totals.append(int(raw_total))
        story_text = _clean_text(
            " ".join(
                paragraph.get_text(" ", strip=True)
                for paragraph in story_paragraphs
            )
        )
        declared_story_complete = False
        if declared_totals:
            declared_total = max(declared_totals)
            declared_story_complete = bool(
                20 <= declared_total <= 300
                and len(story_text) >= max(20, int(declared_total * 0.75))
            )

        # NYT's legacy T Magazine ``format-short`` template sometimes used a
        # single illustration as the whole feature and published only a short
        # italic dek plus an image credit.  The ordinary caption threshold
        # above correctly rejects generic lede images, but it also rejects
        # these intentionally tiny visual articles.  The cumulative
        # ``data-total-count`` and the rendered story footer jointly prove
        # that the archived page reached its publisher-declared end; requiring
        # both keeps a truncated first paragraph from receiving this exemption.
        legacy_visual_end_rendered = bool(
            (
                soup.select_one("article#story > nav#next-in") is not None
                and soup.select_one("article#story ~ section#whats-next")
                is not None
            )
            or (
                soup.select_one(
                    "article#story > footer.story-footer.story-content"
                )
                is not None
                and soup.select_one("article#story ~ section#whats-next")
                is not None
                and soup.select_one("footer#page-footer[role='contentinfo']")
                is not None
            )
        )
        if (
            has_media
            and declared_story_complete
            and "/t-magazine/" in path
            and {"section-t-magazine", "format-short"}.issubset(html_classes)
            and soup.select_one(
                "article .story-footer .story-print-citation, "
                "article footer.story-footer .story-print-citation"
            )
            is not None
        ):
            return True

        # The immediately preceding Opinion template used the same short-form
        # contract for single-panel cartoons, but placed the illustration in a
        # lede container instead of a captioned story-body figure.  Require the
        # publisher-declared total, matching social description, blank prose
        # byline, editorial image host and both rendered end-of-story markers.
        # Together these distinguish a complete cartoon from a truncated first
        # paragraph that merely happens to retain its lede image.
        lead_image = article_body.select_one(
            "figure[itemprop='associatedMedia'] img[itemprop='url'][src]"
        )
        lead_source = (
            _string_or_none(lead_image.get("src"))
            if isinstance(lead_image, Tag)
            else None
        )
        lead_parts = urlsplit(lead_source or "")
        legacy_description = _clean_text(
            _meta_content(soup, "property", "og:description") or ""
        )
        if (
            has_media
            and declared_story_complete
            and "/opinion/" in path
            and {
                "section-opinion",
                "format-short",
                "has-large-lede",
            }.issubset(html_classes)
            and story_text.casefold() == legacy_description.casefold()
            and soup.select_one("meta[name='author'][content='']") is not None
            and soup.select_one("meta[name='byl'][content='']") is not None
            and (lead_parts.hostname or "").casefold() == "static01.nyt.com"
            and "/opinion/" in lead_parts.path.casefold()
            and legacy_visual_end_rendered
        ):
            return True

    # NYT's 2014-era Opinion cartoons are intentional image-led records, but
    # the migrated page keeps the illustration only in og:image rather than
    # in an article-body figure.  The publisher's preloaded Article object
    # still proves the tiny word count and lack of a prose byline.  Keep this
    # fallback narrow so a truncated ordinary Opinion article cannot pass on
    # the strength of a generic social image alone.
    path = urlsplit(canonical_url).path.casefold()
    word_count = metadata.get("word_count")
    description = _clean_text(str(metadata.get("description") or ""))
    authors = metadata.get("authors")
    lead_image = _meta_content(soup, "property", "og:image")
    image_parts = urlsplit(lead_image or "")
    return bool(
        "/opinion/" in path
        and isinstance(word_count, int)
        and 1 <= word_count <= 30
        and isinstance(authors, list)
        and not authors
        and 15 <= len(description) < 200
        and (image_parts.hostname or "").casefold() == "static01.nyt.com"
        and "/opinion/" in image_parts.path.casefold()
        and re.search(
            r"-articlelarge\.(?:gif|jpe?g|png|webp)$",
            image_parts.path,
            flags=re.IGNORECASE,
        )
        is not None
    )


def _nyt_legacy_slideshow_json_rows(
    soup: BeautifulSoup,
) -> list[tuple[str, str | None, str | None]]:
    """Recover ordered images from NYT's pre-React slideshow JSON."""
    for script in soup.select('script[type="application/json"]'):
        raw = script.string or script.get_text()
        if not raw or '"imageslideshow"' not in raw:
            continue
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        slideshow = payload.get("imageslideshow")
        slides = (
            slideshow.get("slides")
            if isinstance(slideshow, dict)
            else None
        )
        if not isinstance(slides, list):
            continue
        rows: list[tuple[str, str | None, str | None]] = []
        seen: set[str] = set()
        for slide in slides:
            if not isinstance(slide, dict):
                continue
            crops = slide.get("image_crops")
            if not isinstance(crops, dict):
                continue
            renditions = [
                value
                for value in crops.values()
                if isinstance(value, dict)
                and isinstance(value.get("url"), str)
            ]
            if not renditions:
                continue
            rendition = max(
                renditions,
                key=lambda item: (
                    int(item.get("width") or 0)
                    * int(item.get("height") or 0),
                    int(item.get("width") or 0),
                ),
            )
            url = str(rendition["url"])
            identity = _image_identity(url)
            if identity in seen:
                continue
            seen.add(identity)
            caption_value = slide.get("caption")
            caption_html = (
                _first_text(
                    _string_or_none(caption_value.get("full")),
                    _string_or_none(caption_value.get("short")),
                )
                if isinstance(caption_value, dict)
                else None
            )
            rows.append(
                (
                    url,
                    _clean_text(
                        BeautifulSoup(
                            caption_html,
                            "html.parser",
                        ).get_text(" ")
                    )
                    if caption_html
                    else None,
                    _string_or_none(slide.get("credit")),
                )
            )
        if len(rows) >= 3:
            return rows
    return []


def _nyt_legacy_lede_video_body(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> Tag | None:
    """Preserve the destination of old NYT video-led short articles."""
    lead = soup.select_one(
        "figure.video.lede[data-videoid], "
        "figure.media.video.lede"
    )
    if not isinstance(lead, Tag):
        return None
    link = lead.select_one(
        "a.video-link[href], a[href*='/video/'][href]"
    )
    if not isinstance(link, Tag):
        return None
    destination = _string_or_none(link.get("href"))
    if not destination:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if body is not None:
        body_copy = BeautifulSoup(str(body), "html.parser")
        copied_root = body_copy.find(body.name)
        if isinstance(copied_root, Tag):
            article.append(copied_root)
    iframe = document.new_tag("iframe")
    iframe["src"] = destination
    iframe["title"] = (
        _tag_text(lead.select_one(".headline"))
        or "Related New York Times video"
    )
    article.append(iframe)
    return article


def _ft_crossword_body(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> Tag | None:
    """Preserve the downloadable puzzle asset on FT crossword pages."""
    headline = _first_text(
        _meta_content(soup, "property", "og:title"),
        _tag_text(soup.select_one("h1")),
    )
    if not headline or "crossword" not in headline.casefold():
        return None
    link = next(
        (
            candidate
            for candidate in soup.select("a[href]")
            if "crossword pdf"
            in _clean_text(candidate.get_text(" ", strip=True)).casefold()
        ),
        None,
    )
    if not isinstance(link, Tag):
        return None
    destination = _string_or_none(link.get("href"))
    if not destination:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if body is not None:
        body_copy = BeautifulSoup(str(body), "html.parser")
        copied_root = body_copy.find(body.name)
        if isinstance(copied_root, Tag):
            article.append(copied_root)
    iframe = document.new_tag("iframe")
    iframe["src"] = destination
    iframe["title"] = "Download crossword PDF"
    article.append(iframe)
    return article


def _nyt_preloaded_visual_story_rows(
    state: dict[str, Any],
    *,
    minimum_rows: int = 3,
) -> list[tuple[str, str | None, str | None]]:
    """Recover ordered NYT visual stories composed from image/diptych blocks."""
    body = next(
        (
            value
            for key, value in state.items()
            if key.endswith(".sprinkledBody")
            and isinstance(value, dict)
            and value.get("__typename") == "DocumentBlock"
        ),
        None,
    )
    if body is None:
        return []
    content = body.get("content@filterEmpty")
    if not isinstance(content, list):
        return []

    image_references: list[Any] = []
    for block_reference in content:
        block = _nyt_state_reference(state, block_reference)
        if block is None:
            continue
        block_type = block.get("__typename")
        if block_type == "ImageBlock":
            image_references.append(block.get("media"))
        elif block_type in {"DiptychBlock", "TriptychBlock"}:
            image_references.extend(
                block.get(key)
                for key in ("imageOne", "imageTwo", "imageThree")
            )
        elif isinstance(block_type, str) and block_type.startswith("Header"):
            lede_block = _nyt_state_reference(state, block.get("ledeMedia"))
            if lede_block is not None:
                image_references.append(lede_block.get("media"))

    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()
    for image_reference in image_references:
        image = _nyt_state_reference(state, image_reference)
        if image is None:
            continue
        renditions = _nyt_image_renditions(state, image)
        if not renditions:
            continue
        rendition = max(
            renditions,
            key=lambda item: (
                int(item.get("width") or 0) * int(item.get("height") or 0),
                int(item.get("width") or 0),
            ),
        )
        url = str(rendition["url"])
        identity = _image_identity(url)
        if identity in seen:
            continue
        seen.add(identity)
        legacy_caption = _string_or_none(image.get("legacyHtmlCaption"))
        caption_value = _nyt_state_reference(state, image.get("caption"))
        caption = (
            _clean_text(
                BeautifulSoup(legacy_caption, "html.parser").get_text(" ")
                if re.search(r"<[a-z][^>]*>", legacy_caption, re.I)
                else legacy_caption
            )
            if legacy_caption
            else None
        )
        if caption is None and caption_value is not None:
            caption = _first_text(
                _string_or_none(caption_value.get("text")),
                _string_or_none(caption_value.get("html")),
            )
        rows.append(
            (
                url,
                caption,
                _string_or_none(image.get("credit")),
            )
        )
    return rows if len(rows) >= minimum_rows else []


def _nyt_itemprop_gallery_rows(
    soup: BeautifulSoup,
) -> list[tuple[str, str | None, str | None]]:
    article = soup.select_one("article")
    if not isinstance(article, Tag):
        return []
    paragraph_characters = sum(
        len(text)
        for paragraph in article.select("p")
        if (
            (text := _clean_text(paragraph.get_text(" ", strip=True)))
            and paragraph.find_parent("header") is None
            and text.casefold() not in {"advertisement", "supported by"}
            and not text.casefold().startswith("by ")
        )
    )
    if paragraph_characters >= _MINIMUM_BODY_CHARACTERS:
        return []
    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()
    for figure in article.select(
        "figure[itemid][itemtype*='ImageObject' i]"
    ):
        url = _string_or_none(figure.get("itemid"))
        if not url:
            continue
        identity = _image_identity(url)
        if identity in seen:
            continue
        seen.add(identity)
        caption = _tag_text(
            figure.select_one(
                "figcaption [itemprop='caption description'], "
                "figcaption"
            )
        )
        credit = _tag_text(
            figure.select_one(
                "[itemprop='copyrightHolder'], "
                "[itemprop='creditText']"
            )
        )
        rows.append((url, caption, credit))
    return rows if len(rows) >= 3 else []


def _nyt_legacy_op_art_gallery(soup: BeautifulSoup) -> Tag | None:
    lead_story = soup.select_one(".ledeStory")
    source_node: Tag | None = None
    description: str | None = None
    caption_description: str | None = None
    credit: str | None = None
    if isinstance(lead_story, Tag):
        kicker = _tag_text(
            lead_story.select_one(".kicker, .storyHeader")
        )
        if kicker and "op-art" in kicker.casefold():
            candidate = lead_story.select_one("img[src]")
            if isinstance(candidate, Tag):
                source_node = candidate
                description = _tag_text(
                    lead_story.select_one(".storySummary")
                )
                caption_description = description
                credit = _tag_text(
                    soup.select_one(
                        ".interactiveFooter .module, .interactiveFooter"
                    )
                )

    if source_node is None:
        # The 2018 React story template put a single editorial cartoon in an
        # otherwise empty articleBody section.  The generic body selector can
        # land on an empty companion column, so recover the explicitly marked
        # ImageObject when the article proves this is a cartoon page.  Early
        # React snapshots put the cartoonist role in the story header; later
        # snapshots moved it to the extended-information footer while leaving
        # the actual lede figure in that same article.
        modern_article = soup.select_one("article#story, main article")
        cartoon_signal = (
            _clean_text(
                " ".join(
                    node.get_text(" ", strip=True)
                    for node in modern_article.select(
                        "header, [class*='ExtendedInformation']"
                    )
                )
            )
            if isinstance(modern_article, Tag)
            else ""
        )
        candidate = (
            modern_article.select_one(
                "figure[itemtype*='ImageObject' i] "
                "img[src*='-articleLarge' i]"
            )
            if isinstance(modern_article, Tag)
            else None
        )
        if (
            isinstance(candidate, Tag)
            and "editorial cartoonist" in cartoon_signal.casefold()
        ):
            source_node = candidate
            description = _first_text(
                _meta_content(soup, "name", "description"),
                _meta_content(soup, "property", "og:description"),
            )
            caption_description = description
            if description and any(
                _clean_text(paragraph.get_text(" ", strip=True)).casefold()
                == description.casefold()
                for paragraph in modern_article.select(
                    "[name='articleBody'] p, "
                    "section[name='articleBody'] p, "
                    ".StoryBodyCompanionColumn p"
                )
            ):
                # React opinion cartoons repeat their short explanatory dek
                # in metadata and the real article body.  Keep it as image
                # alt text, but do not duplicate it as a figure caption when
                # the prose block will be combined immediately afterwards.
                caption_description = None
            credit = _first_text(
                _tag_text(
                    modern_article.select_one("[itemprop~='author']")
                ),
                _meta_content(soup, "name", "byl"),
            )

    if source_node is None:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    figure = document.new_tag("figure")
    image = document.new_tag("img")
    for attribute in (
        "src",
        "srcset",
        "sizes",
        "width",
        "height",
        "itemid",
        "itemprop",
    ):
        value = source_node.get(attribute)
        if value:
            image[attribute] = value
    if description:
        image["alt"] = description
    figure.append(image)
    if caption_description or credit:
        figcaption = document.new_tag("figcaption")
        if caption_description:
            figcaption.append(caption_description)
        if credit:
            if caption_description:
                figcaption.append(" ")
            credit_node = document.new_tag("span")
            credit_node["class"] = "image-credit"
            credit_node.string = credit
            figcaption.append(credit_node)
        figure.append(figcaption)
    article.append(figure)
    return article


def _nyt_adventure_resource_body(
    soup: BeautifulSoup,
    *,
    dependent_resources: dict[str, bytes],
) -> Tag | None:
    """Recover quiz prose serialized inside an archived Adventure JS bundle."""
    script_urls = {
        _normalized_url(
            str(script.get("src") or ""),
            base_url="https://www.nytimes.com/",
        )
        for script in soup.select(
            "#adventure-project-container script[src], "
            "section.interactive-content script[src]"
        )
    }
    matching_javascript = [
        content.decode("utf-8", errors="replace")
        for url, content in dependent_resources.items()
        if _normalized_url(url, base_url="https://www.nytimes.com/")
        in script_urls
    ]
    matching_javascript.extend(
        script.string or script.get_text()
        for script in soup.select(
            "#adventure-project-container script:not([src]), "
            "section.interactive-content script:not([src])"
        )
        if "entitiesById" in (script.string or script.get_text())
    )
    for javascript in matching_javascript:
        for match in re.finditer(
            r"""JSON\.parse\('((?:\\.|[^'\\])*)'\)""",
            javascript,
        ):
            serialized = match.group(1)
            if '"entitiesById"' not in serialized:
                continue
            try:
                decoded = ast.literal_eval(f"'{serialized}'")
                payload = json.loads(decoded)
            except (SyntaxError, ValueError, json.JSONDecodeError):
                continue
            body = _nyt_adventure_entity_body(payload)
            if body is not None:
                return body
        body = _nyt_adventure_javascript_body(javascript)
        if body is not None:
            return body
    return None


def _nyt_adventure_javascript_body(javascript: str) -> Tag | None:
    """Recover editorial quiz text from an inline compiled Adventure bundle.

    Early Adventure pages serialize their entity store as a JavaScript object
    rather than JSON.  Parsing arbitrary JavaScript would be unsafe and
    brittle, so retain only string literals in the publisher's explicit
    ``data.content`` fields after confirming that the bundle contains a real
    multi-question quiz.
    """

    if (
        "entitiesById" not in javascript
        or len(re.findall(r'type:["\']multiple_choice_question["\']', javascript))
        < 3
    ):
        return None
    values: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(
        r"""data:\{content:("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""",
        javascript,
    ):
        literal = match.group(1)
        try:
            decoded = (
                json.loads(literal)
                if literal.startswith('"')
                else ast.literal_eval(literal)
            )
        except (SyntaxError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(decoded, str):
            continue
        rendered = (
            BeautifulSoup(decoded, "html.parser").get_text(" ", strip=True)
            if "<" in decoded
            else decoded
        )
        rendered = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", rendered)
        clean = _clean_text(rendered)
        identity = clean.casefold()
        if clean and identity not in seen:
            seen.add(identity)
            values.append(clean)
    substantial = [value for value in values if len(value) >= 20]
    if len(substantial) < 3 or sum(map(len, substantial)) < 500:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='nyt-adventure-inline'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    for value in values:
        paragraph = document.new_tag("p")
        paragraph.string = value
        article.append(paragraph)
    return article


def _nyt_adventure_entity_body(payload: object) -> Tag | None:
    if not isinstance(payload, dict):
        return None
    entities = payload.get("entitiesById")
    root_id = payload.get("root")
    if not isinstance(entities, dict) or not isinstance(root_id, str):
        return None
    root = entities.get(root_id)
    if not isinstance(root, dict) or root.get("type") != "quiz":
        return None
    question_ids = [
        value
        for value in root.get("entities", [])
        if (
            isinstance(value, str)
            and isinstance(entities.get(value), dict)
            and entities[value].get("type") == "multiple_choice_question"
        )
    ]
    if len(question_ids) < 3:
        return None

    def entity_text(entity_id: object) -> str | None:
        entity = entities.get(entity_id)
        if not isinstance(entity, dict):
            return None
        data = entity.get("data")
        content = data.get("content") if isinstance(data, dict) else None
        if not isinstance(content, str):
            return None
        # Adventure text supports Markdown plus small HTML fragments.
        rendered = BeautifulSoup(content, "html.parser").get_text(
            " ",
            strip=True,
        )
        rendered = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", rendered)
        return _clean_text(rendered) or None

    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for number, question_id in enumerate(question_ids, start=1):
        question = entities[question_id]
        children = question.get("entities", [])
        if not isinstance(children, list):
            continue
        prompt = next(
            (
                entity_text(child_id)
                for child_id in children
                if (
                    isinstance(entities.get(child_id), dict)
                    and entities[child_id].get("type") == "text"
                )
            ),
            None,
        )
        answers: list[tuple[str, bool]] = []
        explanation: str | None = None
        for child_id in children:
            child = entities.get(child_id)
            if not isinstance(child, dict):
                continue
            child_type = child.get("type")
            descendants = child.get("entities", [])
            if not isinstance(descendants, list):
                continue
            if child_type == "answer":
                answer_text = next(
                    (entity_text(value) for value in descendants if entity_text(value)),
                    None,
                )
                data = child.get("data")
                correct = bool(
                    isinstance(data, dict) and data.get("correct") is True
                )
                if answer_text:
                    answers.append((answer_text, correct))
            elif child_type == "response":
                explanation = next(
                    (
                        entity_text(value)
                        for value in descendants
                        if (
                            isinstance(entities.get(value), dict)
                            and entities[value].get("type") == "text"
                            and entity_text(value)
                        )
                    ),
                    None,
                )
        if not prompt or len(answers) < 2:
            continue
        heading = document.new_tag("h2")
        heading.string = f"{number}. {prompt}"
        article.append(heading)
        choices = document.new_tag("ul")
        for answer_text, _ in answers:
            item = document.new_tag("li")
            item.string = answer_text
            choices.append(item)
        article.append(choices)
        correct_answers = [text for text, correct in answers if correct]
        if correct_answers:
            answer_paragraph = document.new_tag("p")
            answer_paragraph.string = (
                "Correct answer: " + "; ".join(correct_answers)
            )
            article.append(answer_paragraph)
        if explanation:
            explanation_paragraph = document.new_tag("p")
            explanation_paragraph.string = explanation
            article.append(explanation_paragraph)
    text = _clean_text(article.get_text(" ", strip=True))
    return article if len(text) >= 500 else None


def _nyt_legacy_interactive_graphic(soup: BeautifulSoup) -> Tag | None:
    shell = soup.select_one("#interactiveShell, #main")
    freeform = soup.select_one("#interactiveFreeFormMain")
    if not isinstance(shell, Tag) or not isinstance(freeform, Tag):
        return None
    freeform_text = _clean_text(freeform.get_text(" ", strip=True))
    if (
        len(freeform_text) >= _MINIMUM_BODY_CHARACTERS
        and freeform.select_one("p, table, ul, ol, h2, h3") is not None
    ):
        # Some pre-React interactives put the complete, already-rendered
        # article (including comparison tables) in this container.  Rebuilding
        # it from only the deck and media silently discarded that prose.
        recovered_document = BeautifulSoup(str(freeform), "html.parser")
        recovered = recovered_document.select_one("#interactiveFreeFormMain")
        if isinstance(recovered, Tag):
            return recovered
    summary = _tag_text(shell.select_one(".storySummary .summary, .storySummary"))
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if summary and not summary.casefold().startswith("related article"):
        paragraph = document.new_tag("p")
        paragraph.string = summary
        article.append(paragraph)
    seen_images: set[str] = set()
    for source_image in freeform.select("img[src]"):
        source = _tag_attribute(source_image, "src")
        if (
            not source
            or any(
                marker in source.casefold()
                for marker in (
                    "nytlogo",
                    "masthead-logo",
                    "/adx/",
                    "up.nytimes.com",
                    "wt.o.nytimes.com",
                    "unavailable-photo",
                )
            )
        ):
            continue
        identity = _image_identity(source)
        if identity in seen_images:
            continue
        seen_images.add(identity)
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = source
        alt = _first_text(
            _string_or_none(source_image.get("alt")),
            summary if len(seen_images) == 1 else None,
        )
        if alt:
            image["alt"] = alt
        figure.append(image)
        article.append(figure)
    embed_rows: list[tuple[str, str | None]] = []
    for anchor in freeform.select("a[href]"):
        href = _string_or_none(anchor.get("href"))
        if href and re.search(r"(?i)\.(?:pdf|txt|csv)(?:$|[?#])", href):
            embed_rows.append((href, _tag_text(anchor)))
    for script in freeform.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""DV\.load\(\s*["'](?P<url>(?:https?:)?//"""
            r"""(?:www\.)?documentcloud\.org/documents/[^"']+?)"""
            r"""(?:\.js)?["']""",
            value,
            flags=re.IGNORECASE,
        )
        if match:
            url = match.group("url")
            if url.startswith("//"):
                url = f"https:{url}"
            url = re.sub(r"\.js$", "", url, flags=re.IGNORECASE)
            embed_rows.append((url, "DocumentCloud document"))
    seen_embeds: set[str] = set()
    for href, label in embed_rows:
        normalized = _normalized_url(href, base_url="https://www.nytimes.com/")
        if not normalized or normalized in seen_embeds:
            continue
        seen_embeds.add(normalized)
        iframe = document.new_tag("iframe")
        iframe["src"] = normalized
        if label:
            iframe["title"] = label
        article.append(iframe)
    sources = _tag_text(
        shell.select_one(
            "#interactiveFooter .sources, "
            "#interactiveFooter .credit"
        )
    )
    if sources:
        figcaption = document.new_tag("figcaption")
        figcaption.string = sources
        last_figure = article.find_all("figure")[-1] if article.find("figure") else None
        if isinstance(last_figure, Tag):
            last_figure.append(figcaption)
        else:
            article.append(figcaption)
    return article if article.select_one("p, figure, iframe") else None


def _nyt_embedded_interactive_lede(soup: BeautifulSoup) -> Tag | None:
    """Recover legacy NYT interactive ledes whose full story lives in a figure."""
    graphic = soup.select_one(
        "figure.interactive-embedded .interactive-graphic"
    )
    if not isinstance(graphic, Tag):
        return None
    if graphic.select_one("p, table, img[src]") is None:
        return None
    document = BeautifulSoup(str(graphic), "html.parser")
    recovered = document.select_one(".interactive-graphic")
    if not isinstance(recovered, Tag):
        return None
    # Table extraction preserves the comparison text as one structured block,
    # but images nested inside legacy table cells need explicit media blocks.
    for table in recovered.select("table"):
        insertion_point: Tag = table
        for source_image in table.select("img[src]"):
            figure = document.new_tag("figure")
            image = document.new_tag("img")
            for attribute in ("src", "data-src", "alt", "width", "height"):
                value = source_image.get(attribute)
                if value is not None:
                    image[attribute] = value
            figure.append(image)
            cell = source_image.find_parent(["td", "th"])
            caption = (
                _tag_text(cell.select_one(".caption"))
                if isinstance(cell, Tag)
                else None
            )
            if caption:
                figcaption = document.new_tag("figcaption")
                figcaption.string = caption
                figure.append(figcaption)
            insertion_point.insert_after(figure)
            insertion_point = figure
    return recovered


def _nyt_noninteractive_body_length(body: Tag) -> int:
    """Measure surrounding prose without counting an embedded graphic twice."""
    document = BeautifulSoup(str(body), "html.parser")
    copy = document.find()
    if not isinstance(copy, Tag):
        return 0
    for graphic in copy.select(
        "figure.interactive-embedded, .interactive-graphic"
    ):
        graphic.decompose()
    return len(_clean_text(copy.get_text(" ", strip=True)))


def _nyt_inline_interactive_media(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover image sequences embedded in JavaScript-only legacy graphics."""
    if (
        "/interactive/" not in canonical_url.casefold()
        and not soup.select_one("#interactiveShell")
    ):
        return None
    graphic = soup.select_one(".interactive-graphic")
    if not isinstance(graphic, Tag):
        return None
    scope = graphic.find_parent("article") or graphic
    urls: list[str] = []
    alt_by_identity: dict[str, str] = {}
    seen: set[str] = set()
    for source in scope.select("script, style"):
        value = (source.string or source.get_text()).replace("\\/", "/")
        for match in re.finditer(
            r"""(?i)(?:https?:)?//(?:graphics\d*|static\d*)"""
            r"""\.(?:nytimes|nyt)\.com/[^"'()<>\s]+?"""
            r"""\.(?:jpe?g|png|gif)(?:\?[^"'()<>\s]*)?""",
            value,
        ):
            url = match.group(0)
            if url.startswith("//"):
                url = f"https:{url}"
            identity = _image_identity(url)
            if identity in seen:
                continue
            seen.add(identity)
            urls.append(url)
    styled_nodes = list(scope.select("[style*='background-image']"))
    for node in soup.select(".g-victim-photo[style*='background-image']"):
        if node not in styled_nodes:
            styled_nodes.append(node)
    for node in styled_nodes:
        value = _string_or_none(node.get("style"))
        if not value:
            continue
        for match in re.finditer(
            r"""(?i)(?:https?:)?//(?:graphics\d*|static\d*)"""
            r"""\.(?:nytimes|nyt)\.com/[^"'()<>\s]+?"""
            r"""\.(?:jpe?g|png|gif)(?:\?[^"'()<>\s]*)?""",
            value.replace("\\/", "/"),
        ):
            url = match.group(0)
            if url.startswith("//"):
                url = f"https:{url}"
            identity = _image_identity(url)
            label = _first_text(
                _string_or_none(node.get("data-name")),
                _string_or_none(node.get("aria-label")),
            )
            if label:
                alt_by_identity[identity] = _clean_text(
                    label.replace("_", " ").replace("-", " ")
                )
            if identity in seen:
                continue
            seen.add(identity)
            urls.append(url)
    if len(urls) < 2:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for url in urls:
        figure = document.new_tag("figure")
        image = document.new_tag("img")
        image["src"] = url
        alt = alt_by_identity.get(_image_identity(url))
        if alt:
            image["alt"] = alt
        figure.append(image)
        article.append(figure)
    return article


def _nyt_legacy_newsgraphic_body(soup: BeautifulSoup) -> Tag | None:
    """Recover malformed legacy graphics whose generated nodes escaped article."""
    if not soup.select_one(".interactive-graphic"):
        return None
    if not soup.select_one(".g-victim-photo, .g-item-image"):
        return None
    paragraphs = [
        node
        for node in soup.select(".g-body")
        if _tag_text(node)
    ]
    if len(paragraphs) < 5:
        return None
    if sum(len(_tag_text(node) or "") for node in paragraphs) < 500:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen_text: set[str] = set()
    seen_images: set[str] = set()
    for node in soup.select(".g-body, .g-item-image img[src]"):
        if node.name == "img":
            source = _tag_attribute(node, "src")
            if not source:
                continue
            identity = _image_identity(source)
            if identity in seen_images:
                continue
            seen_images.add(identity)
            figure = document.new_tag("figure")
            image = document.new_tag("img")
            image["src"] = source
            alt = _tag_attribute(node, "alt")
            if alt:
                image["alt"] = alt
            figure.append(image)
            article.append(figure)
            continue
        text = _tag_text(node)
        identity = text.casefold() if text else ""
        if not text or identity in seen_text:
            continue
        seen_text.add(identity)
        paragraph = document.new_tag("p")
        paragraph.string = text
        article.append(paragraph)
    return article if article.select_one("p") else None


def _nyt_legacy_standalone_newsgraphic_body(
    soup: BeautifulSoup,
) -> Tag | None:
    """Recover complete pre-React newsgraphics published outside ``article``.

    Long-form packages such as the 2013 ``newsgraphics/.../russia`` feature
    use ``div.main > div.article`` and hydrate their slideshows and videos
    from data attributes.  The ordinary NYT selectors therefore see no body
    even though the archived HTML contains all prose and captions.
    """

    source = soup.select_one("div.main > div.article")
    if not isinstance(source, Tag):
        return None
    sections = source.select(":scope > div.section")
    if (
        len(sections) < 3
        or len(source.select("p")) < 5
        or len(source.select("h3.text")) < 2
    ):
        return None

    script_text = "\n".join(
        script.string or script.get_text()
        for script in soup.select("script")
    )
    slideshow_match = re.search(
        r"https?://[^\s\"']+/newsgraphics/[^\s\"']+?/assets/",
        script_text,
        flags=re.IGNORECASE,
    )
    if not slideshow_match:
        return None
    slideshow_root = slideshow_match.group(0).replace("http://", "https://")
    video_match = re.search(
        r"https?://[^\s\"']+/newsgraphics/[^\s\"']+?-videos/"
        r"[^\s\"']+?/",
        script_text,
        flags=re.IGNORECASE,
    )
    video_root = (
        video_match.group(0).replace("http://", "https://")
        if video_match
        else None
    )

    recovered_document = BeautifulSoup(str(source), "html.parser")
    recovered = recovered_document.select_one("div.article")
    if not isinstance(recovered, Tag):
        return None
    recovered.name = "article"
    recovered["data-jojo-source"] = "nyt-legacy-standalone-newsgraphic"
    for node in list(
        recovered.select(
            "style, script, .map-section, .map-marker, "
            ".advertisement-section, .footer-section"
        )
    ):
        node.decompose()

    for slideshow in list(recovered.select(".slideshow")):
        gallery = recovered_document.new_tag("div")
        gallery["data-jojo-gallery"] = "nyt-legacy-newsgraphic"
        for caption_node in slideshow.select(
            ".slideshow-caption[data-slug]"
        ):
            slug = _string_or_none(caption_node.get("data-slug"))
            if not slug:
                continue
            caption = _tag_text(caption_node)
            figure = recovered_document.new_tag("figure")
            image = recovered_document.new_tag(
                "img",
                src=f"{slideshow_root}large/{slug}.jpg",
            )
            if caption:
                image["alt"] = caption
            figure.append(image)
            if caption:
                figcaption = recovered_document.new_tag("figcaption")
                figcaption.string = caption
                figure.append(figcaption)
            gallery.append(figure)
        if gallery.select_one("figure") is not None:
            slideshow.replace_with(gallery)

    for video in list(recovered.select(".video")):
        container = video.select_one(
            ".video-container[data-slug], "
            ".video-container[data-poster-slug]"
        )
        if not isinstance(container, Tag):
            continue
        slug = _string_or_none(container.get("data-slug"))
        poster_slug = _string_or_none(container.get("data-poster-slug"))
        caption = _tag_text(video.select_one(".video-caption"))
        replacement = recovered_document.new_tag("div")
        replacement["data-jojo-video"] = "nyt-legacy-newsgraphic"
        if poster_slug:
            figure = recovered_document.new_tag("figure")
            image = recovered_document.new_tag(
                "img",
                src=f"{slideshow_root}large/{poster_slug}.jpg",
            )
            if caption:
                image["alt"] = caption
            figure.append(image)
            if caption:
                figcaption = recovered_document.new_tag("figcaption")
                figcaption.string = caption
                figure.append(figcaption)
            replacement.append(figure)
        if slug and video_root:
            size = "900" if "video--big" in (video.get("class") or []) else "600"
            iframe = recovered_document.new_tag(
                "iframe",
                src=f"{video_root}{slug}-{size}.mp4",
            )
            iframe["title"] = caption or "New York Times video"
            iframe["data-interactive-provider"] = "nyt-newsgraphics-video"
            replacement.append(iframe)
        if replacement.select_one("img, iframe") is not None:
            video.replace_with(replacement)

    text = _clean_text(recovered.get_text(" ", strip=True))
    return recovered if len(text) >= 500 else None


def _nyt_legacy_flex_body(soup: BeautifulSoup) -> Tag | None:
    """Recover text, statistics and media from NYT's legacy LOOK template."""
    payload: dict[str, Any] | None = None
    for script in soup.select(
        "#interactiveFreeFormMain script, .interactive-graphic script"
    ):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?s)function\s+getFlexData\s*\(\s*\)\s*\{\s*"""
            r"""return\s*(?P<payload>\{.*?\})\s*;\s*\}""",
            value,
        )
        if not match:
            continue
        try:
            candidate = json.loads(match.group("payload"))
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    lede = data.get("lede")
    if isinstance(lede, dict):
        description = _string_or_none(lede.get("description"))
        if description:
            paragraph = document.new_tag("p")
            paragraph.string = description
            article.append(paragraph)
    tracks = data.get("tracks")
    if isinstance(tracks, dict):
        track_rows = tracks.get("track")
        if isinstance(track_rows, dict):
            track_rows = [track_rows]
        if isinstance(track_rows, list):
            for track in track_rows:
                if not isinstance(track, dict):
                    continue
                source = _string_or_none(track.get("source"))
                if not source:
                    continue
                audio = document.new_tag("audio")
                audio["src"] = source
                title = _string_or_none(track.get("title"))
                if title:
                    audio["title"] = title
                article.append(audio)
    item_columns = data.get("items")
    if isinstance(item_columns, list):
        for column in item_columns:
            stories = (
                column.get("story")
                if isinstance(column, dict)
                else None
            )
            if not isinstance(stories, list):
                continue
            for story in stories:
                if not isinstance(story, dict):
                    continue
                headline = _string_or_none(story.get("headline"))
                if headline:
                    heading = document.new_tag("h2")
                    heading.string = headline
                    article.append(heading)
                byline = _string_or_none(story.get("byline"))
                if byline:
                    paragraph = document.new_tag("p")
                    paragraph.string = _clean_text(
                        BeautifulSoup(
                            byline,
                            "html.parser",
                        ).get_text(" ")
                    )
                    article.append(paragraph)
                story_html = _string_or_none(story.get("text"))
                if story_html:
                    fragment = BeautifulSoup(story_html, "html.parser")
                    for child in list(fragment.contents):
                        article.append(child)
                for field in ("photo", "thumb", "bottom"):
                    source = _string_or_none(story.get(field))
                    if not source:
                        continue
                    figure = document.new_tag("figure")
                    image = document.new_tag("img")
                    image["src"] = source
                    if headline:
                        image["alt"] = headline
                    figure.append(image)
                    credit = _string_or_none(story.get("pcred"))
                    if credit:
                        figcaption = document.new_tag("figcaption")
                        figcaption.string = credit
                        figure.append(figcaption)
                    article.append(figure)
    column_two = data.get("col2")
    if isinstance(column_two, dict):
        text = _string_or_none(column_two.get("text"))
        if text:
            paragraph = document.new_tag("p")
            paragraph.string = text
            article.append(paragraph)
    slideshow = _string_or_none(data.get("gobig"))
    if slideshow:
        iframe = document.new_tag("iframe")
        iframe["src"] = slideshow
        iframe["title"] = "Slideshow"
        article.append(iframe)
    column_three = data.get("col3")
    if isinstance(column_three, dict):
        video = column_three.get("video")
        if isinstance(video, dict):
            promo = _string_or_none(video.get("promo"))
            if promo:
                figure = document.new_tag("figure")
                image = document.new_tag("img")
                image["src"] = promo
                image["alt"] = _first_text(
                    _string_or_none(video.get("title")),
                    "Video",
                )
                figure.append(image)
                caption = " ".join(
                    value
                    for value in (
                        _string_or_none(video.get("caption")),
                        _string_or_none(video.get("credit")),
                    )
                    if value
                )
                if caption:
                    figcaption = document.new_tag("figcaption")
                    figcaption.string = caption
                    figure.append(figcaption)
                article.append(figure)
        stats = column_three.get("stats")
        if isinstance(stats, list):
            rendered_stats = [
                (
                    _string_or_none(item.get("key")),
                    (
                        str(item.get("value"))
                        if isinstance(item.get("value"), (int, float))
                        else _string_or_none(item.get("value"))
                    ),
                )
                for item in stats
                if isinstance(item, dict)
            ]
            rendered_stats = [
                (key, value)
                for key, value in rendered_stats
                if key and value
            ]
            if rendered_stats:
                stats_list = document.new_tag("ul")
                for key, value in rendered_stats:
                    item = document.new_tag("li")
                    item.string = f"{key}: {value}"
                    stats_list.append(item)
                article.append(stats_list)
    return article if article.select_one("p, iframe, figure, li") else None


def _nyt_interactive_document_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Preserve linked source documents in later legacy interactive shells."""
    if (
        "/interactive/" not in canonical_url.casefold()
        and not soup.select_one("#interactiveShell")
    ):
        return None
    story = soup.select_one(
        "article.story, article#interactive, .interactive-graphic"
    )
    if not isinstance(story, Tag):
        return None
    documents: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for anchor in story.select("a[href]"):
        href = _string_or_none(anchor.get("href"))
        if not href or not re.search(
            r"(?i)\.(?:pdf|txt|csv)(?:$|[?#])",
            href,
        ):
            continue
        normalized = _normalized_url(href, base_url="https://www.nytimes.com/")
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        documents.append((normalized, _tag_text(anchor)))
    for script in story.select("script"):
        value = script.string or script.get_text()
        for match in re.finditer(
            r"""DV\.(?:flexLoad|load)\(\s*["']"""
            r"""(?P<url>(?:https?:)?//"""
            r"""(?:www\.)?documentcloud\.org/documents/[^"']+?)"""
            r"""(?:\.js)?["']""",
            value,
            flags=re.IGNORECASE,
        ):
            url = match.group("url")
            if url.startswith("//"):
                url = f"https:{url}"
            url = re.sub(r"\.js$", "", url, flags=re.IGNORECASE)
            normalized = _normalized_url(url, base_url="https://www.nytimes.com/")
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            documents.append((normalized, "DocumentCloud document"))
    if not documents:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "name", "lp"),
        _meta_content(soup, "property", "og:description"),
    )
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    for href, label in documents:
        iframe = document.new_tag("iframe")
        iframe["src"] = href
        if label:
            iframe["title"] = label
        article.append(iframe)
    return article


def _nyt_document_card_body(soup: BeautifulSoup) -> Tag | None:
    """Preserve Oak articles whose entire body is a linked source document."""
    card_link = soup.select_one(
        "section[name='articleBody'] a.thumbnail-link[href*='/interactive/']"
    )
    if not isinstance(card_link, Tag):
        return None
    card = card_link.find_parent("div")
    if not isinstance(card, Tag):
        return None
    read_link = card.select_one("a[href] strong")
    if (
        not isinstance(read_link, Tag)
        or "read document" not in _clean_text(
            read_link.get_text(" ", strip=True)
        ).casefold()
    ):
        return None
    href = _normalized_url(
        card_link.get("href"),
        base_url="https://www.nytimes.com/",
    )
    if not href:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    heading_text = _tag_text(card.select_one("h2"))
    if heading_text:
        heading = document.new_tag("h2")
        heading.string = heading_text
        article.append(heading)
    iframe = document.new_tag("iframe")
    iframe["src"] = href
    iframe["title"] = heading_text or "Source document"
    article.append(iframe)
    return article


def _nyt_single_image_comics_body(soup: BeautifulSoup) -> Tag | None:
    """Recover intentionally image-only reviews published in comics format."""
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    if not description or "comics format" not in description.casefold():
        return None
    article_body = soup.select_one("section[name='articleBody']")
    if not isinstance(article_body, Tag):
        return None
    if _clean_text(article_body.get_text(" ", strip=True)):
        return None
    source_image = soup.select_one(
        "article figure img[src], article img[itemprop='url'][src]"
    )
    if not isinstance(source_image, Tag):
        return None
    source = _tag_attribute(source_image, "src")
    if not source:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    paragraph = document.new_tag("p")
    paragraph.string = description
    article.append(paragraph)
    figure = document.new_tag("figure")
    image = document.new_tag("img")
    image["src"] = source
    image["alt"] = _tag_attribute(source_image, "alt") or description
    figure.append(image)
    article.append(figure)
    return article


def _nyt_books_review_sketchbook_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
    metadata: dict[str, Any],
) -> Tag | None:
    """Preserve NYT Book Review Sketchbook's paragraph and illustration."""
    path = urlsplit(canonical_url).path.casefold()
    word_count = metadata.get("word_count")
    description = _clean_text(str(metadata.get("description") or ""))
    authors = metadata.get("authors")
    if (
        "/books/review/" not in path
        or not isinstance(word_count, int)
        or not 1 <= word_count <= 30
        or "illustrat" not in description.casefold()
        or not isinstance(authors, list)
        or len(authors) != 1
    ):
        return None

    labels = [
        node
        for node in soup.select("article p")
        if _clean_text(node.get_text(" ", strip=True)).casefold()
        == "sketchbook"
    ]
    paragraphs = [
        node
        for node in soup.select("article .StoryBodyCompanionColumn p")
        if _clean_text(node.get_text(" ", strip=True))
    ]
    figures = [
        node
        for node in soup.select(
            "article figure[itemprop='associatedMedia']"
        )
        if node.select_one("img[itemprop='url'][src]") is not None
    ]
    if len(labels) != 1 or len(paragraphs) != 1 or len(figures) != 1:
        return None

    paragraph_text = _clean_text(paragraphs[0].get_text(" ", strip=True))
    paragraph_words = re.findall(r"[\w’'-]+", paragraph_text)
    image = figures[0].select_one("img[itemprop='url'][src]")
    source = _normalized_url(
        _tag_attribute(image, "src") if isinstance(image, Tag) else None,
        base_url="https://www.nytimes.com/",
    )
    source_parts = urlsplit(source or "")
    credit = _clean_text(
        " ".join(
            node.get_text(" ", strip=True)
            for node in figures[0].select("figcaption")
        )
    ).casefold()
    author = _clean_text(str(authors[0])).casefold()
    if (
        not 40 <= len(paragraph_text) < 200
        or abs(len(paragraph_words) - word_count) > 3
        or (source_parts.hostname or "").casefold() != "static01.nyt.com"
        or "/books/review/" not in source_parts.path.casefold()
        or not author
        or author not in credit
    ):
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='nyt-books-review-sketchbook'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    article.append(copy.deepcopy(paragraphs[0]))
    article.append(copy.deepcopy(figures[0]))
    return article


def _nyt_preloaded_editorial_cartoon_body(
    soup: BeautifulSoup,
) -> Tag | None:
    """Recover migrated NYT cartoons whose only figure lives in Apollo state."""
    state = _nyt_preloaded_state(soup)
    explicitly_cartoon = any(
        isinstance(value, dict)
        and _clean_text(
            str(
                value.get("headline@stripHtml")
                or value.get("headline")
                or ""
            )
        ).casefold()
        == "editorial cartoon"
        for value in state.values()
    )
    if not explicitly_cartoon:
        return None
    rows = _nyt_preloaded_visual_story_rows(state, minimum_rows=1)
    if len(rows) != 1:
        return None
    source, caption, credit = rows[0]
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    figure = document.new_tag("figure")
    image = document.new_tag("img", src=source)
    image["alt"] = caption or description or "Editorial cartoon"
    figure.append(image)
    if caption or credit:
        figcaption = document.new_tag("figcaption")
        figcaption.string = _first_text(caption, credit)
        figure.append(figcaption)
    article.append(figure)
    return article


def _nyt_interactive_redirect_body(soup: BeautifulSoup) -> Tag | None:
    """Preserve metadata and destination for NYT's intentionally blank promos."""
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "name", "lp"),
        _meta_content(soup, "property", "og:description"),
    )
    destination = _nyt_interactive_redirect_destination(soup)
    if not destination:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    if destination:
        iframe = document.new_tag("iframe")
        iframe["src"] = destination
        iframe["title"] = "Interactive destination"
        article.append(iframe)
    return article


def _nyt_interactive_redirect_destination(soup: BeautifulSoup) -> str | None:
    """Return the target embedded by an intentionally blank legacy shell."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?i)\b(?:destUrl|page_url)\s*=\s*["']\s*(?P<url>https?://[^"']+)""",
            value,
        )
        if match:
            return match.group("url").strip()
    return None


def _nyt_preloaded_slideshow_rows(
    state: dict[str, Any],
) -> list[tuple[str, str | None, str | None]]:
    slideshow_references = [
        value.get("media")
        for value in state.values()
        if isinstance(value, dict)
        and value.get("__typename") == "SlideshowBlock"
    ]
    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()
    for slideshow_reference in slideshow_references:
        slideshow = _nyt_state_reference(state, slideshow_reference)
        if slideshow is None:
            continue
        slides = slideshow.get("slides")
        if not isinstance(slides, list):
            continue
        for slide_reference in slides:
            slide = _nyt_state_reference(state, slide_reference)
            if slide is None:
                continue
            image = _nyt_state_reference(state, slide.get("image"))
            if image is None:
                continue
            renditions = _nyt_image_renditions(state, image)
            if not renditions:
                continue
            rendition = max(
                renditions,
                key=lambda item: (
                    int(item.get("width") or 0)
                    * int(item.get("height") or 0),
                    int(item.get("width") or 0),
                ),
            )
            url = str(rendition["url"])
            identity = _image_identity(url)
            if identity in seen:
                continue
            seen.add(identity)
            legacy_caption = _string_or_none(
                slide.get("legacyHtmlCaption")
            )
            caption = (
                _clean_text(
                    BeautifulSoup(
                        legacy_caption,
                        "html.parser",
                    ).get_text(" ")
                )
                if legacy_caption
                else None
            )
            rows.append(
                (
                    url,
                    caption,
                    _string_or_none(image.get("credit")),
                )
            )
    return rows


def _nyt_denormalized_gallery_rows(
    soup: BeautifulSoup,
) -> list[tuple[str, str | None, str | None]]:
    payload = _nyt_preloaded_payload(soup)
    initial_data = payload.get("initialData")
    if not isinstance(initial_data, dict):
        return []
    data = initial_data.get("data")
    article = data.get("article") if isinstance(data, dict) else None
    body = article.get("sprinkledBody") if isinstance(article, dict) else None
    if not isinstance(body, dict):
        return []

    rows: list[tuple[str, str | None, str | None]] = []
    seen: set[str] = set()

    def add_image(image: Any) -> None:
        if not isinstance(image, dict):
            return
        renditions = [
            value
            for value in _walk_json_objects(image.get("crops", []))
            if value.get("__typename") == "ImageRendition"
            and isinstance(value.get("url"), str)
        ]
        if not renditions:
            return
        rendition = max(
            renditions,
            key=lambda item: (
                int(item.get("width") or 0) * int(item.get("height") or 0),
                int(item.get("width") or 0),
            ),
        )
        url = str(rendition["url"])
        identity = _image_identity(url)
        if identity in seen:
            return
        seen.add(identity)
        caption_value = image.get("caption")
        caption = (
            _first_text(
                _string_or_none(caption_value.get("text")),
                _string_or_none(caption_value.get("html")),
            )
            if isinstance(caption_value, dict)
            else None
        )
        caption = _first_text(
            caption,
            _string_or_none(image.get("legacyHtmlCaption")),
        )
        rows.append(
            (
                url,
                _clean_text(
                    BeautifulSoup(caption, "html.parser").get_text(" ")
                    if "<" in caption
                    else html_module.unescape(caption)
                )
                if caption
                else None,
                _string_or_none(image.get("credit")),
            )
        )

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                visit(child)
            return
        if not isinstance(value, dict):
            return
        typename = value.get("__typename")
        if typename == "ImageBlock":
            add_image(value.get("media"))
            return
        if typename == "DiptychBlock":
            add_image(value.get("imageOne"))
            add_image(value.get("imageTwo"))
            return
        for child in value.values():
            visit(child)

    visit(body.get("content", []))
    return rows


def _nyt_preloaded_article_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    state = _nyt_preloaded_state(soup)
    target = next(
        (
            value
            for value in state.values()
            if isinstance(value, dict)
            and value.get("__typename") == "Article"
            and value.get("url") == canonical_url
        ),
        None,
    )
    if not isinstance(target, dict):
        return None
    # Legacy pages expose the article body as ``body`` while older Oak
    # payloads use the richer ``sprinkledBody`` field.  The latter is often
    # an inline document rather than a reference, so preserve it as a
    # fallback when ``body`` is absent.
    body = _nyt_state_reference(
        state,
        target.get("body") or target.get("sprinkledBody"),
    )
    if body is None:
        return None
    references = next(
        (
            value
            for key, value in body.items()
            if key.startswith("content") and isinstance(value, list)
        ),
        [],
    )
    paragraphs: list[str] = []

    def inline_text(value: Any, visited: set[str] | None = None) -> list[str]:
        visited = visited or set()
        if isinstance(value, list):
            return [
                text
                for child in value
                for text in inline_text(child, visited)
            ]
        if not isinstance(value, dict):
            return []
        reference = value.get("id")
        if (
            isinstance(reference, str)
            and reference in state
            and reference not in visited
        ):
            visited.add(reference)
            return inline_text(state[reference], visited)
        if (
            value.get("__typename") == "TextInline"
            and isinstance(value.get("text"), str)
        ):
            return [str(value["text"])]
        return [
            text
            for child in value.values()
            for text in inline_text(child, visited)
        ]

    for reference in references:
        block = _nyt_state_reference(state, reference)
        if block is None or block.get("__typename") not in {
            "ParagraphBlock",
            "Heading1Block",
            "Heading2Block",
            "Heading3Block",
            "SummaryBlock",
        }:
            continue
        text = " ".join(inline_text(block))
        text = _clean_text(text)
        if text:
            paragraphs.append(text)
    if len(paragraphs) < 2 or sum(map(len, paragraphs)) < 100:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for text in paragraphs:
        paragraph = document.new_tag("p")
        paragraph.string = text
        article.append(paragraph)
    return article


def _nyt_preloaded_embedded_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover Oak embedded interactives serialized only in GraphQL state."""
    state = _nyt_preloaded_state(soup)
    target = next(
        (
            value
            for value in state.values()
            if isinstance(value, dict)
            and value.get("__typename") == "Article"
            and value.get("url") == canonical_url
        ),
        None,
    )
    if not isinstance(target, dict):
        return None

    # NYT's normalized Apollo cache can contain complete related articles in
    # addition to the requested article.  Scanning every EmbeddedInteractive
    # in that cache lets a related newsgraphic replace an otherwise valid
    # image-led story.  Follow references only from the requested article's
    # own body so related-card payloads cannot become editorial content.
    html_values: list[str] = []
    visited_references: set[str] = set()
    visited_objects: set[int] = set()

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                visit(child)
            return
        if not isinstance(value, dict):
            return
        object_id = id(value)
        if object_id in visited_objects:
            return
        visited_objects.add(object_id)
        if (
            value.get("__typename") == "EmbeddedInteractive"
            and isinstance(value.get("html"), str)
        ):
            html_values.append(str(value["html"]))
            return
        reference = value.get("id")
        if (
            isinstance(reference, str)
            and reference in state
            and reference not in visited_references
        ):
            visited_references.add(reference)
            visit(state[reference])
        for child in value.values():
            visit(child)

    visit(target.get("body"))
    visit(target.get("sprinkledBody"))
    if not html_values:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen_urls: set[str] = set()
    for raw_html in html_values:
        fragment = BeautifulSoup(raw_html, "html.parser")
        fragment_root = fragment.body or fragment
        text = _clean_text(fragment_root.get_text(" ", strip=True))
        image_urls: list[str] = []
        for match in re.finditer(
            r"(?i)(?:https?:)?//(?:graphics\d*|static\d*)"
            r"\.(?:nytimes|nyt)\.com/[^\"'<>\s]+?"
            r"\.(?:jpe?g|png|gif)(?:\?[^\"'<>\s]*)?",
            raw_html.replace("\\/", "/"),
        ):
            url = match.group(0)
            if url.startswith("//"):
                url = f"https:{url}"
            identity = _image_identity(url)
            if identity in seen_urls:
                continue
            seen_urls.add(identity)
            image_urls.append(url)
        if not text and not image_urls:
            continue
        wrapper = document.new_tag("div")
        wrapper["data-jojo-embedded-interactive"] = "true"
        for child in list(fragment_root.contents):
            wrapper.append(child)
        article.append(wrapper)
        captions = [
            _tag_text(node)
            for node in fragment.select("figcaption")
            if _tag_text(node)
        ]
        for index, url in enumerate(image_urls):
            figure = document.new_tag("figure")
            image = document.new_tag("img")
            image["src"] = url
            if index < len(captions):
                image["alt"] = captions[index]
            figure.append(image)
            if index < len(captions):
                caption = document.new_tag("figcaption")
                caption.string = captions[index]
                figure.append(caption)
            article.append(figure)
    return article if article.select_one("p, figure, img, iframe") else None


def _nyt_preloaded_article_metadata(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> dict[str, Any]:
    state = _nyt_preloaded_state(soup)
    target = next(
        (
            value
            for value in state.values()
            if isinstance(value, dict)
            and value.get("__typename") == "Article"
            and value.get("url") == canonical_url
        ),
        None,
    )
    if not isinstance(target, dict):
        return {}
    headline = _nyt_state_reference(state, target.get("headline"))
    authors: list[str] = []
    bylines = target.get("bylines")
    if isinstance(bylines, list):
        for byline_reference in bylines:
            byline = _nyt_state_reference(state, byline_reference)
            if byline is None:
                continue
            rendered = _string_or_none(byline.get("renderedRepresentation"))
            if rendered:
                rendered = re.sub(
                    r"^(?:By|Photographs? by|Reporting by)\s+",
                    "",
                    rendered,
                    flags=re.IGNORECASE,
                )
                authors.append(rendered)
    return {
        "headline": _first_text(
            _string_or_none(headline.get("default"))
            if headline is not None
            else None,
            _string_or_none(headline.get("default@stripHtml"))
            if headline is not None
            else None,
        ),
        "description": _string_or_none(target.get("summary")),
        "authors": authors,
        "word_count": target.get("wordCount"),
        "published_at": _string_or_none(target.get("firstPublished")),
        "modified_at": _first_text(
            _string_or_none(target.get("lastModified")),
            _string_or_none(target.get("lastMajorModification")),
        ),
    }


def _axios_next_story(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> dict[str, Any] | None:
    """Return Axios's server-rendered story payload when it is present."""
    script = soup.select_one("script#__NEXT_DATA__")
    if not isinstance(script, Tag):
        return None
    try:
        payload = json.loads(script.string or script.get_text())
    except (json.JSONDecodeError, TypeError):
        return None
    target_path = unquote(urlsplit(canonical_url).path).rstrip("/").casefold()
    candidates: list[dict[str, Any]] = []
    for item in _walk_json_objects(payload):
        blocks = item.get("blocks")
        permalink = _string_or_none(item.get("permalink"))
        if (
            isinstance(item.get("headline"), str)
            and isinstance(blocks, dict)
            and isinstance(blocks.get("blocks"), list)
            and permalink
            and "axios.com/" in permalink.casefold()
            and any(
                key in item
                for key in ("published_date", "first_published", "last_published")
            )
        ):
            candidates.append(item)
            permalink_path = (
                unquote(urlsplit(permalink).path).rstrip("/").casefold()
            )
            if permalink_path == target_path:
                return item
    # A normal archived Axios page carries one structured story. Preserve
    # that recovery path even if its permalink was migrated after capture.
    # Multi-story deep dives must never silently select their first chapter:
    # each child URL has its own payload and is matched above.
    return candidates[0] if len(candidates) == 1 else None


def _axios_next_story_body(story: dict[str, Any]) -> Tag | None:
    """Restore Axios body HTML and media hidden in ``__NEXT_DATA__``.

    Axios's 2022-era shell sometimes server-renders an empty Draft.js wrapper
    even though the complete historical payload remains in ``bodyHtml`` and
    the structured Draft.js blocks.  Prefer the publisher's rendered HTML,
    then supplement media embeds whose visible text was stripped from it.
    """
    document = BeautifulSoup(
        "<article data-jojo-source='axios-next-story'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None

    body_html = story.get("bodyHtml")
    html_parts: list[str] = []
    if isinstance(body_html, str):
        html_parts.append(body_html)
    elif isinstance(body_html, dict):
        for key in ("beforeKeepReading", "keepReadingData", "afterKeepReading"):
            value = body_html.get(key)
            if isinstance(value, str):
                html_parts.append(value)
            elif isinstance(value, dict):
                html_parts.extend(
                    nested
                    for nested in value.values()
                    if isinstance(nested, str)
                )
    if html_parts:
        parsed = BeautifulSoup("".join(html_parts), "html.parser")
        for child in list((parsed.body or parsed).children):
            article.append(child)

    # Axios quote cards store the quote in ``blockquote`` and its complete
    # editorial attribution in an adjacent ``cite`` element. The generic
    # block extractor intentionally does not treat every page-level citation
    # as prose, so normalize only this publisher-owned structured body shape
    # into a paragraph. Otherwise a complete short quote card is measured
    # from the quote alone and incorrectly classified as truncated.
    for attribution in article.select("blockquote + cite"):
        attribution.name = "p"
        attribution["data-jojo-role"] = "quote-attribution"

    structured_blocks = story.get("blocks", {}).get("blocks", [])
    if not isinstance(structured_blocks, list):
        structured_blocks = []

    def append_fragment(value: str) -> None:
        parsed = BeautifulSoup(value, "html.parser")
        for node in parsed.select("script, style"):
            node.decompose()
        for child in list((parsed.body or parsed).children):
            article.append(child)

    existing_text = _clean_text(article.get_text(" ", strip=True)).casefold()
    existing_tokens = _axios_text_tokens(existing_text)
    existing_images = {
        _string_or_none(node.get("src"))
        for node in article.select("img[src]")
    }
    existing_images.discard(None)
    existing_embeds = {
        _string_or_none(node.get("src"))
        for node in article.select("iframe[src]")
    }
    existing_embeds.discard(None)
    has_rendered_text = bool(existing_text)

    for block in structured_blocks:
        if not isinstance(block, dict):
            continue
        block_type = _clean_text(str(block.get("type") or "")).casefold()
        text = _clean_text(str(block.get("text") or ""))
        data = block.get("data")
        if not isinstance(data, dict):
            data = {}

        if block_type == "image":
            source = _string_or_none(data.get("src"))
            if source and source not in existing_images:
                figure = document.new_tag("figure")
                image = document.new_tag("img", src=source)
                alt = _string_or_none(data.get("alt_text"))
                if alt:
                    image["alt"] = alt
                figure.append(image)
                article.append(figure)
                existing_images.add(source)
            continue

        if block_type == "embed":
            oembed = data.get("oembed")
            embed_html = (
                _string_or_none(oembed.get("html"))
                if isinstance(oembed, dict)
                else None
            )
            embed_text = (
                _clean_text(
                    BeautifulSoup(embed_html, "html.parser").get_text(
                        " ", strip=True
                    )
                )
                if embed_html
                else ""
            )
            embed_sources = (
                {
                    _string_or_none(node.get("src"))
                    for node in BeautifulSoup(
                        embed_html, "html.parser"
                    ).select("iframe[src]")
                }
                if embed_html
                else set()
            )
            embed_sources.discard(None)
            if embed_sources and embed_sources.issubset(existing_embeds):
                continue
            if embed_html and (
                not embed_text
                or embed_text.casefold() not in existing_text
            ):
                append_fragment(embed_html)
                existing_embeds.update(embed_sources)
                existing_text = _clean_text(
                    article.get_text(" ", strip=True)
                ).casefold()
            elif not embed_html:
                source = _string_or_none(data.get("url"))
                if source:
                    article.append(document.new_tag("iframe", src=source))
            continue

        block_tokens = _axios_text_tokens(text)
        if text and (
            not has_rendered_text
            or not block_tokens
            or block_tokens not in existing_tokens
        ):
            tag_name = (
                "blockquote"
                if "quote" in block_type
                else "h2"
                if block_type.startswith("header")
                else "li"
                if "list-item" in block_type
                else "p"
            )
            node = document.new_tag(tag_name)
            node.string = text
            article.append(node)
            existing_text = f"{existing_text} {text.casefold()}".strip()
            existing_tokens = _axios_text_tokens(existing_text)

    image_only = _axios_image_only_story(story)
    if image_only is not None and not article.select_one("img[src]"):
        source, alt, caption = image_only
        figure = document.new_tag("figure")
        image = document.new_tag("img", src=source)
        if alt:
            image["alt"] = alt
        figure.append(image)
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        article.append(figure)

    if article.select_one(
        "p, h2, h3, h4, h5, h6, blockquote, li, table, iframe, img[src]"
    ):
        return article
    return None


def _axios_text_tokens(value: str) -> str:
    """Normalize rendered and Draft.js text for containment comparisons."""

    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _remove_axios_body_chrome(soup: BeautifulSoup) -> None:
    """Remove publisher recirculation labels embedded in Axios story HTML."""

    for text_node in list(soup.find_all(string=True)):
        if (
            isinstance(text_node, NavigableString)
            and _clean_text(str(text_node)).casefold() == "go deeper"
        ):
            text_node.extract()
    for node in list(soup.select("p, li, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        # Older Axios Draft.js exports split the linked word ``here`` at the
        # anchor boundary (``h`` + ``ere``).  This leaves a newsletter/site
        # navigation CTA in the normalized prose unless the two forms are
        # compared after repairing that presentation artifact.
        compact_interface_text = re.sub(r"\bh\s+ere\b", "here", text)
        newsletter_signup = node.select_one(
            "a[href*='link.axios.com/join/'], "
            "a[href*='signup.axios.com/'], "
            "a[href*='/newsletter-signup'], "
            "a[href*='axios.com/newsletters/']"
        )
        if (
            text.startswith("sign up for our axios ")
            and " newsletter" in text
        ) or (
            re.match(r"^sign up for (?:the )?axios\b", text) is not None
            and " newsletter" in text
        ) or (
            re.match(r"^sign up for (?:the )?(?:new )?axios\b", text)
            is not None
            and " newsletter" in text
        ) or (
            text.startswith("sign up for the daily axios ")
            and " newsletter" in text
        ) or (
            text.startswith("subscribe to the axios ")
            and " newsletter" in text
        ) or text.startswith("subscribe to axios ") or (
            re.match(r"^subscribe to (?:the )?(?:weekly )?axios\b", text)
            is not None
            and " newsletter" in text
        ) or (
            text.startswith("sign up for ")
            and " newsletter" in text
            and (
                newsletter_signup is not None
                or re.fullmatch(
                    r"sign up for the daily [a-z0-9&'’ .-]+ "
                    r"financial newsletter here\s*\.?",
                    text,
                )
                is not None
            )
        ) or (
            text.startswith("subscribe to ")
            and " podcast" in text
        ) or re.fullmatch(
            r"subscribe to our youtube(?: channel)?\s*[.!]?", text
        ) or compact_interface_text in {
            "subscribe to our newsletters here and check out our news stream here.",
            "subscribe to our newsletters here and check out our news stream here",
        }:
            node.decompose()
            continue
        if text not in {
            "read more",
            "read more:",
            "go deeper",
            "go deeper:",
            "more from axios",
            "more from axios:",
            "more on axios",
            "more on axios:",
        } and not text.startswith("go deeper:"):
            continue
        following = node.find_next_sibling()
        if (
            text
            in {
                "read more",
                "read more:",
                "go deeper",
                "go deeper:",
                "more from axios",
                "more from axios:",
                "more on axios",
                "more on axios:",
            }
            and isinstance(following, Tag)
            and following.name in {"ul", "ol"}
        ):
            following.decompose()
        node.decompose()
    for listing in list(soup.select("ul, ol")):
        items = [
            _clean_text(item.get_text(" ", strip=True)).casefold()
            for item in listing.select(":scope > li")
        ]
        if items and all(
            item.startswith("go deeper:")
            or (
                item.startswith("subscribe to ")
                and " podcast" in item
            )
            for item in items
        ):
            listing.decompose()


def _axios_image_only_story(
    story: dict[str, Any] | None,
) -> tuple[str, str | None, str | None] | None:
    """Return publisher-authored media for a proven image-only Axios item."""

    if not isinstance(story, dict) or _axios_empty_newsletter_story(story):
        return None
    try:
        wordcount = int(story.get("wordcount"))
    except (TypeError, ValueError):
        return None
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if wordcount != 0 or values != []:
        return None
    body_html = story.get("bodyHtml")
    fragments = (
        [body_html]
        if isinstance(body_html, str)
        else [
            value
            for value in body_html.values()
            if isinstance(value, str)
        ]
        if isinstance(body_html, dict)
        else []
    )
    if _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    ):
        return None
    primary = story.get("primary_image")
    if not isinstance(primary, dict):
        return None
    source = _string_or_none(primary.get("base_image_url"))
    if source is None:
        crops = primary.get("crops")
        if isinstance(crops, dict):
            preferred = crops.get("16x9") or next(iter(crops.values()), None)
            if isinstance(preferred, dict):
                source = _string_or_none(preferred.get("url"))
    if source is None or not source.startswith(("http://", "https://")):
        return None
    alt = _string_or_none(primary.get("alt_text"))
    caption_data = primary.get("caption")
    caption_blocks = (
        caption_data.get("blocks") if isinstance(caption_data, dict) else None
    )
    caption = (
        _clean_text(
            " ".join(
                str(block.get("text") or "")
                for block in caption_blocks
                if isinstance(block, dict)
            )
        )
        if isinstance(caption_blocks, list)
        else None
    )
    return source, alt, caption or None


def _axios_empty_newsletter_story(story: dict[str, Any] | None) -> bool:
    """Identify exact recurring briefing records with no publisher body."""
    if not isinstance(story, dict):
        return False
    headline = _clean_text(str(story.get("headline") or ""))
    if not re.fullmatch(
        r"(?i)(?:"
        r"Axios\s+(?:AM|PM)(?:\s*\(beta\))?"
        r"|Today's\s+Trump\s+Top\s+5:\s+.+"
        r")",
        headline,
    ):
        return False
    if story.get("wordcount") not in {0, "0"}:
        return False
    blocks = story.get("blocks")
    if not isinstance(blocks, dict) or blocks.get("blocks") != []:
        return False
    body_html = story.get("bodyHtml")
    fragments: list[str] = []
    if isinstance(body_html, str):
        fragments.append(body_html)
    elif isinstance(body_html, dict):
        fragments.extend(
            value for value in body_html.values() if isinstance(value, str)
        )
    return not _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    )


def _axios_short_newsletter_story(story: dict[str, Any] | None) -> bool:
    """Accept a complete publisher-authored short Axios AM test item.

    This deliberately requires the Axios AM subscription relationship and an
    exact agreement between the structured word count, Draft.js text, and
    rendered body. Ordinary short stories remain subject to the normal body
    threshold.
    """
    if not isinstance(story, dict):
        return False
    headline = _clean_text(str(story.get("headline") or ""))
    if not re.fullmatch(r"(?i)Axios\s+AM:\s+.+", headline):
        return False
    authors = story.get("authors")
    if not isinstance(authors, list) or not any(
        isinstance(author, dict)
        and isinstance(author.get("subscription"), dict)
        and _clean_text(
            str(author["subscription"].get("slug") or "")
        ).casefold()
        == "axios-am"
        for author in authors
    ):
        return False
    try:
        wordcount = int(story.get("wordcount"))
    except (TypeError, ValueError):
        return False
    if not 1 <= wordcount <= 50:
        return False
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if not isinstance(values, list) or not values:
        return False
    block_text = _clean_text(
        " ".join(
            str(block.get("text") or "")
            for block in values
            if isinstance(block, dict)
        )
    )
    if not block_text or len(block_text.split()) != wordcount:
        return False
    body_html = story.get("bodyHtml")
    fragments = (
        [body_html]
        if isinstance(body_html, str)
        else [
            value
            for value in body_html.values()
            if isinstance(value, str)
        ]
        if isinstance(body_html, dict)
        else []
    )
    rendered_text = _clean_text(
        BeautifulSoup("".join(fragments), "html.parser").get_text(
            " ", strip=True
        )
    )
    return rendered_text == block_text


def _axios_next_story_content_type(
    story: dict[str, Any] | None,
) -> ContentType | None:
    if _axios_empty_newsletter_story(story) or _axios_short_newsletter_story(
        story
    ):
        return ContentType.NEWSLETTER
    if _axios_image_only_story(story) is not None:
        return ContentType.GALLERY
    if not isinstance(story, dict):
        return None
    blocks = story.get("blocks")
    values = blocks.get("blocks") if isinstance(blocks, dict) else None
    if not isinstance(values, list):
        return None
    embed_types = {
        _clean_text(str(data.get("type") or "")).casefold()
        for block in values
        if isinstance(block, dict)
        and block.get("type") == "embed"
        and isinstance((data := block.get("data")), dict)
    }
    if embed_types & {"video", "youtube", "vimeo", "jwplayer"}:
        return ContentType.VIDEO
    if embed_types:
        return ContentType.INTERACTIVE
    if values and all(
        isinstance(block, dict) and block.get("type") == "image"
        for block in values
    ):
        return ContentType.GALLERY
    return None


def _axios_embedded_content_type(body: Tag) -> ContentType | None:
    """Classify Axios pages whose entire editorial payload is an embed.

    Old Axios URLs are now served by a newer Next.js shell.  Some of them are
    nevertheless genuine, deliberately non-text pieces: their selected
    Draft.js body contains a player/chart iframe and, at most, a short CTA.
    Treating those as truncated articles discards the useful embed and makes
    an article-only quality heuristic report a false parser failure.
    """
    # Axios's historical React markup often keeps iframe URLs in a lazy-load
    # data attribute.  Restore that attribute before block extraction so the
    # archived article keeps a usable embed rather than an empty shell.
    for iframe in body.select("iframe[data-src]:not([src])"):
        iframe["src"] = iframe.get("data-src")
    text = _clean_text(
        " ".join(
            node.get_text(" ", strip=True)
            for node in body.select("p, li, blockquote, h2, h3, h4")
        )
    )
    # A normal reported article may include a player.  Only classify a page
    # as embed-led when there is no substantive surrounding editorial text.
    if len(text) > 220:
        return None
    # Axios also publishes chart-led visual explainers as server-rendered SVG
    # rather than an iframe.  Their legacy archive shell exposes the visual
    # through these fallback classes and contains only a chart credit/caption;
    # it is an interactive item, not a truncated text article.
    if body.select_one(
        ".axios-visual-apple-fallback-image, "
        ".axios-visual-newsletter-fallback-image"
    ):
        return ContentType.INTERACTIVE
    iframes = body.select("iframe[src]")
    if not iframes:
        return None
    sources = " ".join(
        str(iframe.get("src") or "").casefold()
        for iframe in iframes
    )
    if any(
        marker in sources
        for marker in (
            "jwplatform.",
            "youtube.com/",
            "youtu.be/",
            "vimeo.com/",
            "brightcove.",
        )
    ):
        return ContentType.VIDEO
    return ContentType.INTERACTIVE


def _aljazeera_body_content_type(
    *,
    default: ContentType,
    headline: str | None,
    plain_text: str,
    blocks: list[ContentBlock],
    visual_tags: str | None = None,
) -> ContentType:
    """Classify short Al Jazeera media reports after blocks are available.

    Migrated legacy video reports retain an iframe and only a short written
    synopsis, while migrated timeline packages may retain only an intro.  The
    generic JSON-LD on both page shapes still says ``NewsArticle``.
    """

    if default != ContentType.ARTICLE:
        return default
    normalized_visual_tags = (visual_tags or "").casefold()
    if any(
        marker in normalized_visual_tags
        for marker in ("infographic", "interactive")
    ):
        if any(block.type == BlockType.EMBED for block in blocks):
            return ContentType.INTERACTIVE
        if any(block.type == BlockType.IMAGE for block in blocks):
            return ContentType.GALLERY
    normalized_headline = _clean_text(headline or "").casefold()
    if normalized_headline.startswith("timeline:") and len(plain_text) < 500:
        return ContentType.INTERACTIVE
    if len(plain_text) >= 1_000:
        return default
    video_embed_markers = (
        "youtube.com/",
        "youtu.be/",
        "vimeo.com/",
        "dailymotion.com/",
        "brightcove.net/",
        "jwplatform.com/",
    )
    if any(
        block.type == BlockType.EMBED
        and block.embed_url
        and any(
            marker in block.embed_url.casefold()
            for marker in video_embed_markers
        )
        for block in blocks
    ):
        return ContentType.VIDEO
    return default


def _aljazeera_visual_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover migrated Al Jazeera visual payloads from the story body."""

    body = soup.select_one(".wysiwyg")
    if not isinstance(body, Tag):
        return None
    source_iframe = body.select_one("iframe[src]")
    if not isinstance(source_iframe, Tag):
        return None
    source = _normalized_url(source_iframe.get("src"), base_url=canonical_url)
    hostname = (urlsplit(source or "").hostname or "").casefold()
    if not source or hostname != "interactive.aljazeera.com":
        return None
    fragment = BeautifulSoup(
        "<article data-jojo-source='aljazeera-interactive'></article>",
        "html.parser",
    )
    article = fragment.select_one("article")
    if not isinstance(article, Tag):
        return None
    iframe = fragment.new_tag("iframe", src=source)
    iframe["title"] = "Al Jazeera interactive"
    iframe["data-interactive-provider"] = "aljazeera"
    article.append(iframe)
    return article


def _aljazeera_gallery_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Select migrated Al Jazeera gallery figures over an empty text shell."""

    if "/gallery/" not in canonical_url.casefold():
        return None
    candidate = soup.select_one(".gallery-images")
    if not isinstance(candidate, Tag):
        return None
    if len(candidate.select("figure img[src]")) < 2:
        return None
    return candidate


def _npr_audio_story_nodes(soup: BeautifulSoup) -> list[Tag]:
    """Return story-level players without matching NPR's global live audio."""
    result: list[Tag] = []
    for node in soup.select(
        "#primaryaudio, #headlineaudio, article.resaudio, .audio-module, "
        "#storyspan02 .bucketwrap.primary"
    ):
        if not isinstance(node, Tag):
            continue
        legacy_primary = (
            "bucketwrap" in {
                str(value).casefold()
                for value in (node.get("class") or [])
            }
            and node.find_parent(id="storyspan02") is not None
        )
        if legacy_primary and (
            node.select_one(".avcontent.listen") is None
            or node.select_one(
                ".avcontent.listen a[href*='NPR.Player.openPlayer'], "
                ".audiotools a.download[href]"
            )
            is None
        ):
            continue
        result.append(node)
    return result


def _npr_legacy_transcript_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Prefer NPR's complete legacy transcript over its short teaser."""
    transcript = soup.select_one(".transcript")
    if not isinstance(transcript, Tag) or transcript.select_one("p") is None:
        return None
    transcript_characters = len(
        _clean_text(transcript.get_text(" ", strip=True))
    )
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    if (
        transcript_characters < _MINIMUM_BODY_CHARACTERS
        or transcript_characters < selected_characters + 250
        or transcript_characters < selected_characters * 2
    ):
        return None
    return transcript


def _npr_legacy_election_results_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Preserve AP-backed result feeds from NPR's 2010 election pages."""
    scripts = [
        node
        for node in soup.select(
            "#storyspan03 .elexResultsTable "
            "script[src*='hosted.ap.org/dynamic/files/elections/' i]"
        )
        if isinstance(node, Tag)
    ]
    if not scripts:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-election-results'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    for selector in ("#storytext p", "#storyspan03 .listtext p"):
        for paragraph in soup.select(selector):
            copy = BeautifulSoup(str(paragraph), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    previous_heading = ""
    for index, script in enumerate(scripts, start=1):
        heading = script.find_previous("h2")
        heading_text = _clean_text(
            heading.get_text(" ", strip=True)
            if isinstance(heading, Tag)
            else "Election"
        )
        if heading_text and heading_text != previous_heading:
            heading_copy = document.new_tag("h2")
            heading_copy.string = heading_text
            article.append(heading_copy)
            previous_heading = heading_text
        source_url = _normalized_url(
            str(script.get("src") or ""),
            base_url=canonical_url,
        )
        if not source_url:
            continue
        embed = document.new_tag("iframe")
        embed["src"] = source_url
        embed["title"] = f"{heading_text or 'Election'} results data {index}"
        embed["data-interactive-provider"] = "npr-ap-election-results"
        article.append(embed)
    return article if article.select_one("iframe[src]") is not None else None


def _npr_legacy_book_list_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Recover reviews stored outside #storytext by NPR's book template."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    source = soup.select_one("#storyspan03 .bucketwrap.booklist")
    if (
        "tmplbookstory" not in body_classes
        or not isinstance(source, Tag)
        or len(source.select(".booklistitem")) < 2
    ):
        return None
    source_characters = len(_clean_text(source.get_text(" ", strip=True)))
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    if source_characters < 500 or source_characters < selected_characters * 2:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-book-list'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    if selected_body is not None:
        for paragraph in selected_body.select("p"):
            copy = BeautifulSoup(str(paragraph), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    book_list = BeautifulSoup(str(source), "html.parser").find()
    if not isinstance(book_list, Tag):
        return None
    for noise in book_list.select(
        ".ecommercepop, .purchaseLink, .internallink, h5, a[name]"
    ):
        noise.decompose()
    for edition in book_list.select(".bookedition"):
        edition.name = "p"
    for bullet in book_list.select(".bull"):
        bullet.decompose()
    article.append(book_list)
    return article


def _npr_legacy_gallery_body(soup: BeautifulSoup) -> Tag | None:
    """Recover the archived lead image from NPR's pre-HTML5 slideshows."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None
    slideshow = soup.select_one("div[id^='slideshow']")
    if (
        not isinstance(slideshow, Tag)
        or slideshow.select_one("img[src]") is None
    ):
        return None
    return slideshow


def _npr_legacy_flash_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Normalize NPR's pre-HTML5 Flash interactive and live-video pages."""
    story = soup.select_one("#storytext")
    supplemental = soup.select_one(
        "#supplementarycontent .bucketwrap.statichtml"
    )
    legacy_embed = (
        supplemental.select_one("object embed[src], embed[src]")
        if isinstance(supplemental, Tag)
        else None
    )
    story_characters = len(
        _clean_text(story.get_text(" ", strip=True))
        if isinstance(story, Tag)
        else ""
    )
    if (
        isinstance(story, Tag)
        and isinstance(legacy_embed, Tag)
        and 20 <= story_characters <= 500
    ):
        swf_url = _normalized_url(
            str(legacy_embed.get("src") or ""),
            base_url=canonical_url,
        )
        if swf_url:
            document = BeautifulSoup(
                "<article data-jojo-source='npr-legacy-flash-video'></article>",
                "html.parser",
            )
            article = document.article
            if isinstance(article, Tag):
                for child in list(story.contents):
                    copy = BeautifulSoup(str(child), "html.parser").find()
                    if isinstance(copy, Tag):
                        article.append(copy)
                iframe = document.new_tag("iframe")
                iframe["src"] = swf_url
                iframe["title"] = "Archived NPR live video"
                iframe["data-interactive-provider"] = "npr-flash-video"
                article.append(iframe)
                return article

    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if not body_classes.intersection(
        {"tmplmusicmultimedia", "tmplnewsmultimedia"}
    ):
        return None
    source = soup.select_one(
        "#storyspan03 .bucketwrap[class*='graphic' i] > .bucket"
        if "tmplmusicmultimedia" in body_classes
        else ".bucketwrap.interactive[class*='graphic' i] > .bucket"
    )
    if not isinstance(source, Tag):
        return None
    graphic = source.select_one(".graphicwrapper")
    if not isinstance(graphic, Tag) or graphic.select_one("img[src]") is None:
        return None
    swf_url: str | None = None
    for script in source.select("script"):
        payload = script.string or script.get_text()
        if "SWFObject" not in payload or "theswf" not in payload:
            continue
        match = re.search(
            r"(?i)addVariable\(\s*['\"]theswf['\"]\s*,\s*"
            r"['\"]([^'\"]+\.swf(?:\?[^'\"]*)?)['\"]",
            payload,
        )
        if match:
            swf_url = _normalized_url(
                match.group(1),
                base_url=canonical_url,
            )
            break
    if not swf_url:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-flash-interactive'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = next(
        (
            child
            for child in source.find_all("p", recursive=False)
            if _clean_text(child.get_text(" ", strip=True))
        ),
        None,
    )
    if isinstance(description, Tag):
        article.append(
            BeautifulSoup(str(description), "html.parser").find()
        )
    fallback = graphic.select_one("img[src]")
    if isinstance(fallback, Tag):
        figure = document.new_tag("figure")
        figure.append(BeautifulSoup(str(fallback), "html.parser").find())
        article.append(figure)
    iframe = document.new_tag("iframe")
    iframe["src"] = swf_url
    iframe["title"] = _first_text(
        _tag_text(source.select_one("h3")),
        "Archived NPR interactive",
    )
    iframe["data-interactive-provider"] = "npr-flash"
    article.append(iframe)
    credit = source.select_one(":scope > .footer p")
    if isinstance(credit, Tag):
        article.append(BeautifulSoup(str(credit), "html.parser").find())
    return article


def _npr_legacy_iframe_interactive_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    """Recover iframe-led interactives from NPR's legacy multimedia page."""
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None
    source = soup.select_one("#storyspan03 .bucketwrap.statichtml")
    iframe = (
        source.select_one("iframe[src]")
        if isinstance(source, Tag)
        else None
    )
    if not isinstance(source, Tag) or not isinstance(iframe, Tag):
        return None
    embed_url = _normalized_url(
        str(iframe.get("src") or ""),
        base_url=canonical_url,
    )
    if not embed_url:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-iframe-interactive'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    description = _first_text(
        _tag_text(soup.select_one("#storytext p")),
        _meta_content(soup, "name", "description"),
    )
    if description:
        paragraph = document.new_tag("p")
        paragraph.string = description
        article.append(paragraph)
    embed = document.new_tag("iframe")
    embed["src"] = embed_url
    embed["title"] = _first_text(
        _tag_text(soup.select_one(".storytitle h1")),
        "Archived NPR interactive",
    )
    embed["data-interactive-provider"] = "npr-legacy-iframe"
    article.append(embed)
    for selector in (":scope > .notes", ":scope > .footer"):
        node = source.select_one(selector)
        if isinstance(node, Tag):
            copy = BeautifulSoup(str(node), "html.parser").find()
            if isinstance(copy, Tag):
                article.append(copy)
    return article


def _npr_legacy_inline_interactive_body(
    soup: BeautifulSoup,
) -> Tag | None:
    """Recover pre-HTML5 NPR graphics and script-driven inline packages."""

    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    if "tmplnewsmultimedia" not in body_classes:
        return None

    graphic = soup.select_one(
        "#storyspan02 .bucketwrap[class*='graphic' i] > .bucket"
    )
    source: Tag | None = None
    if (
        isinstance(graphic, Tag)
        and graphic.select_one("img[src]") is not None
        and len(_clean_text(graphic.get_text(" ", strip=True))) >= 80
    ):
        source = graphic

    scripted = soup.select_one("#storyspan03 .bucketwrap.statichtml")
    if (
        source is None
        and isinstance(scripted, Tag)
        and scripted.select_one(
            "#pmPoll, .pmVideo, .pmPollWidget, script[src*='polldaddy' i]"
        )
        is not None
        and len(_clean_text(scripted.get_text(" ", strip=True))) >= 80
    ):
        source = scripted
    if source is None:
        return None

    document = BeautifulSoup(
        "<article data-jojo-source='npr-legacy-inline-interactive'></article>",
        "html.parser",
    )
    article = document.article
    copy = BeautifulSoup(str(source), "html.parser").find()
    if not isinstance(article, Tag) or not isinstance(copy, Tag):
        return None
    # These packages commonly use an H1 for essential directions inside the
    # graphic. Normal article extraction treats H1 as duplicate page chrome,
    # so normalize it to body prose before block extraction.
    for heading in copy.select("h1"):
        heading.name = "p"
    article.append(copy)
    return article


def _npr_legacy_cartoon_body(
    soup: BeautifulSoup,
    *,
    selected_body: Tag | None,
) -> Tag | None:
    """Join NPR's short Double Take teaser with its two primary cartoons."""
    selected_characters = len(
        _clean_text(selected_body.get_text(" ", strip=True))
        if selected_body is not None
        else ""
    )
    cartoons = [
        node
        for node in soup.select("div.bucketwrap.photo624")
        if isinstance(node, Tag) and node.select_one("img[src]") is not None
    ]
    page_title = _clean_text(
        soup.title.get_text(" ", strip=True) if soup.title is not None else ""
    ).casefold()
    double_take_page = bool(
        "double take" in page_title
        or soup.select_one(
            ".contentheader[data-metrics-category*='Double Take' i]"
        )
    )
    if len(cartoons) < 2 and double_take_page:
        cartoons = [
            node
            for node in soup.select(
                "#supplementarycontent > div.bucketwrap.image"
            )
            if isinstance(node, Tag)
            and node.select_one(".imagewrap img[src]") is not None
        ]
    if selected_characters >= 200 or len(cartoons) < 2:
        return None
    document = BeautifulSoup(
        "<div data-jojo-source='npr-legacy-cartoon'></div>",
        "html.parser",
    )
    wrapper = document.select_one("div")
    if not isinstance(wrapper, Tag):
        return None
    if selected_body is not None:
        for node in selected_body.select("p, h2, h3, h4"):
            if node.find_parent(("p", "h2", "h3", "h4")) is not None:
                continue
            copy = BeautifulSoup(str(node), "html.parser").find()
            if isinstance(copy, Tag):
                wrapper.append(copy)
    for cartoon in cartoons:
        copy = BeautifulSoup(str(cartoon), "html.parser").find()
        if isinstance(copy, Tag):
            wrapper.append(copy)
    return wrapper


def _npr_non_editorial_image_url(url: str) -> bool:
    path = urlsplit(url).path.casefold()
    return (
        "/chrome/news/nprlogo" in path
        or "/chrome/news/pbs_logo" in path
        or "/images/zag.gif" in path
        or "/include/images/facebook-default-wide" in path
        or "/chrome/news/video_generic_" in path
        or "/music/calendar/concert_calendar_" in path
        # Life Kit playlist artwork is a product/UI icon, not an image from
        # the story itself.  NPR occasionally exposes it through the article
        # image metadata (for example the 2024 "Boring Phone" story), where
        # the generic asset filters above cannot distinguish it from editorial
        # photography.
        or (
            "lifekit" in path
            and "playlist" in path
            and "icon" in path
        )
    )


def _remove_npr_body_chrome(soup: BeautifulSoup) -> None:
    """Remove controls embedded in NPR's legacy story-text container."""
    # The 2016-era ``#storytext`` stream interleaves two-column related-story
    # cards with the article paragraphs.  Their section slug, linked headline
    # and thumbnail otherwise become canonical body blocks/images (for
    # example ``Politics`` followed by a different story headline).
    for node in list(soup.select(".bucketwrap.internallink")):
        node.decompose()
    for bucket in list(soup.select(".bucketwrap.image")):
        image = bucket.select_one("img")
        if isinstance(image, Tag):
            caption, credit = _npr_caption_credit(bucket)
            if caption:
                image["data-jojo-npr-caption"] = caption
            if credit:
                image["data-jojo-npr-credit"] = credit
        for node in list(
            bucket.select(
                ".credit-caption, .enlarge_html, .captionwrap, "
                ".caption-wrap, .creditwrap"
            )
        ):
            node.decompose()
    for node in list(
        soup.select(
            ".dateblock, .textsize, [id^='featuredCommentsMain']"
        )
    ):
        node.decompose()
    # NPR's 2010-era story wrapper nests player menus, embed-code dialogs,
    # podcast subscription buttons and retailer forms alongside the prose.
    # Preserve editorial audio/book copy, but never serialize browser controls
    # into the canonical article body.
    for node in list(
        soup.select(
            ".audio-module-tools, .audio-embed-overlay, .audiotools, "
            "li.subscribe, .bucketwrap.ecommerce, .ecommerce, .ecomm_body, "
            "form, button, input"
        )
    ):
        node.decompose()
    for add_control in list(
        soup.select("a[href*='NPR.Player.Action.ADD_TO_PLAYLIST']")
    ):
        # Some 2010 templates omit the ``audiotools`` class.  Their otherwise
        # anonymous list contains only Add/Download/Transcript player actions.
        tool_list = add_control.find_parent("ul")
        if isinstance(tool_list, Tag):
            tool_list.decompose()
        else:
            add_control.decompose()
    # Older NPR story wrappers place podcast subscription links in list items
    # (and, in a few captures, an otherwise empty div) rather than paragraphs.
    # Inspect those leaf-like containers too so interface CTAs cannot survive
    # into the canonical article body.
    for node in list(soup.select("p, li, span, div, h3, a")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            node.name in {"p", "li", "span"}
            and re.fullmatch(r"[-–—]{8,}", text)
        ) or text == "read more" or (
            text == "read more:"
            and not (
                node.name in {"h3", "strong"}
                and node.find_parent(class_="container") is not None
            )
        ) or (
            node.name in {"p", "li", "span"}
            and text.startswith("copyright ©")
            and "npr. all rights reserved" in text
        ) or text.startswith(
            "listen to yesterday's song of the day"
        ) or (
            text.startswith("sign up for the all songs considered newsletter")
            and "new music features" in text
        ) or text.startswith(
            "register with the npr.org community"
        ) or text.startswith(
            "contact us with your questions and comments"
        ) or text.startswith(
            "all rights reserved. no part of this excerpt may be reproduced"
        ) or (
            node.name in {"p", "li", "span"}
            and
            text.startswith(
                "npr transcripts are created on a rush deadline by verb8tm"
            )
            and "authoritative record of npr" in text
        ) or text.startswith(
            "sign up for our limited-run newsletter to receive more tips on sleep"
        ) or re.fullmatch(
            r"sign up for the dry january newsletter series here\b.*",
            text,
        ) or text == "terms and conditions may apply" or re.fullmatch(
            r"for more tiny desk concerts,\s*"
            r"subscribe to our podcast\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the )?.+ podcast\s*[.!?]?",
            text,
        ) or (
            text.startswith("subscribe to our show on ")
            and ("podcast" in text or "npr one" in text)
        ) or re.fullmatch(
            r"subscribe to (?:the )?npr(?: .+)? newsletter\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the )?(?:newsletter|podcast)\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the |our )?newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to (?:the |our )?.*?\bpodcast"
            r"(?:\s+here)?\s*[.!?]?",
            text,
        ) or (
            text.startswith("subscribe to the podcast")
            and any(
                marker in text
                for marker in (
                    "like us on facebook",
                    "follow us on twitter",
                    "sign up to our newsletter",
                )
            )
        ) or re.fullmatch(
            r"sign up for (?:the )?.+\bchallenge\b.*",
            text,
        ) or re.fullmatch(
            r"sign up for the newsletter\b.*\bsubscribe here\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"sign up for (?:our|the) newsletter(?: here)?\s*[.!?]?",
            text,
        ) or re.fullmatch(
            r"sign up for the planet money newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"subscribe to the life kit newsletter\b.*",
            text,
        ) or re.fullmatch(
            r"sign up for the pod club newsletter\b.*",
            text,
        ) or (
            text.startswith("sign up for our ")
            and " newsletter" in text
            and "share it with a friend" in text
        ):
            node.decompose()
    # A modern NPR audio-story template can place a bare ``RELATED`` marker
    # inside ``#storytext`` followed by a related-program card and the show's
    # subscription/music chrome.  It has no class or heading hook, so the
    # generic container cleanup above cannot see it.  Once this exact marker
    # appears in the story body, everything after it is presentation chrome,
    # not part of the article transcript.
    for marker in list(soup.select("#storytext > p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "related":
            continue
        for sibling in list(marker.find_next_siblings()):
            sibling.decompose()
        marker.decompose()
    for container in list(soup.select(".container")):
        header = container.select_one(":scope > .conheader")
        header_text = _clean_text(
            header.get_text(" ", strip=True) if header is not None else ""
        ).casefold()
        if header_text in {
            "read more",
            "read more:",
            "related stories",
            "related npr stories",
        }:
            container.decompose()


def _npr_short_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = {
        str(value).casefold()
        for value in (soup.body.get("class") or [])
    } if soup.body is not None else set()
    dacs_audio_only = {
        "is-dacs-only",
        "no-transcript",
    }.issubset(body_classes)
    return body_characters < 200 and (
        bool(_npr_audio_story_nodes(soup)) or dacs_audio_only
    )


def _npr_legacy_metadata_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    """Recognize complete short descriptions from NPR's legacy audio pages."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    story_text = soup.select_one("#storytext")
    medium = _clean_text(
        _meta_content(soup, "name", "medium") or ""
    ).casefold()
    return bool(
        medium == "audio"
        and bool(
            body_classes & {"tmplnewsstory", "tmplmusicstory"}
        )
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_legacy_unavailable_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
) -> bool:
    """Recognize legacy radio segments captured before audio publication."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    story_text = soup.select_one("#storytext")
    unavailable = soup.select_one(
        "#storyspan02 .bucketwrap.primary.unavailable .avcontent.listen"
    )
    unavailable_text = _clean_text(
        unavailable.get_text(" ", strip=True)
        if isinstance(unavailable, Tag)
        else ""
    ).casefold()
    return bool(
        "tmplnewsstory" in body_classes
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and isinstance(unavailable, Tag)
        and unavailable.select_one("p") is not None
        and unavailable_text.startswith("audio for this story from ")
        and " will be available " in unavailable_text
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_legacy_named_audio_story(
    soup: BeautifulSoup,
    *,
    body: Tag | None,
    canonical_url: str,
) -> bool:
    """Recover a narrowly identified legacy Morning Edition audio series."""
    body_characters = len(
        _clean_text(body.get_text(" ", strip=True)) if body is not None else ""
    )
    body_classes = (
        {
            str(value).casefold()
            for value in (soup.body.get("class") or [])
        }
        if soup.body is not None
        else set()
    )
    path = urlsplit(canonical_url).path.casefold().rstrip("/")
    story_text = soup.select_one("#storytext")
    return bool(
        "tmplnewsstory" in body_classes
        and re.search(r"/(?:the-)?last-word-in-business$", path)
        and isinstance(story_text, Tag)
        and story_text.select_one("p") is not None
        and soup.select_one(".transcript") is None
        and 1 <= body_characters < 200
    )


def _npr_story_audio_url(
    soup: BeautifulSoup,
    *,
    base_url: str,
) -> str | None:
    nodes = _npr_audio_story_nodes(soup)
    for container in nodes:
        for link in container.select("a[href]"):
            url = _normalized_url(link.get("href"), base_url=base_url)
            if url and re.search(
                r"(?i)\.(?:aac|m4a|mp3|wav)(?:[?#]|$)",
                url,
            ):
                return url
        for player in container.select("[data-audio]"):
            payload = player.get("data-audio")
            if not isinstance(payload, str):
                continue
            try:
                decoded = json.loads(payload)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, dict):
                url = _normalized_url(
                    decoded.get("audioUrl"),
                    base_url=base_url,
                )
                if url:
                    return url
    return None


def _nyt_has_interactive_metadata(soup: BeautifulSoup) -> bool:
    metadata = " ".join(
        value
        for value in (
            _meta_content(soup, "name", "typ"),
            _meta_content(soup, "name", "template"),
            _meta_content(soup, "name", "tom"),
            _meta_content(soup, "name", "display-name"),
            _meta_content(soup, "name", "PST"),
            _tag_attribute(soup.select_one("html[class]"), "class"),
        )
        if value
    )
    return "interactive" in metadata.casefold()


def _nyt_media_content_type(
    soup: BeautifulSoup,
    *,
    default: ContentType,
    structured_image_gallery_selected: bool,
    interactive_body_selected: bool,
    canonical_url: str,
) -> ContentType:
    if structured_image_gallery_selected:
        return ContentType.GALLERY
    # An ordinary article can link to a separate NYT slideshow without
    # embedding its cover or slide payload in the current document.  In that
    # case the selected prose is the complete record and the link alone must
    # not turn this page into an incomplete gallery.  Linked packages whose
    # cover or slides were actually recovered set
    # ``structured_image_gallery_selected`` above and remain galleries.
    if _nyt_has_interactive_metadata(soup):
        return ContentType.INTERACTIVE
    # A subset of NYT Books Review visual essays is intentionally a single
    # illustration with a credit line.  The archived shell has no prose
    # article body, but its structured description and lead image are the
    # complete editorial record; classify it as a gallery instead of marking
    # the parser partial.
    if "/books/review/" in canonical_url.casefold():
        description = _first_text(
            _meta_content(soup, "name", "description"),
            _meta_content(soup, "property", "og:description"),
        )
        article_body = soup.select_one(
            "section[name='articleBody'], .meteredContent"
        )
        if not isinstance(article_body, Tag):
            article_body = soup.select_one("article")
        body_text = (
            _clean_text(article_body.get_text(" ", strip=True))
            if isinstance(article_body, Tag)
            else ""
        )
        lead_image = _meta_content(soup, "property", "og:image")
        if (
            description
            and len(body_text) < 100
            and lead_image
            and not _nyt_generic_branding_image(lead_image)
        ):
            return ContentType.GALLERY
    if (
        soup.find(
            string=lambda value: isinstance(value, Comment)
            and "shortarticle" in value.casefold()
        )
        and soup.select_one(
            ".articleSpanImage img[src], .articleInline img[src]"
        )
        and len(
            _clean_text(
                " ".join(
                    node.get_text(" ", strip=True)
                    for node in soup.select("[itemprop='articleBody']")
                )
            )
        )
        < _MINIMUM_BODY_CHARACTERS
    ):
        return ContentType.GALLERY
    if any(
        re.search(
            r"""(?i)["']source["']\s*:\s*["'][^"']+\.mp3(?:[?"']|$)""",
            (script.string or script.get_text()).replace("\\/", "/"),
        )
        for script in soup.select(
            "#interactiveFreeFormMain script, .interactive-graphic script"
        )
    ):
        return ContentType.AUDIO
    state = _nyt_preloaded_state(soup)
    body_types = {
        value.get("__typename")
        for key, value in state.items()
        if ".sprinkledBody.content" in key and isinstance(value, dict)
    }
    if "VideoBlock" in body_types:
        return ContentType.VIDEO
    # Ordinary articles can embed a calculator, map or other interactive
    # alongside substantive prose. A missing interactive payload accompanied
    # by only a short synopsis is still an interactive shell, but merely
    # finding an InteractiveBlock beside a complete prose body is not a
    # dominance signal.
    nyt_article_body = soup.select_one(
        "section[name='articleBody'], .meteredContent"
    )
    if not isinstance(nyt_article_body, Tag):
        nyt_article_body = soup.select_one("article")
    nyt_article_body_characters = len(
        _clean_text(nyt_article_body.get_text(" ", strip=True))
        if isinstance(nyt_article_body, Tag)
        else ""
    )
    if "InteractiveBlock" in body_types and (
        interactive_body_selected
        or nyt_article_body_characters < 300
    ):
        return ContentType.INTERACTIVE
    if soup.select_one(
        "figure.video.lede[data-videoid], "
        "figure.media.video.lede .video-link[href*='/video/']"
    ):
        return ContentType.VIDEO
    tagline = _first_text(
        _meta_content(soup, "name", "nyt-collection:tagline"),
        _meta_content(soup, "property", "nyt-collection:tagline"),
    )
    if tagline and "cartoon" in tagline.casefold():
        return ContentType.GALLERY
    description = _first_text(
        _meta_content(soup, "name", "description"),
        _meta_content(soup, "property", "og:description"),
    )
    url = canonical_url.casefold()
    if (
        description
        and "comic strip" in description.casefold()
        and (
            "/comics" in url
            or "-comics." in url
            or "/the-strip-" in url
        )
        and soup.select_one("article img, .story-body img, #story-body img")
    ):
        return ContentType.GALLERY
    page_text = soup.get_text(" ", strip=True).casefold()
    if (
        "editorial cartoonist" in page_text
        and soup.select_one("article img, main img, .story-body img")
    ):
        return ContentType.GALLERY
    if (
        "/opinion/cartoon-" in url
        and soup.select_one("article img, main img, .story-body img")
    ):
        return ContentType.GALLERY
    if (
        soup.select_one(".interactive-headline")
        and soup.select_one(
            "img[src*='int.nyt.com/newsgraphics/'], "
            "img[data-src*='int.nyt.com/newsgraphics/']"
        )
    ):
        return ContentType.INTERACTIVE
    if (
        "/interactive/" in url
        and any(
            re.search(
                r"""DV\.(?:flexLoad|load)\(\s*["']"""
                r"""(?:https?:)?//(?:www\.)?documentcloud\.org/""",
                script.string or script.get_text(),
                flags=re.IGNORECASE,
            )
            for script in soup.select(".interactive-graphic script")
        )
    ):
        return ContentType.INTERACTIVE
    if (
        "/interactive/" in url
        and _nyt_interactive_redirect_destination(soup) is not None
    ):
        return ContentType.INTERACTIVE
    if _nyt_legacy_interactive_shell_document(
        soup,
        canonical_url=canonical_url,
    ):
        return ContentType.INTERACTIVE
    if soup.select_one(
        "figure.interactive-embedded .interactive-graphic"
    ):
        return ContentType.INTERACTIVE
    if (
        description
        and description.casefold().startswith("as interpreted by ")
        and soup.select_one(
            "#story-body img[src], .story-body img[src], #article img[src]"
        )
    ):
        return ContentType.GALLERY
    if (
        "/opinion/" in url
        and re.search(r"(?:^|[-_/])heng(?:[-_.]|$)", url)
        and soup.select_one("img[src*='hengart' i]")
    ):
        return ContentType.GALLERY
    legacy_story_body = soup.select_one(
        "article.story.theme-main .story-body"
    )
    legacy_story_image = (
        legacy_story_body.select_one(
            "figure[itemprop='associatedMedia'] img[src]"
        )
        if isinstance(legacy_story_body, Tag)
        else None
    )
    legacy_story_prose = (
        " ".join(
            node.get_text(" ", strip=True)
            for node in legacy_story_body.select(
                ".story-content[itemprop='articleBody'], "
                "p.story-body-text.story-content"
            )
        )
        if isinstance(legacy_story_body, Tag)
        else ""
    )
    if (
        legacy_story_image is not None
        and len(_clean_text(legacy_story_prose)) < _MINIMUM_BODY_CHARACTERS
    ):
        return ContentType.GALLERY
    if "/interactive/" in url and default == ContentType.LIVEBLOG:
        return ContentType.INTERACTIVE
    return default


def _nyt_unhydrated_interactive_shell(
    soup: BeautifulSoup,
    *,
    content_type: ContentType,
    plain_text: str,
    blocks: list[ContentBlock],
    images: list[ImageCandidate],
) -> bool:
    """Reject a short NYT interactive whose actual media never hydrated."""
    if content_type != ContentType.INTERACTIVE or len(plain_text) >= 500:
        return False
    state = _nyt_preloaded_state(soup)
    if not any(
        isinstance(value, dict)
        and value.get("__typename") == "InteractiveBlock"
        for value in state.values()
    ):
        return False
    if any(image.should_archive for image in images):
        return False
    return not any(
        block.type in {BlockType.IMAGE, BlockType.EMBED, BlockType.TABLE}
        for block in blocks
    )


def _nyt_legacy_interactive_shell_document(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> bool:
    """Recognize archived NYT packages whose experience is external JS."""
    if "/interactive/" not in canonical_url.casefold():
        return False
    root = soup.select_one("html.page-interactive, article.theme-interactive")
    return isinstance(root, Tag) and soup.select_one(
        ".interactive-headline, .interactive-header, #story.theme-interactive"
    ) is not None


def _is_publisher_notice(
    *,
    headline: str | None,
    description: str | None,
    plain_text: str,
) -> bool:
    combined = " ".join(
        value for value in (headline, description, plain_text) if value
    ).casefold()
    return bool(
        re.search(
            r"\barticle was published in error\b|"
            r"\binadvertently published on this page\b|"
            r"\b(?:article|feature) (?:has been|was) removed "
            r"because of a copyright dispute\b",
            combined,
        )
    )


def _is_structured_short_record(
    *,
    spec: PublisherSpec,
    soup: BeautifulSoup,
    news_article: dict[str, Any],
    canonical_url: str,
    headline: str | None,
    plain_text: str,
) -> bool:
    if not headline:
        return False
    if spec.publisher == "bloomberg":
        legacy_body = soup.select_one("#story_content")
        description = _meta_content(soup, "name", "description")
        if legacy_body is not None and description:
            paragraphs = [
                _clean_text(node.get_text(" ", strip=True))
                for node in legacy_body.find_all("p", recursive=False)
            ]
            paragraphs = [
                text
                for text in paragraphs
                if text
                and not re.match(
                    r"(?i)^to contact the (?:reporter|editor)\b",
                    text,
                )
            ]
            description_words = set(
                re.findall(r"[a-z0-9]+", description.casefold())
            )
            body_words = set(
                re.findall(r"[a-z0-9]+", plain_text.casefold())
            )
            if (
                80 <= len(plain_text) < 120
                and len(paragraphs) == 1
                and paragraphs[0] == plain_text
                and len(description_words) >= 8
                and len(description_words & body_words)
                / len(description_words)
                >= 0.9
                and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
            ):
                return True
        modern_body = soup.select_one(
            "article.businessweek[itemtype$='/Article'] "
            ".article-body__content"
        )
        primary_category = soup.select_one(
            "article.businessweek meta.primary-category"
            "[content='businessweek-magazine']"
        )
        modern_paragraphs = (
            [
                _clean_text(node.get_text(" ", strip=True))
                for node in modern_body.find_all("p", recursive=False)
                if _clean_text(node.get_text(" ", strip=True))
            ]
            if isinstance(modern_body, Tag)
            else []
        )
        return bool(
            80 <= len(plain_text) < 150
            and primary_category is not None
            and len(modern_paragraphs) == 1
            and modern_paragraphs[0] == plain_text
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
    if spec.publisher == "axios":
        # The earliest Axios archive includes legitimate news cards that only
        # retain a headline, an image caption/source and a "Go deeper" link.
        # They have complete NewsArticle metadata plus the legacy share chrome
        # repeated above and below the card; that combination distinguishes
        # them from a generic empty shell or paywall.
        page_text = _clean_text(soup.get_text(" ", strip=True)).casefold()
        return bool(
            15 <= len(plain_text) < _MINIMUM_BODY_CHARACTERS
            and news_article
            and page_text.count("axios on facebook") >= 2
            and "go deeper" in page_text
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
    if spec.publisher == "caixin":
        legacy_body = soup.select_one("#Main_Content_Val")
        return bool(
            isinstance(legacy_body, Tag)
            and 30 <= len(plain_text) < _MINIMUM_BODY_CHARACTERS
            and (
                re.match(r"^(?:编辑更正|休刊启事)", headline)
                or (
                    "特此更正" in plain_text
                    and re.search(r"(?:编辑部|杂志社)\s*$", plain_text)
                )
            )
            and not re.search(
                r"(?:继续阅读|登录|注册|订阅)\s*$",
                plain_text,
            )
        )
    if spec.publisher == "reuters":
        combined = f"{headline}\n{plain_text}".casefold()
        return bool(
            len(plain_text) >= 40
            and (
                headline.casefold().startswith("brief-")
                or re.match(r"(?i)^标题新闻[：:]", headline)
                or "路透中文快讯将暂不做进一步报导" in combined
            )
        )
    if spec.publisher == "nyt":
        page_text = _clean_text(soup.get_text(" ", strip=True)).casefold()
        # Metropolitan Diary sometimes publishes a complete reader-submitted
        # poem that is intentionally shorter than the generic article floor.
        # Its stable desk URL, salutation and multiple authoritative legacy
        # body paragraphs distinguish it from a truncated article shell.
        metropolitan_diary_paragraphs = soup.select(
            "p.story-body-text[itemprop='articleBody']"
        )
        metropolitan_diary = bool(
            "/nyregion/metropolitan-diary-" in canonical_url.casefold()
            and plain_text.casefold().startswith("dear diary:")
            and len(metropolitan_diary_paragraphs) >= 2
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
        return bool(
            len(plain_text) >= 50
            and (
                (
                    "sports briefing" in page_text
                    and (
                        "by the associated press" in page_text
                        or "by associated press" in page_text
                        or "by reuters" in page_text
                    )
                )
                or (
                    headline.casefold().startswith("corrections:")
                    and re.fullmatch(
                        r"(?i)no corrections appeared in print on .+",
                        plain_text,
                    )
                )
                or metropolitan_diary
            )
        )
    if spec.publisher == "wsj":
        section = _string_or_none(news_article.get("articleSection"))
        display_type = _meta_content(
            soup,
            "name",
            "article.type.display",
        )
        return bool(
            len(plain_text) >= _MINIMUM_BODY_CHARACTERS
            and (
                (section and "wire" in section.casefold())
                or (
                    display_type
                    and "dow jones newswires" in display_type.casefold()
                )
            )
        )
    if spec.publisher == "scmp":
        # Legacy SCMP carried intentionally terse AP news alerts in the
        # authoritative Drupal body container. They can be just under the
        # generic 100-character floor, but the explicit AP dateline and
        # canonical page title distinguish them from truncated shells.
        legacy_body = soup.select_one(".field-name-body")
        legacy_text = (
            _clean_text(legacy_body.get_text(" ", strip=True))
            if isinstance(legacy_body, Tag)
            else ""
        )
        return bool(
            40 <= len(plain_text) < _MINIMUM_BODY_CHARACTERS
            and plain_text == legacy_text
            and soup.select_one("h1#page-title.title") is not None
            and re.match(
                r"^[A-Z][A-Za-z .,\'-]+\s+\(AP\)\s+[—-]",
                plain_text,
            )
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
    if spec.publisher != "ap":
        return False
    keywords = news_article.get("keywords")
    if isinstance(keywords, str):
        keyword_values = [keywords]
    elif isinstance(keywords, list):
        keyword_values = [value for value in keywords if isinstance(value, str)]
    else:
        keyword_values = []
    metric_labels = re.findall(
        r"(?i)(?:calories|fat|sodium|sugar|protein|"
        r"carbohydrates?|price|rank(?:ing)?)"
        r"(?:\s*\([^)]{1,12}\))?\s*:",
        plain_text,
    )
    keyword_keys = {
        re.sub(r"[^a-z0-9]+", "", value.casefold())
        for value in keyword_values
    }
    ap_news_alert = bool(
        len(plain_text) >= 40
        and (
            "apalertanoticioso" in keyword_keys
            or "apnewsalert" in keyword_keys
        )
    )
    ap_data_bulletin = (
        _is_ap_data_bulletin(news_article, "")
        and plain_text.casefold() == headline.casefold()
    )
    ap_score_bulletin = bool(
        len(plain_text) >= 40
        and any(
            re.search(r"(?i)\b(?:prep\s+)?scores?\b", value)
            for value in keyword_values
        )
    )
    description = _string_or_none(news_article.get("description"))
    ap_archive_brief = bool(
        len(plain_text) >= 40
        and description
        and plain_text == description
        and any(
            value.casefold() == "archive"
            for value in keyword_values
        )
        and not re.search(
            r"(?i)^(?:visit|view|click|subscribe)\b",
            plain_text,
        )
    )
    return bool(
        (
            re.match(r"^\s*#\d+\b", headline)
            and any(
                value.casefold() == "archive"
                for value in keyword_values
            )
            and len(metric_labels) >= 3
        )
        or ap_news_alert
        or ap_data_bulletin
        or ap_score_bulletin
        or ap_archive_brief
    )


def _wsj_interactive_puzzle(
    soup: BeautifulSoup,
    article: dict[str, Any],
    canonical_url: str,
) -> bool:
    section = _string_or_none(article.get("articleSection")) if article else None
    has_puzzle_embed = soup.select_one(
        ".interactive-puzzle-template iframe, "
        ".puzzle-template-article-sector iframe, "
        "iframe[class*='puzzle' i], "
        "a[href*='/documents/'][href$='.pdf' i]"
    )
    if not has_puzzle_embed:
        return False
    url = canonical_url.casefold()
    return bool(
        (section and "puzzle" in section.casefold())
        or any(
            token in url
            for token in (
                "acrostic",
                "crossword",
                "cryptic-puzzle",
                "variety-puzzle",
                "number-puzzles",
                "/puzzles/",
            )
        )
    )


def _wsj_puzzle_body(
    soup: BeautifulSoup,
    *,
    canonical_url: str,
) -> Tag | None:
    links = [
        link
        for link in soup.select("a[href]")
        if (
            (href := _string_or_none(link.get("href")))
            and "/documents/" in href.casefold()
            and href.casefold().split("?", 1)[0].endswith(".pdf")
        )
    ]
    if not links:
        return None
    page_text = _clean_text(soup.get_text(" ", strip=True)).casefold()
    url = canonical_url.casefold()
    if "puzzle" not in page_text and "puzzle" not in url:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    seen: set[str] = set()
    for link in links:
        href = str(link.get("href"))
        if href in seen:
            continue
        seen.add(href)
        label = _tag_text(link) or "Download puzzle PDF"
        paragraph = document.new_tag("p")
        paragraph.string = label
        article.append(paragraph)
        iframe = document.new_tag("iframe")
        iframe["src"] = href
        iframe["title"] = label
        article.append(iframe)
    return article if seen else None


def _prefer_structured_body_with_media(
    body: Tag,
    *,
    structured_body: Tag,
    force: bool = False,
) -> Tag:
    body_text = _clean_text(body.get_text(" ", strip=True))
    structured_text = _clean_text(
        structured_body.get_text(" ", strip=True)
    )
    if (
        not force
        and (
            len(body_text) >= _MINIMUM_BODY_CHARACTERS
            or len(structured_text) <= len(body_text)
        )
    ):
        return body

    media_source = body
    if force:
        editorial_body = body.select_one(
            ".article-content-container, #FineDining"
        )
        if isinstance(editorial_body, Tag):
            media_source = editorial_body
    media_nodes = list(media_source.select("figure"))
    media_nodes.extend(
        node
        for node in media_source.select("iframe")
        if node.find_parent("figure") is None
    )
    media_nodes.extend(
        node
        for node in media_source.select("img")
        if node.find_parent("figure") is None
    )
    for media in media_nodes:
        clone_document = BeautifulSoup(str(media), "html.parser")
        clone = clone_document.find(media.name)
        if not isinstance(clone, Tag):
            continue
        if media.name == "img":
            wrapper = clone_document.new_tag("figure")
            clone.extract()
            wrapper.append(clone)
            structured_body.append(wrapper)
        else:
            structured_body.append(clone)
    return structured_body


def _nyt_birdkit_attendee_body(
    soup: BeautifulSoup,
) -> Tag | None:
    rows: list[tuple[str, str]] = []
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if not value or "sheets:{attendees:[" not in value:
            continue
        for match in _NYT_ATTENDEE_RE.finditer(value):
            try:
                name = json.loads(f'"{match.group(1)}"')
                caption = json.loads(f'"{match.group(2)}"')
            except (json.JSONDecodeError, TypeError):
                continue
            name = _clean_text(str(name))
            caption = _clean_text(str(caption))
            if name:
                rows.append((name, caption))
    if len(rows) < 3:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for name, caption in rows:
        paragraph = document.new_tag("p")
        paragraph.string = f"{name} — {caption}" if caption else name
        article.append(paragraph)
    return article


def _embedded_html_body(
    soup: BeautifulSoup,
    *,
    keys: tuple[str, ...],
) -> Tag | None:
    decoder = json.JSONDecoder()
    quoted_keys = tuple(f'"{key}"' for key in keys)
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if not value or not any(key in value for key in quoted_keys):
            continue
        starts = [
            match.end()
            for match in re.finditer(r"=\s*(?=\{)", value)
        ]
        if not starts:
            first_object = value.find("{")
            if first_object >= 0:
                starts.append(first_object)
        for start in starts:
            try:
                payload, _ = decoder.raw_decode(value[start:])
            except (json.JSONDecodeError, TypeError):
                continue
            for item in _walk_json_objects(payload):
                for key in keys:
                    html_value = item.get(key)
                    if (
                        not isinstance(html_value, str)
                        or not html_value.strip()
                    ):
                        continue
                    document = BeautifulSoup(
                        f"<article>{html_value}</article>",
                        "html.parser",
                    )
                    article = document.article
                    if isinstance(article, Tag):
                        return article
    return None


def _wsj_inset_table_body(soup: BeautifulSoup) -> Tag | None:
    """Render archived WSJ graphics data-table JSON into semantic tables."""
    decoder = json.JSONDecoder()
    payloads: list[dict[str, Any]] = []
    marker = re.compile(
        r"\bvar\s+insetData_[A-Za-z0-9_]+\s*=\s*"
        r"function\s*\(\s*\)\s*\{\s*return\s*",
    )
    for script in soup.find_all("script"):
        value = script.string or script.get_text()
        if not value or "insetData_" not in value:
            continue
        for match in marker.finditer(value):
            try:
                payload, _ = decoder.raw_decode(value[match.end() :])
            except (json.JSONDecodeError, TypeError):
                continue
            if (
                isinstance(payload, dict)
                and isinstance(payload.get("data"), list)
                and payload["data"]
            ):
                payloads.append(payload)
    if not payloads:
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='wsj-inset-tables'></article>",
        "html.parser",
    )
    article = document.article
    if not isinstance(article, Tag):
        return None
    for payload in payloads:
        rows = [row for row in payload["data"] if isinstance(row, dict)]
        if not rows:
            continue
        configured_columns = payload.get("settings", {}).get("columns", [])
        columns = [
            str(column["name"])
            for column in configured_columns
            if isinstance(column, dict)
            and isinstance(column.get("name"), str)
            and column["name"] in rows[0]
        ]
        if not columns:
            columns = [str(key) for key in rows[0]]
        headline = _string_or_none(payload.get("headline"))
        if headline:
            heading = document.new_tag("h2")
            heading.string = headline
            article.append(heading)
        description = _string_or_none(payload.get("description"))
        if description and (
            not headline or description.casefold() != headline.casefold()
        ):
            paragraph = document.new_tag("p")
            paragraph.string = description
            article.append(paragraph)
        table = document.new_tag("table")
        header = document.new_tag("thead")
        header_row = document.new_tag("tr")
        for column in columns:
            cell = document.new_tag("th")
            cell.string = column
            header_row.append(cell)
        header.append(header_row)
        table.append(header)
        table_body = document.new_tag("tbody")
        for row in rows:
            table_row = document.new_tag("tr")
            for column in columns:
                cell = document.new_tag("td")
                cell.string = _clean_text(
                    BeautifulSoup(
                        f"<span>{row.get(column, '')}</span>",
                        "html.parser",
                    ).get_text(" ", strip=True)
                )
                table_row.append(cell)
            table_body.append(table_row)
        table.append(table_body)
        article.append(table)
        source = _string_or_none(payload.get("source"))
        if source:
            source_paragraph = document.new_tag("p")
            source_paragraph.string = f"Source: {source}"
            article.append(source_paragraph)
    return article if article.select_one("table") is not None else None


def _remove_noise(soup: BeautifulSoup, spec: PublisherSpec) -> None:
    for comment in list(
        soup.find_all(string=lambda value: isinstance(value, Comment))
    ):
        comment.extract()
    for selector in (*COMMON_REMOVE_SELECTORS, *spec.remove_selectors):
        for node in soup.select(selector):
            node.decompose()
    for node in soup.select(
        "p, li, div, span, h1, h2, h3, h4, h5, h6"
    ):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text in _EXACT_NOISE_TEXT:
            node.decompose()
        elif spec.publisher == "aljazeera" and text in {
            "related",
            "back to top",
            "read more",
            "read more:",
            "recommended stories",
        }:
            # Legacy Al Jazeera article wrappers expose these navigation
            # labels as ordinary paragraphs inside the story body. Live
            # update captures also emit a standalone link to the preceding
            # update; keep linked ``Read more here`` prose, but drop the
            # label-only block.
            node.decompose()
        elif (
            spec.publisher == "aljazeera"
            and text.startswith(
                "the views expressed in this article are the author’s own"
            )
            and "al jazeera" in text
            and (
                "editorial policy" in text
                or "editorial stance" in text
            )
        ):
            # Opinion pages repeat this site disclaimer in the body; it is
            # publisher chrome rather than reporting.
            node.decompose()
        elif (
            spec.publisher == "aljazeera"
            and text.replace("’", "'").replace("‘", "'").startswith(
                "sign up for the prison journalism project's newsletter"
            )
            and "follow them on instagram" in text
            and " or x" in text
        ):
            # A Prison Journalism Project partner essay appends this external
            # newsletter/social CTA as an ordinary paragraph. Keep the
            # partnership disclosure and reporting, but remove the interface
            # promotion from normalized article content.
            node.decompose()
        elif (
            spec.publisher in {
                "aljazeera",
                "ap",
                "axios",
                "caixin",
                "ft",
                "npr",
                "scmp",
                "wsj",
            }
            and len(text) >= 2
            and set(text) == {"_"}
        ):
            # Al Jazeera live-update pages, Axios/Caixin/SCMP legacy pages,
            # NPR legacy/transcript pages and WSJ press-release feeds use
            # underscore-only paragraphs as visual rules. They are interface
            # separators, not article copy, and otherwise survive as ordinary
            # text blocks.
            node.decompose()
        elif (
            spec.publisher == "npr"
            and (
                (
                    "disclaimer" in {
                        str(value).casefold()
                        for value in (node.get("class") or [])
                    }
                    and "for personal, noncommercial use only" in text
                )
                or (
                    text.startswith(
                        "npr transcripts are created on a rush deadline"
                    )
                    and "authoritative record of npr's programming is the audio"
                    in text.replace("’", "'").replace("‘", "'")
                )
            )
        ):
            node.decompose()
        elif (
            spec.publisher == "bloomberg"
            and text == "share this article"
        ):
            node.decompose()
        elif (
            spec.publisher == "reuters"
            and text in {
                "subscribe to gift this article",
                "gift 5 articles to anyone you choose each month when you subscribe.",
                "already a subscriber?",
                "read more",
                "fetching latest articles",
            }
        ):
            # Syndicated Reuters copies on AFR and similar partners can keep
            # a short paywall/recirculation tail after the licensed story.
            # Remove only the standalone UI blocks; preserve article prose.
            node.decompose()
        elif (
            spec.publisher == "bloomberg"
            and node.name in {"p", "li", "span"}
            and text.startswith(
                (
                    "want to receive this post in your inbox",
                    "sign up for next china",
                    "sign up here to receive the davos diary",
                    "sign up for the new economy daily newsletter",
                    "sign up for our middle east newsletter",
                    "sign up for our coming middle east newsletter",
                    "for the best in travel, food, drinks, fashion, cars, "
                    "and life, sign up for the pursuits newsletter",
                )
            )
        ):
            node.decompose()
        elif (
            spec.publisher == "ft"
            and node.name == "p"
            and text.startswith(
                "copyright the financial times limited"
            )
            and "please don't " in text
            and "articles from ft.com" in text
        ):
            node.decompose()
    if spec.publisher == "ft":
        _remove_ft_body_chrome(soup)
        _remove_ft_newsletter_promos(soup)
        _strip_ft_copyright_suffixes(soup)
    if spec.publisher == "bloomberg":
        _remove_bloomberg_promos(soup)
    if spec.publisher == "nyt":
        _remove_nyt_promos(soup)
    if spec.publisher == "reuters":
        _remove_reuters_promos(soup)
        _normalize_reuters_legacy_press_release_media(soup)
    if spec.publisher == "wsj":
        _remove_wsj_promos(soup)


def _trim_bloomberg_subscription_tail(soup: BeautifulSoup) -> None:
    """Drop Bloomberg Professional subscription shells after real excerpts."""
    marker = next(
        (
            node
            for node in soup.select("p, div")
            if _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith(
                "to continue reading this article you must be a bloomberg "
                "professional service subscriber"
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


def _remove_bloomberg_damaged_attribution(soup: BeautifulSoup) -> None:
    """Drop a standalone joint byline whose contributor was lost upstream."""
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"Bloomberg News\s+and", text, re.IGNORECASE):
            node.decompose()


def _remove_bloomberg_promos(soup: BeautifulSoup) -> None:
    # Food Safety News embeds a donation card after licensed Bloomberg
    # reporting. Its nested heading can survive text-level footer cleanup, so
    # remove the card as a unit.
    for node in list(soup.select("div")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            "bg-blue-primary" in (node.get("class") or [])
            and
            "food safety news is nonprofit and reader-funded" in text.casefold()
            and "donate today" in text.casefold()
        ):
            node.decompose()

    for heading in list(soup.select("h1, h2, h3, h4, h5, h6")):
        next_tag = heading.find_next_sibling()
        if (
            isinstance(next_tag, Tag)
            and (
                "terminal-tout" in (next_tag.get("class") or [])
                or "terminal-tout-v2" in (next_tag.get("class") or [])
            )
        ):
            heading.decompose()

    # Business Times syndication pages place newsletter cards, feedback
    # prompts, and related-story grids inside the broad article wrapper. They
    # consistently mark these screen-only modules as ``no-print``.
    for node in list(soup.select(".no-print")):
        node.decompose()

    # Some 2015 article bodies append a single paragraph labelled
    # ``Related Story`` with several Bloomberg headlines and no reporting.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if (
            len(links) >= 2
            and re.match(
                r"Related Stor(?:y|ies)\s*:",
                _clean_text(node.get_text(" ", strip=True)),
                re.IGNORECASE,
            )
            and all(
                "bloomberg" in str(link.get("href") or "").casefold()
                for link in links
            )
        ):
            node.decompose()

    # WallStreetPit mirrors place their own affiliate disclosure inside the
    # same content column as the licensed Bloomberg copy.  Prefer the
    # structural class, with a narrowly worded text fallback for captures
    # where the wrapper was flattened.
    for node in list(soup.select(".entry-content > ul")):
        next_tag = node.find_next_sibling()
        if (
            isinstance(next_tag, Tag)
            and "adblock" in (next_tag.get("class") or [])
        ):
            node.decompose()
    for node in list(soup.select(".adblock")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Disclaimer:\s*This page contains affiliate links\s*\.?\s*"
            r"If you choose to make a purchase after clicking a link,\s*"
            r"we may receive a commission at no additional cost to you\.\s*"
            r"Thank you for your support!",
            text,
            re.IGNORECASE,
        ):
            node.decompose()
    for node in list(soup.select(".entry-tags")):
        node.decompose()
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Disclaimer:\s*This page contains affiliate links\s*\.?\s*"
            r"If you choose to make a purchase after clicking a link,\s*"
            r"we may receive a commission at no additional cost to you\.\s*"
            r"Thank you for your support!",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Bloomberg Businessweek occasionally published contributed education
    # tips with a final partner trial CTA inside the article container.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Plan on taking the SAT soon\?\s*Sign-?up for a trial "
            r"of Veritas Prep SAT 2400 on Demand\.?",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Gasgoo's current article template appends its supplier-services card,
    # copyright notice, and current-news grid inside the same article element
    # as licensed Bloomberg copy.  The paired service addresses and the two
    # distinct card titles make these safe, structural removals.
    for node in list(soup.select("div")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            "buyer-support@gasgoo.com" in text
            and "seller-support@gasgoo.com" in text
        ) or (
            "weekly highlights" in text
            and "[gasgoo express]" in text
            and "gasgoo.com" not in text
        ):
            node.decompose()
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"All Rights Reserved\. Do not reproduce, copy and use the "
            r"editorial content without permission\. Contact us: "
            r"autonews@gasgoo\.com",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Legacy terminal editions can pack a complete related-news navigation
    # module into one paragraph instead of separating its heading and links.
    # A few captured editions put the navigation after legitimate text (and
    # sometimes HTML escaped list markup), so retain that lead-in instead of
    # discarding the entire paragraph.
    terminal_related_news = re.compile(
        r"For Related (?:News\s*(?:&|and)\s*)?Information\s*:\s*.+"
        r"(?:<\s*GO\s*>|\{\s*[A-Z0-9 ]{2,80}\s*\})"
        r".*",
        re.IGNORECASE,
    )
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        match = terminal_related_news.search(text)
        if match is None:
            continue
        retained = re.sub(
            r"</?(?:ul|ol|li)\b[^>]*>",
            " ",
            text[: match.start()],
            flags=re.IGNORECASE,
        )
        retained = _clean_text(retained)
        if retained:
            node.clear()
            node.append(retained)
        else:
            node.decompose()

    # Some terminal table editions append a Bloomberg command code after an
    # otherwise useful source attribution.  Preserve the agency name while
    # dropping only the non-reader-facing command suffix.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if not re.match(r"SOURCE\s*:", text, re.IGNORECASE):
            continue
        retained = re.sub(
            r"\s+\{\s*[A-Z0-9 ]{2,80}<\s*GO\s*>\s*\}\s*$",
            "",
            text,
            flags=re.IGNORECASE,
        )
        if retained != text:
            node.clear()
            node.append(retained)

    # Partner mirrors sometimes end an excerpt with a provenance link back to
    # the Bloomberg URL.  The canonical source is already retained in the
    # record, so do not leak this mirror wrapper into article text.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"Read the full article at\s+https?://(?:www\.)?"
            r"bloomberg\.com/(?:news/)?(?:articles?/)?\S+",
            text,
            re.IGNORECASE,
        ):
            node.decompose()

    # Stem-cell partner captures append a large accordion of unrelated posts
    # inside the broadly selected content container.
    for node in list(soup.select(".accordion.ddop")):
        node.decompose()
    for node in list(soup.select(".relatedposttitle")):
        parent = node.parent
        if parent is not None and parent.name in {"div", "section", "aside"}:
            parent.decompose()
        else:
            node.decompose()

    # Zillow guest articles can append a home-search CTA, a labelled related
    # list, and an author recirculation bio inside Bloomberg's story body.
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"To find mid-size homes for sale near you, .{1,240}",
            text,
            re.IGNORECASE,
        ):
            node.decompose()
            continue
        if re.fullmatch(
            r"Related items from Zillow Blog\s*:?",
            text,
            re.IGNORECASE,
        ):
            related_list = node.find_next_sibling()
            if (
                related_list is not None
                and related_list.name in {"ul", "ol"}
            ):
                related_list.decompose()
            node.decompose()

    # Bloomberg View used a paragraph of tildes as a semantic section break.
    # Preserve it as the schema's divider block instead of emitting a
    # punctuation-only paragraph.
    for node in list(soup.select("p")):
        if re.fullmatch(
            r"(?:~{3,}|-{3,})",
            _clean_text(node.get_text(" ", strip=True)),
        ):
            node.clear()
            node.name = "hr"

    # Some licensed mirrors append a bold Bloomberg credit to the final
    # reporting paragraph. Remove the terminal credit without dropping the
    # preceding sentence.
    for credit in list(soup.select("p > b:last-child, p > strong:last-child")):
        if re.fullmatch(
            r"Bloomberg",
            _clean_text(credit.get_text(" ", strip=True)),
            re.IGNORECASE,
        ):
            credit.decompose()

    # Legacy Bloomberg pages can insert a labelled recirculation list in the
    # middle of the reporting. Remove only the heading and its immediately
    # following all-link list; later reporting must remain intact.
    for heading in list(soup.select("h1, h2, h3, h4, h5, h6")):
        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if not re.fullmatch(
            r"For more on .{1,120},\s*read this next:?",
            heading_text,
            re.IGNORECASE,
        ):
            continue
        related_list = heading.find_next_sibling()
        if related_list is None or related_list.name not in {"ul", "ol"}:
            continue
        items = list(related_list.find_all("li", recursive=False))
        if not items:
            continue
        if not all(
            item.select_one("a[href]")
            and _clean_text(item.get_text(" ", strip=True))
            == _clean_text(
                " ".join(
                    link.get_text(" ", strip=True)
                    for link in item.select("a[href]")
                )
            )
            for item in items
        ):
            continue
        related_list.decompose()
        heading.decompose()

    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            re.fullmatch(r"Bloomberg", text, re.IGNORECASE)
            or re.fullmatch(
                r"(?:FIFW\s+)?NSN\s+[A-Z0-9]{10,14}\s*"
                r"<\s*GO\s*>\s+.+",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"bc-[a-z0-9]+(?:-[a-z0-9]+)+"
                r"(?:\s+\([A-Z]{2,10}\))?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"[A-Za-z][A-Za-z &'-]{2,100}\s*:\s*"
                r"NI\s+[A-Z0-9]{4,16}",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"Bill Rochelle is away\. For today['’]s U\.S\. bankruptcy "
                r"column and any updates, see \{\s*TNI\s+BCY\s+US\s+BN\s*"
                r"<\s*GO\s*>\s*\}\.?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"Read more posts from .{1,100}\.",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"-0-\s+(?:[A-Za-z]{3}/\d{1,2}/\d{4}|\d{1,2}/\d{1,2}/\d{4})"
                r"\s+\d{1,2}:\d{2}\s+(?:GMT|UTC)\.?",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"\(Updated(?:\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)?\.?"
                r"\s*See\s+\{\s*[A-Z0-9 ]{2,80}<\s*GO\s*>\s*\}\.?\s*\)",
                text,
                re.IGNORECASE,
            )
            or re.fullmatch(
                r"For other Bloomberg coverage,\s*click here\s*\.?",
                text,
                re.IGNORECASE,
            )
        ):
            node.decompose()

    for text_node in list(
        soup.find_all(
            string=re.compile(
                r"For other Bloomberg coverage,\s*click here\s*\.?",
                re.IGNORECASE,
            )
        )
    ):
        cleaned = re.sub(
            r"\s*For other Bloomberg coverage,\s*click here\s*\.?",
            "",
            str(text_node),
            flags=re.IGNORECASE,
        )
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Legacy Bloomberg pages sometimes append a Terminal command inside an
    # otherwise useful reporting paragraph.  Keep the conference-call detail
    # or article introduction, but remove only the machine navigation.
    terminal_inline_commands = (
        re.compile(
            r"\s*See\s+[A-Z0-9]{1,12}(?:\s+[A-Z0-9]{1,16})?\s*"
            r"<\s*Equity\s*>\s+EVTS?\s*<\s*GO\s*>",
            re.IGNORECASE,
        ),
        re.compile(
            r"\s*See\s+NI\s+[A-Z0-9]{2,20}\s*<\s*GO\s*>"
            r"(?:\s+for\s+[^.]{1,240})?\.?",
            re.IGNORECASE,
        ),
        re.compile(
            r"\s*See\s+[A-Z0-9]{1,24}(?:\s+[A-Z0-9]{1,24})?\s*"
            r"<\s*Index\s*>\s*(?:[A-Z]{1,8}\s*){0,4}<\s*GO\s*>\.?",
            re.IGNORECASE,
        ),
    )
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        cleaned = text
        for command in terminal_inline_commands:
            cleaned = command.sub("", cleaned)
        cleaned = _clean_text(cleaned)
        # The command itself can end in a period after a sentence that already
        # ended before ``See``; preserve the closing parenthesis, not ``..``.
        cleaned = re.sub(r"\.\s*\.(?=\))", ".", cleaned)
        if cleaned == text:
            continue
        if cleaned:
            node.clear()
            node.append(cleaned)
        else:
            node.decompose()

    # Some 2015 Bloomberg pages append an unlabelled related-story paragraph
    # inside the story section. It contains only multiple Bloomberg article
    # links and no prose outside those anchors.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if len(links) < 2:
            continue
        if not all(
            re.search(
                r"(?:bloomberg(?:view)?\.com/)?(?:news/)?articles/",
                str(link.get("href") or ""),
                re.IGNORECASE,
            )
            for link in links
        ):
            continue
        paragraph_text = _clean_text(node.get_text(" ", strip=True))
        linked_text = _clean_text(
            " ".join(link.get_text(" ", strip=True) for link in links)
        )
        if paragraph_text == linked_text:
            node.decompose()

    # A malformed 2015 recirculation paragraph can lose the anchor around its
    # second headline, leaving one Bloomberg story link followed by another
    # headline as plain text.  Restrict this repair to the terminal paragraph
    # and headline-shaped residual text so linked reporting prose is kept.
    for node in list(soup.select("p")):
        links = list(node.select("a[href]"))
        if len(links) != 1 or not re.search(
            r"(?:bloomberg(?:view)?\.com/)?(?:news/)?articles/",
            str(links[0].get("href") or ""),
            re.IGNORECASE,
        ):
            continue
        following = [
            sibling
            for sibling in node.find_next_siblings()
            if isinstance(sibling, Tag) and _tag_text(sibling)
        ]
        if following:
            continue
        clone = BeautifulSoup(str(node), "html.parser")
        for link in clone.select("a"):
            link.decompose()
        residual = _clean_text(clone.get_text(" ", strip=True))
        words = re.findall(r"[A-Za-z][A-Za-z’'-]*", residual)
        title_words = sum(
            word[0].isupper()
            for word in words
            if word.casefold() not in {"a", "an", "and", "at", "for", "in",
                                       "of", "on", "the", "to", "with"}
        )
        if (
            4 <= len(words) <= 20
            and not re.search(r"[.!?]($|\s)", residual)
            and title_words >= max(3, len(words) // 2)
        ):
            node.decompose()

    # Some 2014 personal-finance stories append a topic recirculation heading
    # and a sibling list of Bloomberg links after the final reporting block.
    for heading in list(soup.select("p")):
        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if not re.fullmatch(
            r"More on .{2,160}\s*:",
            heading_text,
            re.IGNORECASE,
        ):
            continue
        related_list = heading.find_next_sibling()
        if related_list is None or related_list.name not in {"ul", "ol"}:
            continue
        items = list(related_list.find_all("li", recursive=False))
        if not items or not all(
            item.select_one("a[href]")
            and _clean_text(item.get_text(" ", strip=True))
            == _clean_text(
                " ".join(
                    link.get_text(" ", strip=True)
                    for link in item.select("a[href]")
                )
            )
            for item in items
        ):
            continue
        related_list.decompose()
        heading.decompose()

    # Insurance Journal article tags and in-content subscription cards use
    # these structural classes. At this stage ``soup`` is the isolated body
    # clone and no longer contains partner-host metadata.
    for node in list(
        soup.select(
            "p.tagtag, .subscribe-banner, "
            "[class*='subscribe-banner' i], .story-tags"
        )
    ):
        node.decompose()

    # WordPress partner mirrors can leak their comment form into a broadly
    # selected story container.
    for node in list(
        soup.select(
            "#comments, #respond, .comment-respond, .comment-reply-title, "
            ".left_sidebar, .widget-area, section.widget, .post-navigation"
        )
    ):
        node.decompose()

    # CTRM Center's advertising and recirculation widgets can be nested inside
    # an unclosed story paragraph. Remove the widget nodes themselves so the
    # Bloomberg reporting around them remains intact.
    for node in list(
        soup.select(
            ".inPost, .gsfnura, .mostRecentPosts"
        )
    ):
        node.decompose()
    for text_node in list(
        soup.find_all(string=re.compile(r"(?i)sponsored\s+links\s*$"))
    ):
        cleaned = re.sub(
            r"(?i)\s*sponsored\s+links\s*$",
            "",
            str(text_node),
        )
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Some partner excerpts append ``Read more at Bloomberg`` to the final
    # reporting paragraph rather than placing the link in its own node. Keep
    # the useful excerpt, but remove the recirculation phrase.
    for node in list(soup.select("p")):
        text = _tag_text(node)
        if not re.search(
            r"(?i)\bread\s+more\s+at\s+bloomberg\s*\.?\s*$",
            text,
        ):
            continue
        if not any(
            "bloomberg.com/" in str(anchor.get("href") or "").casefold()
            for anchor in node.select("a[href]")
        ):
            continue
        for anchor in list(node.select("a[href]")):
            if "bloomberg.com/" in str(anchor.get("href") or "").casefold():
                anchor.decompose()
        for text_node in list(node.find_all(string=True)):
            cleaned = re.sub(
                r"(?i)\s*read\s+more\s+at\s*$",
                "",
                str(text_node),
            )
            if cleaned != str(text_node):
                if cleaned:
                    text_node.replace_with(cleaned)
                else:
                    text_node.extract()
        for text_node in list(node.find_all(string=True)):
            if re.fullmatch(r"\s*\.\s*", str(text_node)):
                text_node.extract()

    # The Daily Economy's older licensed copies append a Bloomberg source
    # link, a duplicate headline/byline/date, and an unrelated stock-image
    # credit after the final reporting sentence. The source marker shares the
    # paragraph with useful prose, so trim from its linked ``Read more`` text
    # onward instead of dropping the whole paragraph.
    for source_link in list(soup.select("p a[href]")):
        if not re.fullmatch(
            r"Read more",
            _tag_text(source_link),
            re.IGNORECASE,
        ):
            continue
        if "bloomberg.com/" not in str(
            source_link.get("href") or ""
        ).casefold():
            continue
        paragraph = source_link.find_parent("p")
        if not isinstance(paragraph, Tag):
            continue
        prior_text = _clean_text(
            "".join(str(item) for item in paragraph.contents).split(
                str(source_link),
                1,
            )[0]
        )
        if len(prior_text) < 120:
            continue
        for item in list(paragraph.contents)[
            list(paragraph.contents).index(source_link) :
        ]:
            if isinstance(item, Tag):
                item.decompose()
            else:
                item.extract()
        next_paragraph = paragraph.find_next_sibling("p")
        if (
            isinstance(next_paragraph, Tag)
            and re.fullmatch(
                r"Image by .{2,160}",
                _tag_text(next_paragraph),
                re.IGNORECASE,
            )
        ):
            next_paragraph.decompose()

    # Licensed CTRM Center copies place a republication disclaimer inside the
    # selected story container. Match both halves of its distinctive wording
    # so ordinary Bloomberg references to republication are preserved.
    for node in list(soup.select("p, span")):
        text = _tag_text(node).casefold()
        if (
            "republished on the ctrm center" in text
            and "if you have any issue with this post" in text
        ):
            node.decompose()

    # Legacy Bloomberg slideshows render the first image twice and keep both a
    # shortened ``Read More`` caption and a full ``Close`` caption in the DOM.
    # Retain each slide's full caption and image exactly once.
    for node in list(
        soup.select(
            ".slideshow_teaser, .slide_caption .cap_preview, "
            ".slider_close, .slider_controls, .slider_nav"
        )
    ):
        node.decompose()
    for anchor in list(soup.select(".slide_caption .cap_show a")):
        if _tag_text(anchor).casefold() == "close":
            anchor.decompose()
    # Older Bloomberg image attachments keep a hidden lightbox copy of the
    # title, credit, and caption next to the visible caption. Keep the
    # lightbox's larger image candidate, but discard its duplicate text.
    for node in list(
        soup.select(".simple_overlay .image_title, .simple_overlay .details")
    ):
        node.decompose()

    # Businessweek inline illustrations sometimes use the caption and image
    # alt text solely for issue promotion. Keep the illustration and its
    # credit, but do not expose the issue date or subscription call as a
    # descriptive caption.
    businessweek_image_promo = re.compile(
        r"Featured in Bloomberg Businessweek\s*,?\s*"
        r"[A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4}\.\s*"
        r"Subscribe now\s*\.?",
        re.IGNORECASE,
    )
    for caption in list(soup.select(".inline-media__caption")):
        if businessweek_image_promo.fullmatch(_tag_text(caption)):
            caption.decompose()
    for image in list(soup.select("img[alt]")):
        if businessweek_image_promo.fullmatch(
            _clean_text(str(image.get("alt") or ""))
        ):
            image["alt"] = ""

    # Partner mirrors may place a five-star voting form inside the article
    # container. It is interactive site chrome, not Bloomberg story content.
    for node in list(soup.select("form.rating, form#articleVotesSubmit")):
        node.decompose()

    # Some licensed partner pages append a link back to Bloomberg for the full
    # story, followed by the partner's membership and related-content modules.
    # The reporting before this marker is useful but necessarily partial.
    full_story_marker = next(
        (
            node
            for node in soup.select("p, div")
            if re.match(
                r"(?i)^(?:"
                r"click\s+here\s+to\s+read\s+the\s+full\s+story|"
                r"read\s+(?:the\s+)?full\s+article\s+here\s+"
                r"(?:via|at|on)\s+bloomberg"
                r")\b",
                _tag_text(node),
            )
            and any(
                "bloomberg.com/" in str(anchor.get("href") or "").casefold()
                for anchor in node.select("a[href]")
            )
        ),
        None,
    )
    if isinstance(full_story_marker, Tag):
        tail = full_story_marker
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        full_story_marker.decompose()

    # Syndicated Bloomberg forecast summaries sometimes append this provider
    # signup sentence after the source-article link.
    for node in list(soup.select("p, div, li")):
        if _tag_text(node).casefold().startswith(
            "click here to receive free and immediate email alerts"
        ):
            node.decompose()

    # Some Yahoo syndication captures contain provider HTML with every opening
    # angle bracket stripped (``/pp``, ``br /``, ``nbsp;/pp``). Preserve the
    # reporting while removing the provider upload/recirculation tail.
    for text_node in list(soup.find_all(string=re.compile(r"(?:nbsp;)?/pp"))):
        malformed = str(text_node)
        malformed = re.split(
            r"(?i)(?:nbsp;)?/ppem\s*uploaded by\b",
            malformed,
            maxsplit=1,
        )[0]
        malformed = re.sub(r"(?i)(?:^|\s)br\s*/", "\n\n", malformed)
        malformed = re.sub(r"(?i)(?:nbsp;)?/pp", "\n\n", malformed)
        text_node.replace_with(malformed.strip())

    for text_node in list(
        soup.find_all(string=re.compile(r"(?i)always-superb editing by"))
    ):
        linkedin_copy = str(text_node)
        linkedin_copy = re.split(
            r"(?is)\s+with\s+.{1,160}?\s+and\s+"
            r"always-superb editing by\b",
            linkedin_copy,
            maxsplit=1,
        )[0]
        text_node.replace_with(linkedin_copy.strip())

    shell_text = _clean_text(soup.get_text(" ", strip=True))
    shell_folded = shell_text.casefold()
    if "abitech analysis" in shell_folded:
        for card in list(soup.select(".card")):
            card.decompose()
    if (
        len(shell_text) < 400
        and "bias rating" in shell_folded
        and "reliability" in shell_folded
        and "politician portrayal" in shell_folded
    ):
        soup.clear()
        return

    bias_shell = next(
        (
            node
            for node in soup.select("p, h2, h3, h4, div")
            if _clean_text(node.get_text(" ", strip=True)).casefold().startswith(
                (
                    "want to see the in-depth bias analytics",
                    "create your free account to see the in-depth bias analytics",
                )
            )
        ),
        None,
    )
    if isinstance(bias_shell, Tag):
        tail = bias_shell
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        bias_shell.decompose()
        remaining = _clean_text(soup.get_text(" ", strip=True))
        if len(remaining) < 400 and "bias rating" in remaining.casefold():
            soup.clear()
            return

    """Remove legacy recirculation and standardized article footers."""
    for node in list(
        soup.select(
            ".text-to-speech, .brokerboxarticle, .terminal-tout, "
            ".terminal-tout-v2, "
            ".article-audio-attachment, "
            ".email-form, .similarstoryslide, button.read-more-button, "
            ".inner-page-cta-section, .minimal-detailfull-width-section, "
            ".ipsEntry__signature, [data-role='memberSignature'], "
            ".commentWrapper, .comments, #story_tools_bottom, "
            ".share_list, .entry_sharing, "
            ".youMightAlsoLike, .Pbanner, "
            ".relatedKeywords, .waChannelCta, .b-share-bar, "
            ".liveEventMain_widget, .primeSWrapper, .ts-dots, "
            ".bottomTopics, .topicListContainer, .topicListTitle, .tags"
            ", [id^='views-bootstrap-article-node-view-block-']"
            ", .article-share, .sharedaddy, .sd-sharing"
            ", .ai_podcast_030825, .ai_podcast_bottom_sticky_player_241025"
            ", .popup_ai_pb_overlay, .td_module_wrap, .td_block_wrap"
            ", .news-detail-content-block.ai-post, #story-source-gallery"
            ", .xenforo-comment-widget, .cbcalc-wrap, .ai-block, .lf-funnel"
            ", .usstock_widget"
            ", [data-testid='headline-stack-promo-liner-test-id']"
            ", [data-testid='tags-test-id']"
            ", [class*='GooglePreferredSource_']"
            ", img[src*='groundnews.b-cdn.net']"
            ", [data-animation-role='button'], "
            "[data-content-field='tags']"
        )
    ):
        node.decompose()

    for control in list(soup.select("[role='button'], button")):
        if (
            control.name == "a"
            and control.select_one("img") is not None
            and not _clean_text(control.get_text(" ", strip=True))
        ):
            control.unwrap()
        else:
            control.decompose()

    embedded_most_read = re.compile(
        r"(?is)\s*most read from bloomberg(?: businessweek)?.*$"
    )
    for text_node in list(soup.find_all(string=embedded_most_read)):
        cleaned = embedded_most_read.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)

    australia_briefing = re.compile(
        r"(?is)(?:and\s+)?for\s+a\s+daily\s+wrap\s+of\s+the\s+business,"
        r"\s*finance\s+and\s+economic\s+stories\s+that\s+matter\s+to\s+"
        r"australians,?\s*from\s+"
        r"bloomberg(?:'s|’s)\s+reporters\s+around\s+the\s+globe,\s*"
        r"sign\s+up\s+to\s+our\s+free\s+australia\s+briefing\s+"
        r"newsletter\.\s*"
    )
    for text_node in list(soup.find_all(string=australia_briefing)):
        cleaned = australia_briefing.sub("", str(text_node)).strip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    inside_canada_subscription = re.compile(
        r"(?is)\s*to\s+subscribe\s+to\s+inside\s+canada,\s*"
        r"click\s+here,\s*"
        r"hit\s+[“\"]display\s*&\s*edit[”\"]\s+and\s+then\s+"
        r"[“\"]set alert delivery[”\"]\s*$"
    )
    for text_node in list(
        soup.find_all(string=inside_canada_subscription)
    ):
        cleaned = inside_canada_subscription.sub(
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Legacy Bloomberg product press releases keep the substantive release
    # and a standardized Professional-service sales pitch in one ``pre``
    # text node. Truncate only at Bloomberg's distinctive boilerplate opener;
    # the following company profile and media contacts belong to the footer.
    professional_service_footer = re.compile(
        r"(?is)\s+the\s+bloomberg\s+professional(?:\^)?®\s+service\s+"
        r"delivers\s+reliable\s+access\s+to\s+the\s+latest\s+market\s+"
        r"data,\s+financial\s+news,\s+and\s+economic\s+information\s+"
        r"critical\s+to\s+the\s+investment\s+decision\s+process\..*$"
    )
    for text_node in list(
        soup.find_all(string=professional_service_footer)
    ):
        cleaned = professional_service_footer.sub(
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    publisher_service_suffix = re.compile(
        r"(?is)\s+(?:\*\s*t\s+)?contributed via\s*:\s*"
        r"bloomberg publisher web service\s+provider id\s*:\s*"
        r"[0-9a-f]{32}\s*$"
    )
    for text_node in list(soup.find_all(string=publisher_service_suffix)):
        cleaned = publisher_service_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    # Bloomberg Sports product releases append a promotional link followed
    # by ``About`` profiles and press contacts as sibling blocks. Preserve
    # the preceding product announcement, but discard that standardized tail.
    for marker in list(soup.select("p")):
        if not re.fullmatch(
            r"For more information on Bloomberg Sports,\s*please visit "
            r"\S+ and follow us on Twitter\s*\(@BloombergSports\)\s*"
            r"and Facebook\.",
            _tag_text(marker),
            re.IGNORECASE,
        ):
            continue
        for sibling in list(marker.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        marker.decompose()

    for marker in list(soup.select("h2, h3, h4, p")):
        if not re.fullmatch(
            r"(?i)contacts?\s+for\s+bloomberg\s*:?",
            _tag_text(marker),
        ):
            continue
        tail_start = marker
        previous = marker.find_previous_sibling()
        while isinstance(previous, Tag):
            if (
                previous.name in {"h2", "h3", "h4"}
                and re.fullmatch(
                    r"(?i)about\s+bloomberg",
                    _tag_text(previous),
                )
            ):
                tail_start = previous
                break
            if (
                previous.name == "p"
                and re.match(
                    r"(?i)^about\s+bloomberg\s+bloomberg,\s+"
                    r"the global business and financial information "
                    r"and news leader\b",
                    _tag_text(previous),
                )
            ):
                tail_start = previous
                break
            previous = previous.find_previous_sibling()
        for sibling in list(tail_start.next_siblings):
            if isinstance(sibling, Tag):
                sibling.decompose()
            else:
                sibling.extract()
        tail_start.decompose()

    embedded_recommendation = re.compile(
        r"(?is)\s*read (?:next:\s*\S.+|also:)\s*$"
    )
    for text_node in list(soup.find_all(string=embedded_recommendation)):
        cleaned = embedded_recommendation.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    maritime_tail = re.compile(
        r"(?is)\s*©\s*\d{4}\s+bloomberg\s+l\.p\.\s*"
        r"subscribe\s+for\s+daily\s+maritime\s+insights\b.*$"
    )
    for text_node in list(soup.find_all(string=maritime_tail)):
        cleaned = maritime_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("p, h2, h3, h4")):
        marker_text = (
            _clean_text(marker.get_text(" ", strip=True))
            .casefold()
            .rstrip(":")
        )
        if marker_text not in {
            "related stories",
            "most read from bloomberg",
            "most read from bloomberg businessweek",
            "did you miss?",
            "for more on equity markets",
            "see also",
            "read more",
        }:
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        marker.decompose()

    for marker in list(soup.select("p")):
        text = _clean_text(marker.get_text(" ", strip=True))
        if not re.search(
            r"(?i)more from bloomberg(?: opinion)?:\s*$",
            text,
        ):
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        for text_node in list(
            marker.find_all(
                string=re.compile(
                    r"(?i)more from bloomberg(?: opinion)?:\s*$"
                )
            )
        ):
            cleaned = re.sub(
                r"(?i)\s*more from bloomberg(?: opinion)?:\s*$",
                "",
                str(text_node),
            ).rstrip()
            if cleaned:
                text_node.replace_with(cleaned)
            else:
                text_node.extract()

    for text_node in list(
        soup.find_all(
            string=re.compile(
                r"(?i)for related news and information\s*:\s*$"
            )
        )
    ):
        parent = text_node.parent
        if (
            isinstance(parent, Tag)
            and parent.name == "p"
            and parent.find(
                "meta",
                attrs={
                    "itemprop": "type",
                    "content": "StoryLink",
                },
            )
            is not None
            and parent.find(
                "meta",
                attrs={
                    "itemprop": "type",
                    "content": "FunctionLink",
                },
            )
            is not None
        ):
            parent.decompose()
            continue
        cleaned = re.sub(
            r"(?i)\s*for related news and information\s*:\s*$",
            "",
            str(text_node),
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("h2, h3, h4, h5, h6, p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True)).casefold()
        if marker_text not in {
            "more on this topic",
            "see more on",
            "prev post",
            "source link",
            "top tech stories",
        }:
            continue
        tail = marker
        while isinstance(tail.parent, Tag):
            for sibling in list(tail.next_siblings):
                if isinstance(sibling, Tag):
                    sibling.decompose()
                else:
                    sibling.extract()
            if tail.parent is soup or tail.parent.name in {"article", "main"}:
                break
            tail = tail.parent
        marker.decompose()

    for preformatted in list(soup.select("pre")):
        raw_text = preformatted.get_text("\n", strip=False)
        contact_match = re.search(
            r"(?i)(?:^|\n)\s*(?:--\s*bloomberg news\s*\n\s*)?"
            r"to contact (?:the (?:writers?|authors?|reporters?|editors?)|"
            r"bloomberg news)\b",
            raw_text,
        )
        if contact_match:
            retained = raw_text[: contact_match.start()].rstrip()
            if re.fullmatch(
                r"(?i)\s*(?:--|—|–)\s*"
                r"[^\W\d_][\w .,'’\-]{1,100}\s*",
                retained,
            ):
                retained = ""
            if retained:
                preformatted.clear()
                preformatted.append(retained)
            else:
                preformatted.decompose()

    for table in list(soup.select("table")):
        table_text = _clean_text(table.get_text(" ", strip=True))
        if re.match(
            r"(?i)^(?:read more(?:\s+on the topic)?\s*:?\s+\S|"
            r"take the mliv pulse survey\b)",
            table_text,
        ):
            table.decompose()
    footer_patterns = (
        re.compile(r"(?i)^©\s*\d{4}\s+bloomberg\s+l\.?p\.?$"),
        re.compile(r"(?i)^©\s*\d{4}\s+bloomberg$"),
        re.compile(r"(?i)^(?:--|—|–)\s*bloomberg news\.?$"),
        re.compile(
            r"(?i)^please enable javascript to view the comments "
            r"powered by disqus\.?$"
        ),
        re.compile(
            r"(?i)^tweet\s+more business exchange\s+buzz up!?\s+"
            r"digg\s+print\s+email$"
        ),
        re.compile(
            r"(?i)^(?:#<[^<>]{1,100}>#\s*)?-0-\s+"
            r"[a-z]{3}/\d{1,2}/\d{4}\s+"
            r"\d{2}:\d{2}\s+gmt$"
        ),
        re.compile(r"^#<[\d.]{3,100}>#$"),
        re.compile(
            r"(?i)^for more bloomberg multimedia see\s*"
            r"\{\s*av\s*<go>\s*\}\s*$"
        ),
        re.compile(
            r"(?i)^top stories\s*:\s*top\s+"
            r"top bond stories\s*:\s*top bon\s+"
            r"bloomberg billionaires index\s*:\s*rich\s*$"
        ),
        re.compile(
            r"(?i)^regional news\s*:\s*"
            r"(?:ni\s+[a-z]{2,3}\s+[\w .,'’&()-]+"
            r"(?:\s+|$)){1,12}$"
        ),
        re.compile(
            r"(?i)^(?:market news\s*:\s*)?"
            r"(?:commodity news\s*:\s*)?"
            r"(?:"
            r"(?:ni|cmdy)\s+[a-z0-9]{2,10}\s+[\w .,'’&()/-]+?"
            r")(?:\s+(?:ni|cmdy)\s+[a-z0-9]{2,10}\s+"
            r"[\w .,'’&()/-]+?){1,12}$"
        ),
        re.compile(r"(?i)^related tickers\s*:\s*.+$"),
        re.compile(r"(?i)^author$"),
        re.compile(r"(?i)^and yet equinor still\.*$"),
        re.compile(
            r"(?i)^https?://www\.gata\.org/sites/default/files/"
            r"gata-silver-round-front\.png$"
        ),
        re.compile(
            r"(?i)^get the latest nigerian news delivered to your inbox\.?$"
        ),
        re.compile(
            r"(?i)^food safety news is nonprofit and reader-funded\.\s*"
            r"your tax-free gift ensures ongoing coverage of outbreaks,\s*"
            r"recalls, and regulations for everyone\.?$"
        ),
        re.compile(r"(?i)^your support protects public health$"),
        re.compile(
            r"(?i)^follow .{1,100}(?:'|’)s business section "
            r"on twitter\.?$"
        ),
        re.compile(
            r"(?i)^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
        ),
        re.compile(r"(?i)^\*+\s*with bloomberg\.?$"),
        re.compile(
            r"(?i)^(?:(?:notice an issue\?\s*)?arabian post strives to "
            r"deliver the most accurate and reliable information to its "
            r"readers\.\s*)?if you believe you have identified an error "
            r"or inconsistency in this article\b.*$"
        ),
        re.compile(r"(?i)^follow arabian post$"),
        re.compile(
            r"(?i)^select arabian post as your preferred source on "
            r"google and msn news\b.*$"
        ),
        re.compile(
            r"(?i)^written by:\s*.+\s+—\s+with assistance from .+"
            r"@bloomberg$"
        ),
        re.compile(
            r"(?i)^(?:-{1,2}|—|–)\s*with assistance (?:from|by)\b.+"
            r"(?:\.\s*editors?\s*:.+)?$"
        ),
        re.compile(r"(?i)^with assistance (?:from|by)\b.+\.?$"),
        re.compile(
            r"(?i)^with assistance from\b.+\s+(?:--|—|–)\s*"
            r"editors?\s*:\s*.+$"
        ),
        re.compile(
            r"(?i)^for more articles like this,\s*"
            r"please visit us at bloomberg\.com\.?$"
        ),
        re.compile(
            r"(?i)^visit (?:https?://)?(?:www\.)?bloomberg\.com/"
            r"sustainability/? for the latest from bloomberg news about "
            r"energy,\s*natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^for more about bloomberg bna,\s*click here\s*\.\s*"
            r"visit (?:https?://)?(?:www\.)?bloomberg\.com/"
            r"sustainability/? for the latest from bloomberg news about "
            r"energy,\s*natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^visit the grid for the latest about energy,\s*"
            r"natural resources and global business\.?$"
        ),
        re.compile(
            r"(?i)^read more (?:opinion online|online opinion|online) "
            r"from bloomberg view\s*[:.]?$"
        ),
        re.compile(r"(?i)^read more bloomberg view op-eds\s*\.?$"),
        re.compile(r"(?i)^read more bloomberg view editorials\s*\.?$"),
        re.compile(r"(?i)^today(?:'|’)s highlights\s*:\s*.+$"),
        re.compile(
            r"(?i)^also,\s*the editors on\b.{1,800}"
            r"(?:;\s*.{1,200}){1,12}\.?$"
        ),
        re.compile(
            r"(?i)^read more opinion online from bloomberg view\s*\.\s*"
            r"subscribe to receive a daily e-?mail highlighting new view "
            r"(?:columns,\s*editorials|editorials,\s*columns) "
            r"and op-ed articles\.?$"
        ),
        re.compile(
            r"(?i)^for more quick commentary from bloomberg view,\s*"
            r"go to the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^read more breaking commentary from bloomberg view "
            r"(?:(?:columnists|editors)(?:\s+and\s+(?:columnists|editors))?"
            r"\s+)?at the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^read more breaking commentary from .{2,100} "
            r"and other bloomberg view columnists and editors "
            r"at the ticker\s*\.?$"
        ),
        re.compile(
            r"(?i)^for more,\s*read this quicktake\s*:\s*\S.+$"
        ),
        re.compile(r"(?i)^\*?\s*link to earlier story\s*:\s*\S.+$"),
        re.compile(r"(?i)^\*{3}\s*end of transcript\s*\*{3}$"),
        re.compile(r"(?i)^running time\s*:?\s*\d{1,3}:\d{2}$"),
        re.compile(r"^_{3,}$"),
        re.compile(r"(?i)^provider id\s*:\s*[0-9a-f]{32}$"),
        re.compile(
            r"(?i)^contributed via\s*:\s*"
            r"bloomberg publisher web service$"
        ),
        re.compile(
            r"(?i)^generated by bloomberg publisher web service$"
        ),
        re.compile(
            r"(?i)^.{2,250}\bcontributed to this report\.?$"
        ),
        re.compile(
            r"(?i)^.{2,250}\bcontributed to this story"
            r"(?:\s+from\s+.{2,100})?\.?$"
        ),
        re.compile(
            r"(?i)^to watch the video,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^webrep\s+currentvote\s+norating\s+noweight$"
        ),
        re.compile(
            r"(?i)^(?:--|—|–)\s*[^\W\d_][\w .,'’\-]{1,100}$"
        ),
        re.compile(
            r"(?i)^to see the patent,\s*click\s*:\s*[\d,]+\.?$"
        ),
        re.compile(r"(?i)^to see the patent\s*:\s*[\d,]+\.?$"),
        re.compile(
            r"(?i)^to read the publisher(?:'|’)s web page on the book,\s*"
            r"https?://\S+\.?$"
        ),
        re.compile(
            r"(?i)^(?:to buy this book(?:\s+in\s+"
            r"(?:north america|the u\.?s\.?))?|"
            r"to order(?: this book)?\s+in\s+"
            r"(?:north america|the u\.?s\.?))\s*,\s*"
            r"click here\s*\.?$"
        ),
        re.compile(r"^(?:[•·]\s*){3,}$"),
        re.compile(
            r"(?i)^watch charlie rose on bloomberg tv weeknights\b.*$"
        ),
        re.compile(
            r"(?i)^(?:—|–|--?)\s*with\s+"
            r"[^\W\d_][\w .,'’\-]{1,100}$"
        ),
        re.compile(
            r"(?i)^(?:--|—)\s*[\w .,'’&-]+\s+in\s+"
            r"[\w .,'’&-]+\s+(?:\(\+?\d{1,3}\)|\+?\d)"
            r"[\d -]{6,}$"
        ),
        re.compile(
            r"(?i)^(?:--|—)\s*bloomberg radio\s+\+?\d[\d -]{6,}$"
        ),
        re.compile(
            r"(?i)^siehe dazu auch\s*:\s*fortlaufende kurzmeldungen\s*:\s*"
            r"first\s*<go>\s*first word überschriften\s*:\s*"
            r"nh\s+bfw\s*<go>\s*$"
        ),
        re.compile(
            r"(?i)^überschrift des artikels im original\s*:\s*\S.+$"
        ),
        re.compile(
            r"(?i)^[a-z]{2,5}\s+[a-z0-9]{8,14}\s+<go>\s+\S.+$"
        ),
        re.compile(
            r"(?i)^(?:[a-z]{2,5}\s+)?nsn\s+"
            r"[a-z0-9]{8,14}\s+<go>\s+\S.+$"
        ),
        re.compile(
            r"(?is)^to analyze this 13f\s*:.*<go>.*"
            r"to analyze all 13f(?:'|’)s filed,.*<go>.*$"
        ),
        re.compile(
            r"(?i)^emerging-markets market view\s*:\s*\{emmv\b.*$"
        ),
        re.compile(r"(?is)^相關新聞和信息\s*：.*<go>.*$"),
        re.compile(r"(?is)^相关新闻和信息\s*[：:].*<go>.*$"),
        re.compile(r"(?is)^原文标题\s+\S.+$"),
        re.compile(r"(?is)^관련 기사 및 정보 보기\s*:.*<go>.*$"),
        re.compile(r"(?is)^원본 기사\s*:.*$"),
        re.compile(r"(?is)^--\s*취재보조\s*:.*$"),
        re.compile(r"(?is)^본 기사의 번역자\s*:.*$"),
        re.compile(
            r"(?is)^.*\bnsn\s+[a-z0-9]{8,14}\s*<go>\s*$"
        ),
        re.compile(
            r"(?i)^(?:today(?:'|’)s\s+)?muse highlights include "
            r".{2,180}\.?$"
        ),
        re.compile(
            r"(?i)^(?:today(?:'|’)s\s+)?muse highlights include\s*:\s*"
            r".{2,180}\.?$"
        ),
        re.compile(
            r"(?i)^\(?to save a copy of the chart,\s*click here\.\)?$"
        ),
        re.compile(r"(?i)^click here for (?:the )?web link\.?$"),
        re.compile(r"(?i)^for related news and information\s*:?.*$"),
        re.compile(r"(?is)^related news and information\s*:.*$"),
        re.compile(r"(?i)^for more on .{2,160},\s*click here\.?$"),
        re.compile(
            r"(?i)^for the latest verdict and settlement news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest new suits news,\s*click here\.\s*"
            r"for copies of recent civil complaints,\s*click here\."
            r"(?:\s*for the latest lawsuits news,\s*click here\.)?$"
        ),
        re.compile(
            r"(?i)^for the latest litigation department news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest lawsuits news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^for the latest trial and appeals news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^this is a bloomberg podcast\.\s*to download,\s*"
            r"watch or listen (?:to this report )?now,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^\(?to listen to the podcast,\s*click here\s*\.?\)?$"
        ),
        re.compile(r"(?i)^for more,\s*read this next\s*:\s*$"),
        re.compile(r"(?i)^for more,\s*read this next\s*:\s*\S.+$"),
        re.compile(
            r"(?i)^for more,\s*click here"
            r"(?:(?:,\s*)?\s+and\s+(?:click\s+)?here)?\s*\.?$"
        ),
        re.compile(
            r"(?i)^for the video,\s*click here,\s*and for more,\s*"
            r"click here\.?$"
        ),
        re.compile(r"(?i)^for the video,\s*click here\.?$"),
        re.compile(r"(?i)^for the audio,\s*click here\.?$"),
        re.compile(
            r"(?i)^to read more from .{2,180},\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read more of this story,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read the story,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^to read bloomberg coverage,\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^for a slideshow\b.{1,220},\s*click here\s*\.?$"
        ),
        re.compile(
            r"(?i)^for more .{2,100} news from last week,\s*"
            r"click here(?:\.\s*for copies of recent civil complaints,\s*"
            r"click here)?\.?$"
        ),
        re.compile(r"(?i)^read more echoes columns online\s*\.?$"),
        re.compile(r"(?i)^read more from echoes online\s*\.?$"),
        re.compile(r"(?i)^read more bloomberg view columns\s*\.?$"),
        re.compile(r"(?i)^read more in our full story\s*\.?$"),
        re.compile(
            r"(?i)^read more(?:\s+from)?\s+echoes\s*,?\s*"
            r"bloomberg view(?:'|’)s economic history blog\s*\.?$"
        ),
        re.compile(
            r"(?i)^for (?:more )?(?:copyright|patent|trademark) news,\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}"
            r"(?:\s*\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\})*\s*$"
        ),
        re.compile(
            r"(?i)^(?:link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}\s*){2,}$"
        ),
        re.compile(
            r"(?i)^link to statement\s*:\s*\{\s*https?://[^{}\s]+\s*\}\s*"
            r"link to company news\s*:\s*"
            r"\{[^{}]{1,80}<equity>\s+cn(?:\s+<go>)?\}\s*$"
        ),
        re.compile(
            r"(?i)^link to statement\s*:\s*"
            r"\{\s*nsn\s+[a-z0-9]{8,14}\s+<go>\s*\}\s*$"
        ),
        re.compile(r"(?i)^link to statement\s*:\s*link\s*$"),
        re.compile(
            r"(?i)^hedge[- ]fund rankings\s*:\s*\{\s*hfnd"
            r"(?:\s*<go>)?\s*\}?\s*$"
        ),
        re.compile(
            r"(?i)^story link\s*:\s*"
            r"\{\s*nsn\s+[a-z0-9]{8,14}\s*<go>\s*\}\s*$"
        ),
        re.compile(
            r"(?i)^bi airm\s*<go>\s+for commercial aircraft "
            r"manufacturers(?:'|’) dashboard\s+bi airl eu\s*<go>\s+"
            r"european airline dashboard\s+bi airmg indd\s*<go>\s+"
            r"monthly orders for new aircraft,\s*parked fleet "
            r"statistics\.?$"
        ),
        re.compile(
            r"(?i)^\(to be sent this nordic credit column,\s*click here\.\s*"
            r"for more credit market news,\s*top cm\.\)$"
        ),
        re.compile(
            r"(?i)^to see the methodology and exact wording of the poll "
            r"questions,\s*click on the attachment tab at the top of "
            r"the story\.?$"
        ),
        re.compile(
            r"(?i)^.{2,100}\bis (?:the )?.{2,100} for bloomberg\.\s*"
            r"follow (?:him|her|them) on twitter\b.*$"
        ),
        re.compile(
            r"(?i)^.{2,100}\bis (?:the )?(?:co-)?author of "
            r".{2,300}\.\s+(?:he|she|they) (?:advises?|writes?|works?)\b"
            r".{2,300}\.\s*follow (?:him|her|them) on twitter\b.*$"
        ),
        re.compile(r"(?i)^(?:\*t\s*)+$"),
        re.compile(
            r"(?i)^to contact the "
            r"(?:authors? of|editors? responsible for|reporters? on) "
            r"this (?:story|article)\s*:"
        ),
        re.compile(
            r"(?i)^to contact the (?:lead )?author of this column\s*:"
        ),
        re.compile(
            r"(?i)^to contact (?:the )?bloomberg news staff for this "
            r"(?:story|article)\s*:"
        ),
        re.compile(
            r"(?i)^to contact the "
            r"(?:writers?|authors?|reporters?|editors?) "
            r"(?:for|of|on|responsible for) (?:this|the|his|her) "
            r"(?:story|article|column|review|slideshow|(?:blog )?post)\s*:?"
        ),
        re.compile(
            r"(?i)^to see a slideshow of photos\b.*"
            r"\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}\.?$"
        ),
        re.compile(
            r"(?i)^click on [“\"]send comment[”\"] in (?:the )?sidebar display "
            r"to send a letter to the editor\.?$"
        ),
        re.compile(
            r"(?i)^click on\s*\{\s*lett\s*<go>\s*\}\s*"
            r"to send a letter to the editor\.?$"
        ),
        re.compile(
            r"(?i)^(?:(?:-{1,2}|—|–)\s*)?"
            r"editors?\s*:\s*[\w .,'’&-]+$"
        ),
        re.compile(r"(?i)^editors?\s*:\s*$"),
        re.compile(
            r"(?i)^(?:-{1,2}|—|–)\s*[\w .,'’&-]+\.\s*"
            r"editors?\s*:\s*[\w .,'’&-]+$"
        ),
        re.compile(r"(?i)^[a-z0-9._%+-]+@bloomberg\.net\s*[.;]?$"),
        re.compile(
            r"(?i)^join the discussion on the bloomberg businessweek "
            r"business school forum\b"
        ),
        re.compile(
            r"(?i)^©\s*\d{4}\s+trend news agency\.?\s*"
            r"all rights reserved\.?$"
        ),
        re.compile(
            r"(?i)^to contact the (?:senior )?editor responsible for "
            r"bloomberg view(?:'s|’s) editorials\s*:"
        ),
        re.compile(
            r"(?i)^to contact the (?:senior )?editor responsible for "
            r"bloomberg opinion(?:'s|’s) editorials\s*:"
        ),
        re.compile(
            r"(?i)^this (?:column|article) does not necessarily reflect "
            r"the opinion of (?:the editorial board or )?"
            r"bloomberg lp and its owners\.?$"
        ),
        re.compile(
            r"(?i)^\(?this (?:column|article) does not necessarily reflect "
            r"the opinion of (?:the editorial board or )?"
            r"bloomberg lp and its owners\.\)?$"
        ),
        re.compile(
            r"(?i)^\(?this (?:column|article) does not necessarily reflect "
            r"the opinion of bloomberg (?:view|opinion)(?:'|’)s "
            r"editorial board or bloomberg lp,\s*its owners and investors"
            r"\.\)?$"
        ),
        re.compile(
            r"(?is)^this transcript may not be 100% accurate\b.*"
            r"any opinion expressed in the transcript does not necessarily "
            r"reflect the views of bloomberg lp\.?$"
        ),
        re.compile(
            r"(?i)^follow @\w+ for all the latest news, and sign up (?:for|to) "
            r"our daily .+ newsletter\.?$"
        ),
        re.compile(
            r"(?i)^follow @\w+ on twitter for more(?: on)? .{2,160}\.?$"
        ),
        re.compile(r"(?i)^\*\s*bloomberg\.?$"),
        re.compile(
            r"(?i)^subscribe to .+ on "
            r"(?:itunes|apple) podcasts(?:\s+subscribe to .+ on "
            r"pocket casts)?\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to .+ on pocket casts\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to .+ on pocketcasts?\.?$"
        ),
        re.compile(
            r"(?i)^terminal users\s*:\s*click here to play now\.?$"
        ),
        re.compile(
            r"(?i)^if you(?:'|’)d like to get the daily prophet in "
            r"e-?mail form, right in your inbox, please subscribe "
            r"to this link\s*\.\s*thanks!?"
        ),
        re.compile(
            r"(?i)^start your day with what(?:'|’)s moving markets in asia\. "
            r"sign up here to receive our newsletter\.?$"
        ),
        re.compile(
            r"(?i)^sign up for (?:our new china newsletter|china rising)\s*,"
            r"\s*a (?:new )?weekly dispatch(?:\s+coming soon)? on where china "
            r"stands now and where it(?:'|’)s going next\.?$"
        ),
        re.compile(
            r"(?i)^sign up to receive the brexit bulletin in your inbox, "
            r"and follow @brexit on twitter\.?$"
        ),
        re.compile(
            r"(?i)^sign up to receive the brexit bulletin, a daily briefing "
            r"on the biggest news related to britain(?:'|’)s departure "
            r"from the eu\.?$"
        ),
        re.compile(
            r"(?i)^a version of this column originally appeared in "
            r"bloomberg(?:'|’)s fully charged technology newsletter\. "
            r"you can sign up here\s*\.?$"
        ),
        re.compile(
            r"(?i)^want to hear more\? subscribe on apple podcasts and "
            r"pocket casts for new episodes every week\."
        ),
        re.compile(
            r"(?i)^\(?\s*sign up for the .+ newsletter, your best source "
            r"for .+\)?\.?$"
        ),
        re.compile(
            r"(?i)^want to go deeper inside .+\? sign up for .+ newsletter "
            r"from bloomberg\.?$"
        ),
        re.compile(
            r"(?i)^for a fresh perspective on .+, sign up for our weekly "
            r"newsletter\s*\.?$"
        ),
        re.compile(
            r"(?i)^want\s+more\s+personal\s+finance\s+news\?\s*"
            r"sign\s+up\s+for\s+our\s+weekly\s+personal\s+finance\s+"
            r"newsletter,\s*wealth\s+watch\.?\s*$"
        ),
        re.compile(
            r"(?i)^new to bloomberg opinion today\?\s*"
            r"(?:sign up\s+)?and follow us on twitter and facebook\s*\.?$"
        ),
        re.compile(
            r"(?i)^(?:sign up here\s+)?and follow us on twitter "
            r"and facebook\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for bloomberg(?:'|’)s daily technology "
            r"newsletter here\s*\.?$"
        ),
        re.compile(
            r"(?i)^subscribe now to stay ahead with the most trusted "
            r"business news source\.?$"
        ),
        re.compile(
            r"(?i)^(?:follow ht tech on\s+)?facebook\s*,\s*google news\s*,"
            r"\s*and instagram\s*\.\s*for our latest videos,\s*"
            r"subscribe to our youtube channel\s*\.?$"
        ),
        re.compile(
            r"(?i)^catch all the latest tech news\s*,\s*mobile news\s*,"
            r".*for our latest videos,\s*subscribe to our youtube "
            r"channel\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for our .+ weekly newsletter, follow us @\w+ "
            r"and subscribe to our podcast\.?$"
        ),
        re.compile(
            r"(?i)^for the best in travel, food, drinks, fashion, cars, "
            r"and life, sign up for the pursuits newsletter\s*\.\s*"
            r"delivered weekly\.?$"
        ),
        re.compile(
            r"(?i)^want to receive this post, and more, into your inbox "
            r"every morning\?\s*sign up here\.?$"
        ),
        re.compile(
            r"(?i)^for more (?:copyright|patent) news,\s*click here\.?$"
        ),
        re.compile(
            r"(?i)^for related stories\s+to see today(?:'|’)s top "
            r"sports stories,\s*see:\s*\{ispo\s*<go>\}\.?$"
        ),
        re.compile(
            r"(?i)^all the .{2,80}\b(?:news|results)"
            r"(?:\s+and\s+(?:news|results))?\s+can be found at\s+"
            r"[a-z]{2,8}\s*<go>\s*\.?$"
        ),
        re.compile(
            r"(?is)^related news and information:\s*"
            r".*\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}.*$"
        ),
        re.compile(
            r"(?is)^stories related to the ecb\s*:\s*"
            r".*\{[^{}]{1,30}<go>\}.*\{[^{}]{1,30}<go>\}.*$"
        ),
        re.compile(
            r"(?i)^to view the source of this information click here\.?$"
        ),
        re.compile(r"(?i)^read more\s*:\s*\S.+$"),
        re.compile(
            r"(?i)^get early returns every morning in your inbox\.\s*"
            r"click here to subscribe\.\s*also subscribe to bloomberg "
            r"all access\b.*$"
        ),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*terminal readers "
            r"head to opin\s*<go>\.\s*web readers click here\.?$"
        ),
        re.compile(
            r"(?i)^for more bloomberg opinion,\s*subscribe to our "
            r"newsletter\.?$"
        ),
        re.compile(r"(?i)^for more bloomberg view columns\.?$"),
        re.compile(
            r"(?i)^read more bloomberg sustainability news and "
            r"follow us on twitter\s*\.?$"
        ),
        re.compile(
            r"(?i)^sign up for the brief,\s*a daily afternoon newsletter "
            r"showcasing bloomberg law(?:'s|’s) top stories\.?$"
        ),
        re.compile(
            r"(?i)^sign up for bloomberg(?:'s|’s) business of sports "
            r"newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the equality newsletter for weekly "
            r"reporting\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the washington edition newsletter to "
            r"find out how the worlds? of money and politics intersect "
            r"in the us capital\.?$"
        ),
        re.compile(
            r"(?i)^sign up for the twice-weekly next africa newsletter "
            r"for the latest business and economic news from the "
            r"continent\.?$"
        ),
        re.compile(
            r"(?i)^sign up here for the twice-weekly next africa "
            r"newsletter,\s*and subscribe to the next africa podcast\b.*$"
        ),
        re.compile(
            r"(?i)^or want more lifestyle and passion stories\?\s*"
            r"click here\.?$"
        ),
        re.compile(
            r"(?i)^generated by readers,\s*the comments included herein "
            r"do not reflect the views and opinions of rigzone\.\s*"
            r"all comments are subject to editorial review\..*$"
        ),
        re.compile(
            r"(?i)^(?:\(bloomberg\)\s*(?:--|—)\s*)?sign up for "
            r"(?:the\s+)?(?:daily\s+)?india "
            r"edition newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the business of food newsletter\b.*$"
        ),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*opin\s*<go>\.\s*"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more (?:from )?bloomberg opinion\?\s*"
            r"opin\s*<go>(?:\s*on the terminal)?\.\s*"
            r"(?:web readers,?\s*click here\.\s*)?"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more bloomberg opinion\?\s*terminal readers "
            r"head to opin\s*<go>\.\s*or (?:you can )?subscribe to our "
            r"daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^[\u200b-\u200f\u2060\ufeff]*"
            r"want more bloomberg opinion\?\s*head to opin\s*<go>\.\s*"
            r"or (?:you can )?subscribe to our daily newsletter\.?$"
        ),
        re.compile(
            r"(?i)^more stories like this are available on "
            r"bloomberg\.com\.?$"
        ),
        re.compile(
            r"(?i)^sign up here and follow us on threads,\s*tiktok,\s*"
            r"twitter,\s*instagram and facebook\.?$"
        ),
        re.compile(
            r"(?i)^subscribe to the economic times prime and read the "
            r"et epaper online\.?$"
        ),
        re.compile(
            r"(?i)^\(?catch all the business news\s*,\s*breaking news "
            r"and latest news updates on the economic times\s*\.\)?$"
        ),
        re.compile(r"(?i)^more on bloomberg:?$"),
        re.compile(r"(?i)^read more\s*@\s*bloomberg\.?$"),
        re.compile(
            r"(?i)^you want more news on this market\?\s*click here for "
            r"a curated first word channel\b.*$"
        ),
        re.compile(
            r"(?i)^take the mliv pulse survey\b.*share your thoughts\.?$"
        ),
        re.compile(r"(?i)^continue for free$"),
        re.compile(r"(?i)^you can follow lev menand at @levmenand\.?$"),
        re.compile(
            r"(?i)^follow the market issue situation with our daily "
            r"updates\.?$"
        ),
        re.compile(r"(?i)^what do you think\?$"),
        re.compile(
            r"(?i)^get in-depth insights from our expert contributors,\s*"
            r"and dive into financial and economic trends\.?$"
        ),
        re.compile(
            r"(?i)^new us stocks insights\s*&\s*wraps\b.*"
            r"click here to see and subscribe\.?$"
        ),
        re.compile(
            r"(?i)^read more stories about where the money flows,\s*"
            r"and analysis of the biggest market stories from singapore "
            r"and around the world\.?$"
        ),
        re.compile(
            r"(?i)^click here to stay updated with the latest business "
            r"& investment news in singapore\.?$"
        ),
        re.compile(r"(?i)^source:\s*https?://(?:www\.)?bloomberg\.com/?$"),
        re.compile(r"(?i)^source\s*:\s*bloomberg\.?$"),
        re.compile(r"(?i)^read:\s+.{10,200}$"),
        re.compile(r"(?i)^to view or add a comment,\s*sign in\.?$"),
        re.compile(r"(?i)^thank you for your report!?$"),
        re.compile(
            r"(?i)^please enable javascript to view this content\.?$"
        ),
        re.compile(r"(?i)^uploaded by .{2,100}$"),
        re.compile(r"(?i)^top trending stocks\s*:.*share price\b.*$"),
        re.compile(r"(?i)^get automatic alerts for this topic\.?$"),
        re.compile(r"(?i)^about this source$"),
        re.compile(
            r"(?i)^⚠?\ufe0f?\s*disclaimer:\s*this content is for training "
            r"purposes only\b.*$"
        ),
        re.compile(
            r"(?i)^this article was generated from an automated news "
            r"agency feed without modifications to text\.?$"
        ),
        re.compile(r"(?i)^share this\s*:$"),
        re.compile(r"(?i)^📰\s*source$"),
        re.compile(
            r"(?i)^for complete coverage and additional details,\s*"
            r"visit the original article published by bloomberg\.com\.?$"
        ),
        re.compile(r"(?i)^bloomberg\.com$"),
        re.compile(
            r"(?i)^subscribe to et prime and read the economic times "
            r"epaper online\..*$"
        ),
        re.compile(
            r"(?is)^\(?what(?:'|’)s moving sensex and nifty\b.*"
            r"subscribe to our telegram feeds\s*\.\)?$"
        ),
        re.compile(r"(?i)^read the full article$"),
        re.compile(
            r"(?i)^get the latest insurance news sent straight to "
            r"your inbox\.?$"
        ),
        re.compile(r"(?i)^maritime and shipping$"),
        re.compile(r"(?i)^discussion$"),
        re.compile(
            r"(?i)^the post .+ first appeared on bloomberg\.?$"
        ),
        re.compile(
            r"(?i)^©\s*\d{4}\s+the block\.\s*all rights reserved\..*$"
        ),
        re.compile(
            r"(?i)^unlock full access to podcast analytics,\s*"
            r"audience demographics\b.*$"
        ),
        re.compile(
            r"(?i)^recipients will be able to read the full text of "
            r"the article after submitting their email address\b.*$"
        ),
        re.compile(r"(?i)^原文標題\s*.+$"),
        re.compile(r"(?i)^interested in profit loss\s*\?$"),
        re.compile(r"(?i)^interested in claims\s*\?$"),
        re.compile(r"(?i)^listen to this article in summarized format$"),
        re.compile(r"(?i)^most popular$"),
        re.compile(r"(?i)^want to stay up to date\?$"),
        re.compile(r"(?i)^get more podcast analytics$"),
        re.compile(
            r"(?i)^ai-analyzed african market trends delivered to "
            r"your inbox\b.*$"
        ),
        re.compile(r"(?i)^the source\s*:\s*bloomberg$"),
        re.compile(
            r"(?i)^get push alerts the moment our analysts spot setups "
            r"around news events\b.*$"
        ),
        re.compile(
            r"(?i)^sign up here for the daily next africa newsletter "
            r"and subscribe to the next africa podcast\b.*$"
        ),
        re.compile(r"(?i)^advertisement\s*:\s*$"),
        re.compile(r"(?i)^here are more articles you may enjoy\.?$"),
        re.compile(r"(?i)^trade these moves with signalpro$"),
        re.compile(
            r"(?i)^related coverage:\s*.+"
        ),
        re.compile(
            r"(?i)^each image keeps its publisher,\s*caption or article "
            r"title,\s*citation text\b.*$"
        ),
        re.compile(r"(?i)^was this article valuable\?$"),
        re.compile(
            r"(?i)^estimates show your actual share of cashback\b.*"
            r"see full vip trader hub\s*→?$"
        ),
        re.compile(r"(?i)^interested in ai\s*\?$"),
        re.compile(
            r"(?i)^want more bloomberg opinion\?\s*terminal readers,?\s*"
            r"head\s*to\s*opin\s*<go>\.\s*or subscribe to our daily "
            r"newsletter\.?$"
        ),
        re.compile(
            r"(?i)^move the slider to your real monthly trading volume\b.*$"
        ),
        re.compile(
            r"(?i)^disclaimer:\s*the block is an independent media "
            r"outlet that delivers news,\s*research,\s*and data\b.*$"
        ),
        re.compile(
            r"(?i)^previous article\s+next article\b.*$"
        ),
        re.compile(r"(?i)^buy gold$"),
        re.compile(r"(?i)^trending now$"),
        re.compile(
            r"(?i)^build draft survey skills through practical training\b.*$"
        ),
        re.compile(
            r"(?i)^written (?:by|by:)\s+.{2,100}(?:@bloomberg)?$"
        ),
        re.compile(r"(?i)^how much could you earn back per year\?$"),
        re.compile(r"(?i)^related articles$"),
        re.compile(r"(?i)^topics\s+lawsuits\s+claims\s+oklahoma$"),
        re.compile(
            r"(?i)^for complete coverage and additional details,\s*"
            r"visit the original article published by bloomberg"
            r"(?:\.com)?\.?$"
        ),
        re.compile(r"(?i)^cashback calculator$"),
        re.compile(r"(?i)^advanced draft survey$"),
        re.compile(r"(?i)^printer friendly version$"),
        re.compile(
            r"(?i)^trading involves risk of loss\.\s*cashback rates "
            r"are estimates\b.*$"
        ),
        re.compile(r"(?i)^african reviewer\s+view all posts$"),
        re.compile(r"(?i)^s&p 500 top losers$"),
        re.compile(
            r"(?is)^share on facebook \(opens in new window\).*"
            r"share on x \(opens in new window\)\s*x$"
        ),
        re.compile(
            r"(?is)^exclusive stories\s+daily epaper access\s+"
            r"smart market tools\s+curated investment ideas\s+"
            r"ad-lite experience\s+subscription$"
        ),
        re.compile(
            r"(?is)^want to share this article\?\s*upgrade to "
            r"all-access now\b.*$"
        ),
        re.compile(
            r"(?i)^bluesky\s+x\s+threads\s+facebook\s+email$"
        ),
        re.compile(r"(?i)^advertisement\s*\d*$"),
        re.compile(
            r"(?i)^this commercial has not loaded but,?\s*however your "
            r"article continues under\.?$"
        ),
        re.compile(r"(?i)^sign in or create an account$"),
        re.compile(r"^(?:_{5,}|-{5,}|={5,})$"),
        re.compile(
            r"(?i)^.{1,100}\sis\s.{1,100}\sat bloomberg\.\s*"
            r"follow (?:him|her|them) on twitter\b.*"
            r"(?:instagram|facebook)\b.*$"
        ),
    )
    grid_promo = re.compile(
        r"(?i)^visit the grid for the latest about energy,\s*"
        r"natural resources and global business\.?$"
    )
    more_by_author = re.compile(
        r"(?i)^more by .{2,120}(?:\bon twitter\b.*)?:$"
    )
    for marker in list(soup.select("p")):
        if not more_by_author.fullmatch(
            _clean_text(marker.get_text(" ", strip=True))
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("h2, h3, h4, p")):
        if not re.fullmatch(
            r"(?i)(?:(?:for more,\s*)?read this next\s*:?|"
            r"for .{2,180},\s*read this next\s*:?|"
            r"for more on .{2,160},\s*check out .{2,80}\s*:|"
            r"related\s*:?)",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("p, h2, h3, h4")):
        if not re.fullmatch(
            r"(?i)more from .{2,120}\s*:",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        related = marker.find_next_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
            marker.decompose()

    for marker in list(soup.select("p")):
        if (
            _clean_text(marker.get_text(" ", strip=True)).casefold()
            != "daily podcast"
        ):
            continue
        title = marker.find_next_sibling()
        description = (
            title.find_next_sibling()
            if isinstance(title, Tag) and title.name == "p"
            else None
        )
        if not (
            isinstance(description, Tag)
            and description.name == "p"
            and re.search(
                r"(?is)\bpodcast on the bloomberg terminal\b.*"
                r"\bto listen,\s*click here\.?$",
                _clean_text(description.get_text(" ", strip=True)),
            )
        ):
            continue
        description.decompose()
        title.decompose()
        marker.decompose()

    for module in list(soup.select("div.story_inline.assets")):
        if module.select_one("div.author") and module.select_one("div.related"):
            module.decompose()

    for promo in list(soup.select("p")):
        if not grid_promo.fullmatch(
            _clean_text(promo.get_text(" ", strip=True))
        ):
            continue
        related = promo.find_previous_sibling()
        if isinstance(related, Tag) and related.name in {"ul", "ol"}:
            related.decompose()
        promo.decompose()

    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on twitter"
            r"(?:\s+at)?(?:\s+@\w+)?\s*\.?\s*\)$",
            ")",
            text,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on tumblr at\s+"
            r"(?:https?://)?(?:www\.)?[\w.-]+\.[a-z]{2,}"
            r"(?:/[^\s)]*)?(?:\s+or\s+(?:https?://)?"
            r"(?:www\.)?[\w.-]+\.[a-z]{2,}(?:/[^\s)]*)?)?"
            r"\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+e-?mail (?:him|her|them) and\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for more dine\s*&\s*deal reviews,\s*"
            r"click here\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+(?:to buy this book(?:\s+in\s+"
            r"(?:north america|the u\.?s\.?))?|"
            r"to order(?: this book)?\s+in\s+"
            r"(?:north america|the u\.?s\.?))\s*,\s*"
            r"click here\s*\.?\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*go to\s+[a-z]{2,8}\s*<go>\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to be sent this column daily,\s*click\s+"
            r"[a-z]{2,8}(?:\s+[a-z]{2,8})?\s*<go>\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+find this column daily at\s+"
            r"[a-z]{2,8}(?:\s+[a-z]{2,8})?\s*<go>\s*\.?\s*\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click here for (?:the )?playoff schedule\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click here for other college football "
            r"game schedules\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for details,\s*click here\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for full details on greece(?:'|’)s funding "
            r"commitments,\s*click here\.\s*"
            r"see ext4 for more on the european debt crisis\.\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to read bloomberg coverage,\s*click here\s*\.?$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s*\*?\s*link to earlier story\s*:\s*.*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s*\{[a-z]{2,8}\s+\d{5,12}\s+<go>\}\s*$",
            "",
            trimmed,
        )
        if (
            re.match(r"(?i)^stories related to the ecb\s*:", trimmed)
            and len(
                re.findall(
                    r"(?i)\{[a-z][a-z0-9 ]{1,30}<go>\}",
                    trimmed,
                )
            )
            >= 2
        ):
            trimmed = ""
        trimmed = re.sub(
            r"(?i)\s*\{\s*osch\s*<go>\s*\}\s*",
            " ",
            trimmed,
        )
        trimmed = re.sub(r"(?i)\s+-bloomberg\s*$", "", trimmed)
        trimmed = re.sub(
            r"(?i),\s*accessible on live\s*<go>\s*\.\)$",
            ".)",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+see\s+\{?\s*live\s*<go>\s*\}?\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+can be accessed at\s+\{?\s*live\s*<go>\s*\}?"
            r"\s*\.\s*",
            ". ",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*click on\s+\{?\s*live\s*<go>\s*\}?"
            r"\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+to listen,\s*visit\s+"
            r"[a-z0-9.]{1,16}\s+(?:us\s+)?<equity>\s+"
            r"evt\s*<go>\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+for more bloomberg view,\s*"
            r"click on view\s*<go>\s*\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+\*?\s*for change in stock futures oi,\s*"
            r"see fmon\s*<go>\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+(?:\*\s*t\s+)?contributed via\s*:\s*"
            r"bloomberg publisher web service\s+provider id\s*:\s*"
            r"[0-9a-f]{32}\s*$",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+click\s+[a-z]{1,8}(?:\s+[a-z]{1,8})?\s*"
            r"<equity>\s+evts\s*<go>\s+to listen\.\)$",
            ")",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^([^.]{1,180}\.)\s+follow (?:him|her|them) on twitter"
            r"(?:\s+at)?\s+@\w+\s*\.?$",
            r"\1",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^(.{2,240}\.)\s+follow (?:him|her|them) on twitter"
            r"\s*\.\s*this post originally appeared here\s*\.?$",
            r"\1",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on twitter"
            r"(?:(?:\s+at)?\s+@\w+)?\s*\.\s+"
            r"(?=(?:the )?opinions? expressed\b)",
            " ",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)\s+follow (?:him|her|them) on instagram"
            r"(?:\s+at)?\s*:?\s*@\w+\s*\.?",
            "",
            trimmed,
        )
        trimmed = re.sub(
            r"(?i)^read more echoes online\s*\.\s*(?=\()",
            "",
            trimmed,
        )
        if trimmed != text:
            paragraph.clear()
            paragraph.append(trimmed)

    for paragraph in list(soup.select("p")):
        paragraph_text = _clean_text(paragraph.get_text(" ", strip=True))
        assistance_bio = re.fullmatch(
            r"(?is)^\(\s*with assistance (?:from|by)\b.+?\.\s+"
            r"(.+\b(?:bloomberg|muse)\b.+)\)$",
            paragraph_text,
        )
        if assistance_bio is not None:
            paragraph.clear()
            paragraph.append(f"({assistance_bio.group(1)})")

    for paragraph in list(soup.select("p")):
        paragraph_text = _clean_text(paragraph.get_text(" ", strip=True))
        assistance = re.search(
            r"\s+With assistance from\b.{2,300}\.?\s*$",
            paragraph_text,
        )
        if assistance is None:
            continue
        retained = paragraph_text[: assistance.start()].rstrip()
        if not retained.endswith((".", "!", "?")):
            continue
        for text_node in list(paragraph.find_all(string=True)):
            match = re.search(
                r"\s+With assistance from\b.{2,300}\.?\s*$",
                str(text_node),
            )
            if match is not None:
                text_node.replace_with(str(text_node)[: match.start()])
                break

    for marker in list(soup.select("p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "source":
            continue
        source_link = marker.find_next_sibling()
        if not isinstance(source_link, Tag) or source_link.name != "p":
            continue
        source_text = _clean_text(source_link.get_text(" ", strip=True))
        if not re.fullmatch(
            r"(?i)https?://(?:www\.)?"
            r"(?:bloomberg\.com|businessweek\.com)/\S+",
            source_text,
        ):
            continue
        source_link.decompose()
        marker.decompose()

    for marker in list(soup.select("p")):
        if (
            _clean_text(marker.get_text(" ", strip=True)).casefold()
            != "note to editors"
        ):
            continue
        if not any(
            isinstance(sibling, Tag)
            and sibling.name == "p"
            and re.fullmatch(
                r"(?i)for further information please contact\s*:?",
                _clean_text(sibling.get_text(" ", strip=True)),
            )
            for sibling in marker.next_siblings
        ):
            continue
        for sibling in list(marker.next_siblings):
            sibling.extract()
        marker.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() != "statistics":
            continue
        previous = heading.find_previous_sibling()
        if isinstance(previous, Tag) and previous.name in {"pre", "table"}:
            heading.decompose()
            continue
        if any(
            isinstance(sibling, Tag)
            and sibling.name in {"p", "pre", "table", "figure", "img"}
            and _clean_text(sibling.get_text(" ", strip=True))
            for sibling in heading.next_siblings
        ):
            continue
        heading.decompose()

    for marker in list(soup.select("p, h2, h3, h4")):
        if not re.fullmatch(
            r"(?i)more stories (?:by|from) .{2,160}:?",
            _clean_text(marker.get_text(" ", strip=True)),
        ):
            continue
        sibling = marker.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
            marker.decompose()

    contact_footer = re.compile(
        r"(?i)^to contact (?:the )?"
        r"(?:reporters?|writers?|authors?|editors?|bloomberg news staff)\b"
    )
    # A small number of legacy Bloomberg terminal pages contain a stray
    # one-letter paragraph immediately before the reporter contact footer.
    # Scope the repair to that exact boundary so legitimate short paragraphs
    # elsewhere in an article remain untouched.
    for contact in list(soup.select("p")):
        if not contact_footer.match(
            _clean_text(contact.get_text(" ", strip=True))
        ):
            continue
        previous = contact.find_previous_sibling()
        if (
            isinstance(previous, Tag)
            and previous.name == "p"
            and re.fullmatch(
                r"[A-Za-z]",
                _clean_text(previous.get_text(" ", strip=True)),
            )
        ):
            previous.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag) and sibling.name in {"h2", "h3", "h4"}:
            sibling = sibling.find_next_sibling()
        if (
            isinstance(sibling, Tag)
            and sibling.name == "p"
            and contact_footer.match(
                _clean_text(sibling.get_text(" ", strip=True))
            )
        ):
            heading.decompose()

    for node in list(
        soup.select("p, li, span, em, div, h2, h3, h4, blockquote")
    ):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            text.casefold() == "watch this next"
            or any(pattern.search(text) for pattern in footer_patterns)
            or (
                node.name in {"p", "li", "span"}
                and "@bloomberg.net" in text.casefold()
                and len(text) <= 400
            )
            or re.fullmatch(r"[\u200b-\u200f\u2060\ufeff]+", text)
            or re.fullmatch(r"(?:\*\s*){2,}", text)
            or (
                node.name in {"h2", "h3", "h4"}
                and re.fullmatch(
                    r"[\s‘’“”'\"….,:;!?—–-]+",
                    text,
                )
            )
            or text == "🫣"
        ):
            node.decompose()

    for paragraph in list(soup.select("p")):
        links = paragraph.find_all("a")
        if len(links) != 1:
            continue
        link = links[0]
        text = _clean_text(paragraph.get_text(" ", strip=True))
        link_text = _clean_text(link.get_text(" ", strip=True))
        href = str(link.get("href") or "")
        if (
            text == link_text
            and link_text
            and paragraph.find_next_sibling("p") is None
            and re.search(
                r"(?i)(?:bloomberg\.com)?/news/articles/\d{4}-\d{2}-\d{2}/",
                href,
            )
        ):
            paragraph.decompose()

    for link in list(soup.select("a")):
        text = _clean_text(link.get_text(" ", strip=True)).casefold()
        href = str(link.get("href") or "").casefold()
        if (
            text == "sign up here"
            and "bloombergbusiness.com/join/" in href
        ):
            link.decompose()

    for listing in list(soup.select("ul")):
        items = listing.find_all("li", recursive=False)
        if len(items) < 2:
            continue
        if all(
            item.find(
                "a",
                attrs={"title": re.compile(r"(?i)^click to view webpage\.?$")},
            )
            is not None
            for item in items
        ):
            listing.decompose()

    personal_finance_newsletter_suffix = re.compile(
        r"(?i)\s*want\s+more\s+personal\s+finance\s+news\?\s*"
        r"sign\s+up\s+for\s+our\s+weekly\s+personal\s+finance\s+"
        r"newsletter,\s*wealth\s+watch\.?\s*$"
    )
    for text_node in list(
        soup.find_all(string=personal_finance_newsletter_suffix)
    ):
        cleaned = personal_finance_newsletter_suffix.sub(
            "", str(text_node)
        ).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    view_promo_suffix = re.compile(
        r"(?i)\s*read more opinion online from bloomberg view\s*\.\s*"
        r"subscribe to receive a daily e-?mail highlighting new view "
        r"(?:editorials,\s*columns|columns,\s*editorials) "
        r"and op-ed articles\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = view_promo_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    partner_work_suffix = re.compile(
        r"(?i)\s+(?:read more of (?:his|her|their) work here|"
        r"read more here)\s*\.?\s*\)?$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        parenthetical = text.startswith("(") and text.endswith(")")
        cleaned = partner_work_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if parenthetical and cleaned.startswith("(") and not cleaned.endswith(")"):
            cleaned += ")"
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    legacy_coverage_clickthrough_suffix = re.compile(
        r"(?i)\s+to read more coverage about .{2,180},\s*"
        r"click here and click here\s*\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = legacy_coverage_clickthrough_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    social_follow_suffix = re.compile(
        r"(?i)\s+follow (?:him|her|them) on "
        r"(?:instagram and twitter|twitter and instagram)\s*\.?\s*$"
    )
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        cleaned = social_follow_suffix.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            paragraph.clear()
            paragraph.append(cleaned)
        else:
            paragraph.decompose()

    disclaimer_suffix = re.compile(
        r"(?i)\s*\(?this\s+(?:column|article)\s+does\s+not\s+necessarily"
        r"\s+reflect\s+the\s+opinion\s+of\s+"
        r"(?:(?:the\s+)?editorial\s+board\s+or\s+)?"
        r"bloomberg\s+lp\s+and\s+its\s+owners\.\)?\s*$"
    )
    for text_node in list(soup.find_all(string=disclaimer_suffix)):
        cleaned = disclaimer_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    malformed_partner_tail = re.compile(
        r"(?is)(?:/?p)?em\s*uploaded by .*$"
    )
    for text_node in list(soup.find_all(string=malformed_partner_tail)):
        cleaned = malformed_partner_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    for marker in list(soup.select("p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True))
        if not re.fullmatch(
            r"(?i)\.{3}\s*advertisement\s*\.{3}",
            marker_text,
        ):
            continue
        previous_rule = marker.find_previous_sibling("hr")
        next_rule = marker.find_next_sibling("hr")
        if not isinstance(previous_rule, Tag) or not isinstance(next_rule, Tag):
            marker.decompose()
            continue
        current = previous_rule
        while current is not None:
            following = current.next_sibling
            current.extract()
            if current is next_rule:
                break
            current = following

    partner_recruiting_tail = re.compile(
        r"(?is)\s*(?:despite the downturn,\s*trading firms still continue "
        r"to build out their options trading capabilities|"
        r"to discuss these opportunities confidentially)\b.*$"
    )
    for text_node in list(soup.find_all(string=partner_recruiting_tail)):
        cleaned = partner_recruiting_tail.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    inline_signup = re.compile(
        r"(?i)\s*;\s*(?:sign up here)?\s*\.\s*"
    )
    for text_node in list(soup.find_all(string=inline_signup)):
        cleaned = inline_signup.sub(". ", str(text_node), count=1)
        text_node.replace_with(cleaned)

    for heading in soup.select("h1, h2, h3, h4"):
        text = _clean_text(heading.get_text(" ", strip=True))
        if not re.match(r"(?i)^watch (?:this )?next\s*:", text):
            continue
        sibling = heading.find_next_sibling()
        if (
            isinstance(sibling, Tag)
            and sibling.name == "figure"
            and any(
                marker in {
                    str(value).casefold()
                    for value in sibling.get("class", [])
                }
                for marker in ("inline-video", "video")
            )
        ):
            sibling.decompose()
        heading.decompose()

    for heading in list(soup.select("h2, h3, h4")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "market-related stories"
        ):
            continue
        for sibling in list(heading.next_siblings):
            sibling.extract()
        heading.decompose()

    # Legacy Bloomberg figures made the image container act like a lightbox
    # button.  Keep the figure and image, but do not preserve browser-only
    # interaction semantics in the archived article body.
    for thumbnail in list(
        soup.select(
            ".thumbnail_container.overlay_container > a.enlarge_image"
        )
    ):
        overlay = thumbnail.find_next_sibling(
            "div",
            class_="simple_overlay",
        )
        if isinstance(overlay, Tag) and overlay.find("img"):
            thumbnail.decompose()

    for node in soup.select(
        "figure [role='button'][aria-label='Open image in viewer']"
    ):
        node.attrs.pop("role", None)
        node.attrs.pop("tabindex", None)
        node.attrs.pop("aria-label", None)

    # Some legacy pages place an otherwise empty print/share control inside
    # the selected story body.
    for node in list(
        soup.select("[class*='SocialShare-'][role='button']")
    ):
        node.decompose()

    for node in list(
        soup.select(".comment-count-v2__link, .disqus-v2__tout")
    ):
        node.decompose()

    # Older Bloomberg pages wrap real inline images in generic thumbnail
    # ``div`` elements.  Promote those wrappers to figures so the adjacent
    # caption is attached to the image rather than emitted as body text.
    # Video thumbnails are excluded because their "caption" is a story
    # synopsis that is also represented by the article's text paragraphs.
    for container in list(soup.select("div.image.thumbnail:has(p.caption)")):
        classes = {
            str(value).casefold()
            for value in container.get("class", [])
        }
        if "video" in classes or container.find("img") is None:
            continue
        thumbnail = container.find(
            "a",
            class_="enlarge_image",
            recursive=False,
        )
        overlay = container.find(
            "div",
            class_="simple_overlay",
            recursive=False,
        )
        if (
            isinstance(thumbnail, Tag)
            and isinstance(overlay, Tag)
            and overlay.find("img") is not None
        ):
            thumbnail.decompose()
        container.name = "figure"

    # Calendar and market-monitor stories may mention Terminal navigation
    # codes inline (for example, ``{ECO JN <GO>}`` or ``GMEET <GO>``).
    # This must run last:
    # several stricter removals above use the command as their structural
    # signal.  Remove only the command and retain its explanation.
    for node in list(soup.select("p, li, td, th")):
        text = _clean_text(node.get_text(" ", strip=True))
        retained = re.sub(
            r"(?:\{\s*)?\b[A-Z][A-Z0-9]{1,15}"
            r"(?:\s+[A-Z][A-Z0-9]{1,15}){0,2}\s*<\s*GO\s*>\s*\}?",
            "",
            text,
        )
        retained = _clean_text(retained)
        if retained != text:
            node.clear()
            if retained:
                node.append(retained)
            else:
                node.decompose()


def _remove_nyt_promos(soup: BeautifulSoup) -> None:
    """Remove NYT sponsorship, subscription and standardized engagement UI."""
    # Legacy NYT stories syndicated through WordPress can put Jetpack's
    # ``sharedaddy`` controls inside the selected story node.  Remove the
    # complete control rather than retaining its visible ``Share this``
    # heading as article prose.
    for module in list(
        soup.select(".article-share, .sharedaddy, .sd-sharing")
    ):
        if module.parent is not None:
            module.decompose()

    # WRAL's syndicated NYT template injects an ExCo recommendation/video
    # module between genuine article paragraphs.  Its stable heading appears
    # across unrelated stories and is partner chrome, not NYT editorial text.
    for module in list(soup.select(".exco-wrapper")):
        if "other wral top stories" in _clean_text(
            module.get_text(" ", strip=True)
        ).casefold():
            module.decompose()

    # First-party articles syndicated to partner sites can include the
    # partner's entire recommendation feed inside the selected article node.
    # The explicit attribution is a reliable editorial boundary. Preserve a
    # following NYT copyright/credit paragraph, then remove the partner tail.
    for attribution in list(soup.select("p")):
        if _clean_text(
            attribution.get_text(" ", strip=True)
        ).casefold() != "this article originally appeared in the new york times.":
            continue
        boundary = attribution
        following = attribution.find_next("p")
        if isinstance(following, Tag):
            following_text = _clean_text(
                following.get_text(" ", strip=True)
            ).casefold()
            if "the new york times" in following_text and (
                "copyright" in following_text or "©" in following_text
            ):
                boundary = following
        # Syndication templates often put the recommendation feed in a
        # different wrapper, so sibling-only traversal misses it. Everything
        # after the explicit attribution/credit boundary is partner chrome.
        for node in list(boundary.find_all_next()):
            if node.parent is not None:
                node.decompose()
    # Canonical records are static. Legacy interactive pages can contain
    # hundreds of radio inputs whose adjacent labels already preserve every
    # readable team/outcome name. Retain those labels and explanatory prose,
    # but never serialize dead browser controls after scripts are removed.
    for control in list(soup.select("input, select, textarea")):
        control.decompose()

    # Candidate questionnaires and other legacy interactives expose collapsed
    # answers in static HTML. Preserve the complete answer, but remove browser
    # expansion controls and navigation to a different candidate/page.
    for control in list(
        soup.select(".read-full-answer, .next-question")
    ):
        control.decompose()

    # Reader callouts and legacy interactives often wrap useful explanatory
    # copy, figures and field labels in a form. The controls are dead in a
    # static archive, but deleting the whole form would also delete that
    # editorial context. Remove only the interactive container.
    for label in list(soup.select("form label")):
        if _clean_text(label.get_text(" ", strip=True)):
            label.name = "p"
        else:
            label.decompose()
    for form in list(soup.select("form")):
        form.unwrap()

    # Responsive NYT newsgraphics use sprite sheets as CSS image sources.
    # They are implementation assets rather than figures and otherwise appear
    # as giant, meaningless images in the normalized article body.
    for image in list(soup.select("img[src]")):
        source = str(image.get("src") or "")
        if re.search(
            r"/newsgraphics/.*/[^/]*sprite[^/]*\.(?:jpe?g|png)"
            r"|/projects/assets/oscars_2013/images/2013/"
            r"[^/]*sprite[^/]*\.(?:jpe?g|png)"
            r"(?:[?#].*)?$",
            source,
            flags=re.IGNORECASE,
        ):
            image.decompose()

    for button in list(
        soup.select(
            "button[aria-label='expand or collapse modal'], "
            "button.ad-slide-skip, button.comments-button, "
            "button[class*='SectionBarShare-shareButton'], "
            "button[class*='SaveToWatchlistButton__saveToWatchlistButton'], "
            "button[class*='LikeButton__likeButton'], "
            "button#comment-callout-comment-button"
        )
    ):
        button.decompose()

    for button in list(soup.select("button")):
        if _clean_text(button.get_text(" ", strip=True)).casefold() in {
            "view more",
            "comment on artsbeat",
        }:
            button.decompose()

    # Archived legacy articles use many otherwise unrecognizable class names
    # for share, slideshow and recirculation controls. Buttons do not carry
    # article prose, and retaining any one of them makes a normal article look
    # like an interactive extraction to downstream QA.
    for button in list(soup.select("button")):
        button.decompose()

    # Some syndicated legacy NYT pages flatten the subscription control to a
    # bare anchor inside the selected story body.  It is interface chrome, not
    # article prose; only remove an anchor whose complete visible label is the
    # standalone control word so that ordinary editorial links remain intact.
    for anchor in list(soup.select("a")):
        if _clean_text(anchor.get_text(" ", strip=True)).casefold() != "subscribe":
            continue
        parent = anchor.parent
        parent_text = (
            _clean_text(parent.get_text(" ", strip=True)).casefold()
            if isinstance(parent, Tag)
            else ""
        )
        if parent_text == "subscribe":
            parent.decompose()
        else:
            anchor.decompose()

    # Learning Network articles can append a small recirculation list inside
    # the broad story body, immediately before the contributor credit. Remove
    # only an exact ``Related`` heading followed by linked bullet paragraphs;
    # ordinary editorial uses of the word and the following credit remain.
    for heading in list(soup.select("h2, h3, h4, h5, h6")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "related"
        ):
            continue
        related_items: list[Tag] = []
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            text = _clean_text(sibling.get_text(" ", strip=True))
            if (
                sibling.name == "p"
                and text.startswith(("•", "·"))
                and sibling.select_one("a[href]") is not None
            ):
                related_items.append(sibling)
                sibling = next_sibling
                continue
            break
        if related_items:
            for item in related_items:
                item.decompose()
            heading.decompose()

    for node in list(
        soup.select("figure.byline, figure[data-testid='byline']")
    ):
        node.decompose()

    # Legacy newsletter stories can combine a genuine greeting with the
    # subscription control in one paragraph. Keep the greeting instead of
    # dropping the complete node, while removing the stable email CTA suffix.
    for node in list(soup.select("p, li")):
        text = _clean_text(node.get_text(" ", strip=True))
        retained = re.sub(
            r"(?i)\s*want this by email\?\s*sign up here\s*\.?\s*$",
            "",
            text,
        )
        retained = _clean_text(retained)
        if retained == text:
            continue
        node.clear()
        if retained:
            node.append(retained)
        else:
            node.decompose()

    patterns = (
        re.compile(r"(?i)^supported by$"),
        re.compile(r"(?i)^share full article$"),
        re.compile(
            r"(?i)^subscriber support helps make times journalism possible\b"
        ),
        re.compile(r"(?i)^\(?want to get .*briefing by email\?"),
        re.compile(
            r"(?i)^sign up here to get (?:this newsletter|"
            r"the briefing)\b"
        ),
        re.compile(
            r"(?i)^sign up for the campaign reporter\b.*"
            r"\bget messages from our politics correspondent\b.*"
            r"\bwhat(?:'|’)s at stake\.?$"
        ),
        # Some archived variants flatten the CTA to only its opening phrase,
        # without the explanatory copy used by the longer pattern above.
        re.compile(r"(?i)^sign up for the campaign reporter\b.*$"),
        re.compile(r"(?i)^sign up for the campaign reporter\.?$"),
        re.compile(
            r"(?i)^sign up for the rest of the challenge\b.*$"
        ),
        re.compile(
            r"(?i)^sign up for the call on .+\bhere\s*\.?$"
        ),
        re.compile(r"(?i)^subscribe to (?:the )?.+ newsletter\b.*$"),
        re.compile(r"(?i)^sign up for our virtual events\b.*$"),
        re.compile(
            r"(?i)^subscribe to the times space and astronomy calendar\b.*$"
        ),
        # Climate Forward and other subscriber newsletters append this exact
        # recommendation/signup paragraph after their editorial sign-off.
        # Remove only the stable CTA; the surrounding credits, archive link
        # and contact paragraph remain part of the archived newsletter.
        re.compile(
            r"(?i)^if you[’']re enjoying what you[’']re reading\s*,\s*"
            r"please consider recommending it to others\s*\.\s*"
            r"they can sign up here\s*\.\s*"
            r"browse all of our subscriber-only newsletters here\s*\.?$"
        ),
        re.compile(
            r"(?i)^if you are not a subscriber to this newsletter\b"
        ),
        re.compile(r"(?i)^browse our full range of times newsletters\b"),
        re.compile(
            r"(?i)^the times is committed to publishing a diversity "
            r"of letters to the editor\b"
        ),
        re.compile(
            r"(?i)^follow the new york times opinion section on\b"
        ),
        re.compile(r"(?i)^for newspaper delivery questions\b"),
        re.compile(r"^_{2,}$"),
        re.compile(r"(?i)^read more:?$"),
        re.compile(r"(?i)^related$"),
        re.compile(r"(?i)^next:\s+.+$"),
        re.compile(
            r"(?i)^\[?\s*(?:enjoying this article\?\s*)?"
            r"sign up for (?:our|the) .*newsletter\b"
        ),
        re.compile(
            r"(?i)^52 places and much, much more\b.*"
            r"sign up for our travel dispatch newsletter\b"
        ),
        re.compile(
            r"(?i)^want more from modern love\?.*"
            r"sign up for the newsletter\b"
        ),
        re.compile(
            r"(?i)^\[\s*like the science times page\b.*"
            r"sign up for the science times newsletter\b"
        ),
        re.compile(
            r"(?i)^\(?this article is part of the .+ newsletter\. "
            r"sign up to get it delivered to your inbox\.\)?$"
        ),
        re.compile(
            r"(?i)^.+ today goes live at .+ were you forwarded this email\? "
            r"sign up for .+ here and read every edition online here\.?$"
        ),
        re.compile(
            r"(?i)^sign up for weekly updates on .+ from the times\.?$"
        ),
        re.compile(
            r"(?i)^\[?what you need to know to start the day:\s*"
            r"get new york today in your inbox\s*\.?\s*\]?$"
        ),
        re.compile(
            r"(?i)^follow nyt food on\b.*"
            r"\bget regular updates from nyt cooking\b"
        ),
        re.compile(
            r"(?i)^follow new york times cooking on instagram\b.*"
            r"\bget regular updates from new york times cooking\b.*"
            r"\bshopping advice\s*\.?$"
        ),
        re.compile(
            r"(?i)^and our australia bureau chief offers a weekly letter "
            r"adding analysis and conversations with readers\.?$"
        ),
        re.compile(
            r"(?i)^sign up here to get it by email in the australian, "
            r"asian, european or american morning\.\s*you can also receive "
            r"an evening briefing on u\.s\. weeknights\.?$"
        ),
        re.compile(
            r"(?i)^continue following our fashion and lifestyle coverage "
            r"on facebook\b.*\btwitter\b.*\band instagram\s*\.?$"
        ),
        re.compile(
            r"(?i)^follow the new york today columnists\b.*"
            r"\bon twitter\s*\.?$"
        ),
        re.compile(
            r"(?i)^for updates throughout the day\s*,?\s*"
            r"like us on facebook\s*\.?$"
        ),
        re.compile(
            r"(?i)^what would you like to see here to start your day\?\s*"
            r"post a comment\b.*\bemail us at nytoday@nytimes\.com\b.*"
            r"#nytoday\s*\.?$"
        ),
        re.compile(
            r"(?i)^you can find the latest new york today at "
            r"nytoday\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^(?:•\s*)?for more events\s*,?\s*see the new york "
            r"times[’']s arts\s*&\s*entertainment guide\s*\.?$"
        ),
        re.compile(
            r"(?i)^\[?\s*listen to [“\"]the argument[”\"] podcast\b"
        ),
        re.compile(
            r"(?i)^is there anything you think we[’']re missing\?.*"
            r"email us at onpolitics@nytimes\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^we want to hear from our readers\..*"
            r"email us at onpolitics@nytimes\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^were you forwarded this newsletter\?\s*"
            r"subscribe here to get it delivered to your inbox\.?$"
        ),
        re.compile(
            r"(?i)^\(?\s*here[’']s the sign-up\s*,?\s*"
            r"if you don[’']t already get it by email\s*\.?\s*\)?$"
        ),
        re.compile(
            r"(?i)^california today goes live at\b.*"
            r"were you forwarded this email\?\s*"
            r"sign up for california today here\.?$"
        ),
        re.compile(r"(?i)^california today is edited by\b.*$"),
        re.compile(
            r"(?i)^.+ grew up in .+\bfollow along here or on twitter\b.*$"
        ),
        re.compile(
            r"(?i)^we[’']d love your feedback\.\s*"
            r"please email thoughts and suggestions to\s*"
            r"[^\s]+@nytimes\.com\.?$"
        ),
        re.compile(
            r"(?i)^students 13 and older are invited to comment\.\s*"
            r"all comments are moderated by the learning network staff\b.*$"
        ),
        re.compile(
            r"(?i)^for weekly email updates on residential real estate "
            r"news\s*,?\s*sign up here\s*\.?"
            r"(?:\s*follow us on twitter\s*:\s*@nytrealestate\s*\.?)?$"
        ),
        re.compile(
            r"(?i)^\[\s*read about the events that our other critics "
            r"have chosen for the week ahead\s*\.\s*\]$"
        ),
        re.compile(
            r"(?i)^(?:c\.|©)\s*(?:19|20)\d{2}\s+"
            r"the new york times company\s*\.?$"
        ),
        # Europe Morning Briefing pages append these standardized footer
        # paragraphs after the editorial sections. Keep headings such as
        # ``Good morning`` and ``Back Story`` while removing only the exact
        # engagement/publication boilerplate observed across the 2017 holdout.
        re.compile(
            r"(?i)^what would you like to see here\?\s*"
            r"contact us at (?:asia|europe)briefing@nytimes\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^tips\s*,?\s*both new and old\s*,?\s*"
            r"for a more fulfilling life\s*\.?$"
        ),
        re.compile(
            r"(?i)^your morning briefing is published weekday mornings "
            r"and updated online\.?$"
        ),
        # U.S. Morning Briefing snapshots from the 2017 holdout append a
        # fixed support/publication/feedback/subscription footer. Archive
        # HTML can flatten the support and publication paragraphs together.
        re.compile(
            r"(?i)^your morning briefing is published weekdays at 6 a\.m\. "
            r"eastern and updated on the web all morning\s*\.?$"
        ),
        re.compile(
            r"(?i)^what would you like to see here\?\s*"
            r"contact us at briefing@nytimes\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^photographs may appear out of order for some readers\b.*"
            r"briefing should help\b.*$"
        ),
        re.compile(
            r"(?i)^you can sign up here to get the briefing delivered "
            r"to your inbox\b.*$"
        ),
        # Evening Briefing pages use a three-paragraph recirculation and
        # feedback footer.  Preserve the briefing's editorial sections while
        # dropping only these exact tail paragraphs.
        re.compile(
            r"(?i)^and don[’']t miss your morning briefing\b.*"
            r"\band your weekend briefing\b.*$"
        ),
        re.compile(
            r"(?i)^want to look back\?\s*here[’']s "
            r"last night[’']s briefing\s*\.?$"
        ),
        re.compile(
            r"(?i)^what did you like\?\s*what do you want to see here\?\s*"
            r"let us know at briefing@nytimes\.com\s*\.?$"
        ),
        re.compile(
            r"(?i)^follow the @readercenter on twitter for more coverage\b"
        ),
    )
    for node in list(
        soup.select("p, li, span, em, h1, h2, h3, h4, h5, h6")
    ):
        text = _clean_text(node.get_text(" ", strip=True))
        if any(pattern.search(text) for pattern in patterns):
            node.decompose()


def _remove_reuters_promos(soup: BeautifulSoup) -> None:
    """Remove Reuters registration UI and licensed-partner subscription tails."""
    # Reuters statbox/live-score templates occasionally leave a form control
    # inside the article body. It is interface chrome, not editorial content.
    for node in list(soup.select("input")):
        node.decompose()
    for node in list(
        soup.select(
            ".rich-share, [data-testid='rich-share'], "
            ".Image_expand-button, .Slideshow_expand-button, "
            "[aria-label='Expand Image Slideshow'], "
            ".share-icon-container, #jMore-PopUp"
        )
    ):
        node.decompose()

    for button in list(soup.select("button")):
        classes = " ".join(button.get("class") or []).casefold()
        if "socialtools" in classes:
            button.decompose()
        else:
            button.unwrap()

    for node in list(
        soup.select(
            "[class*='pagination-v2__container' i][role='button'], "
            "a[role='button']"
        )
    ):
        node.decompose()
    for node in list(soup.select("[role='button']")):
        node.attrs.pop("role", None)
        node.attrs.pop("tabindex", None)

    for marker in list(soup.select("[data-testid^='paragraph-']")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != "read more:":
            continue
        candidates: list[Tag] = [marker]
        sibling = marker.find_next_sibling()
        boundary_found = False
        while isinstance(sibling, Tag) and len(candidates) <= 6:
            text = _clean_text(sibling.get_text(" ", strip=True)).casefold()
            if text.startswith(("reporting by ", "editing by ")):
                boundary_found = True
                break
            candidates.append(sibling)
            sibling = sibling.find_next_sibling()
        if not boundary_found:
            continue
        for node in candidates:
            node.decompose()

    for node in list(soup.select("p, div, span")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"[_^]{3,}", text):
            node.decompose()

    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text in {"share this article", "whatsapp print pdf"}:
            node.decompose()
        elif text.startswith(
            "register now for free unlimited access to reuters.com"
        ) or text.startswith(
            "the company and law firm names shown above are generated "
            "automatically based on the text of the article"
        ) or re.fullmatch(
            r"subscribe to our channels on youtube\s*,\s*telegram\s*&\s*whatsapp\s*[.!]?",
            text,
        ):
            node.decompose()

    wire_copyright_suffix = re.compile(
        r"""(?ix)\s*(?:"""
        r"""copyright(?:\s+(?:19|20)\d{2})?\s*,?\s*"""
        r"""business\s+wire(?:\s+(?:19|20)\d{2})?"""
        r"""(?:\s*[,.:;-]\s*|\s+)"""
        r"""all\s+rights\s+reserved\.?\s*(?:-0-)?"""
        r"""|"""
        r"""copyright\s+business\s+wire\s+\d{4}"""
        r"""|"""
        r"""copyright\s+\d{4},\s*market\s+wire,\s*"""
        r"""all\s+rights\s+reserved\.\s*-0-"""
        r""")\s*$"""
    )
    for text_node in list(soup.find_all(string=wire_copyright_suffix)):
        cleaned = wire_copyright_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    legacy_legal_suffix = re.compile(
        r"""(?is)\s*(?:"""
        r"""(?:keywords:\s*)?[^\n]{0,500}?"""
        r"""\(c\)\s*reuters\s+(?:19|20)\d{2}\.\s*"""
        r"""all\s+rights\s+reserved\..*$"""
        r"""|"""
        r"""(?:copyright(?:\s+copyright)?|©|ï¿½)\s*(?:©\s*)?"""
        r"""(?:19|20)\d{2}[\s,.][^\n]{0,750}?"""
        r"""all\s+rights\s+reserved\.?.*$"""
        r""")\s*$"""
    )
    for text_node in list(soup.find_all(string=legacy_legal_suffix)):
        cleaned = legacy_legal_suffix.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()

    marker = next(
        (
            node
            for node in soup.select("p")
            if _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith("already a subscriber? log in")
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


def _trim_wsj_roadblock_tail(soup: BeautifulSoup) -> None:
    """Drop the subscription roadblock and recirculation appended after it."""
    marker = soup.select_one("[class*='ArticleRoadblock' i]")
    if not isinstance(marker, Tag):
        marker = next(
            (
                node
                for node in soup.select("p, h2, h3, h4")
                if _clean_text(node.get_text(" ", strip=True))
                .casefold()
                .startswith(
                    (
                        "to read the full story",
                        "continue reading your article with",
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


def _remove_wsj_promos(soup: BeautifulSoup) -> None:
    """Remove metered-view controls, copyright footers and coupon modules."""
    full_access_body = any(
        _clean_text(str(node.get("amp-access") or "")).casefold()
        == "access"
        for node in soup.select("[amp-access]")
    ) or soup.select_one("[subscriptions-section='content']") is not None
    if full_access_body:
        for snippet in list(
            soup.select(
                ".snippet[amp-access], "
                ".snippet[subscriptions-section='content-not-granted']"
            )
        ):
            access_rule = _clean_text(
                str(snippet.get("amp-access") or "")
            ).casefold()
            subscription_rule = _clean_text(
                str(snippet.get("subscriptions-section") or "")
            ).casefold()
            if (
                access_rule == "not access"
                or subscription_rule == "content-not-granted"
            ):
                # AMP keeps a deliberately truncated metered preview beside
                # the complete subscriber body.  Once the complete sibling
                # is present, retaining the preview leaks duplicate opening
                # paragraphs and a meaningless terminal ``The...`` block.
                # Newer AMP subscriptions markup expresses the same state as
                # ``content`` / ``content-not-granted`` attributes.
                snippet.decompose()
    for marker in list(soup.select("p")):
        marker_text = _clean_text(marker.get_text(" ", strip=True)).casefold()
        if not marker_text.startswith("the wsj is now on line."):
            continue
        # Korea Real Time and a few other legacy WSJ blogs appended a LINE
        # signup, QR code and an ``Also popular`` link rail as ordinary
        # paragraphs inside ``articleBody``.  The promo is a terminal footer,
        # so remove it and every following sibling while retaining the update
        # or correction paragraph immediately before it.
        top = soup.find()
        if not isinstance(top, Tag):
            break
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
        break
    for newsletter_link in list(
        soup.select("a[href*='/newsletters'][href*='sub=best_of_the_web']")
    ):
        # Best of the Web columns append this inline subscription CTA in an
        # otherwise unclassified ``em`` node inside the article body.
        newsletter_link.decompose()
    for marker in list(soup.select("p")):
        marker_text = _clean_text(
            marker.get_text(" ", strip=True)
        ).casefold()
        if marker_text != "follow james freeman on twitter.":
            continue
        profile_link = marker.select_one(
            "a[href*='twitter.com/freemanwsj' i], "
            "a[href*='x.com/freemanwsj' i]"
        )
        if not isinstance(profile_link, Tag):
            continue
        # Best of the Web columns archived in 2019 append a stable author
        # promotion after the final editorial paragraph: the author's
        # Twitter profile, an email solicitation, compiler credit and a book
        # biography.  Trim only the tail identified by Freeman's exact
        # profile link, leaving ordinary in-article Twitter references and
        # every preceding paragraph untouched.
        top = soup.find()
        if not isinstance(top, Tag):
            break
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
        break
    for button in list(soup.select("button")):
        button.decompose()
    for form in list(soup.select("form")):
        # Reader questionnaires and share-by-email dialogs are interactive
        # controls, not article copy. Removing the whole form also drops its
        # field labels and consent boilerplate instead of leaving a flattened
        # pseudo-paragraph in the archived body.
        form.decompose()
    for control in list(soup.select("input, select, textarea")):
        control.decompose()
    for tagline in list(soup.select("p.articleTagLine")):
        if re.fullmatch(
            r"[_=—–-]+",
            _clean_text(tagline.get_text(" ", strip=True)),
        ):
            tagline.decompose()
    for strap in list(soup.select(".strap-container")):
        heading = strap.select_one("h2, h3, h4, h5, h6, .strap")
        if (
            isinstance(heading, Tag)
            and _clean_text(heading.get_text(" ", strip=True)).casefold()
            == "related video"
        ):
            strap.decompose()
    for rich_text in list(soup.select(".media-object-rich-text")):
        heading = rich_text.select_one("h2, h3, h4, h5, h6")
        heading_text = (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            if isinstance(heading, Tag)
            else ""
        )
        link = rich_text.select_one("a[href]")
        link_text = (
            _clean_text(link.get_text(" ", strip=True)).casefold()
            if isinstance(link, Tag)
            else ""
        )
        link_href = str(link.get("href") or "") if isinstance(link, Tag) else ""
        rich_text_text = _clean_text(
            rich_text.get_text(" ", strip=True)
        ).casefold()
        newsletter_signup = bool(
            isinstance(link, Tag)
            and "sign up" in link_text
            and "newsletter" in link_text
            and (
                "email-setup" in link_href.casefold()
                or "newsletter" in link_href.casefold()
            )
        )
        article_list_newsletter = bool(
            isinstance(link, Tag)
            and rich_text.select_one("ul.articleList") is not None
            and rich_text_text.startswith("sign up for ")
            and "newsletter" in link_text
            and (
                "newsletter" in link_href.casefold()
                or "/newsletters/" in link_href.casefold()
            )
        )
        heading_newsletter_signup = bool(
            isinstance(link, Tag)
            and heading_text.endswith("newsletter")
            and "sign up" in rich_text_text
            and "newsletter" in link_href.casefold()
        )
        coronavirus_link_rail = bool(
            heading_text == "understanding coronavirus"
            and rich_text.select_one("ul.articleList") is not None
            and len(rich_text.select("ul.articleList a[href*='/articles/']"))
            >= 2
        )
        coronavirus_newsletter_signup = bool(
            heading_text == "stay informed"
            and rich_text.select_one("ul.articleList") is not None
            and "get a coronavirus briefing" in rich_text_text
            and "sign up here" in rich_text_text
            and isinstance(link, Tag)
            and "newsletter" in link_href.casefold()
        )
        if (
            (
                isinstance(heading, Tag)
                and (
                    heading_text
                    in {
                        "read more",
                        "related reading",
                        "share your thoughts",
                    }
                    or (
                        (
                            heading_text in {"more", "related"}
                            or heading_text.startswith("more ")
                        )
                        and rich_text.select_one("ul.articleList") is not None
                    )
                )
            )
            or newsletter_signup
            or article_list_newsletter
            or heading_newsletter_signup
            or coronavirus_link_rail
            or coronavirus_newsletter_signup
        ):
            rich_text.decompose()
    for card in list(soup.select(".media-object.type-InsetRichMedia")):
        link = card.select_one(".media-object-interactiveLink a[href]")
        if not isinstance(link, Tag):
            continue
        href = str(link.get("href") or "").strip()
        split = urlsplit(href)
        if (
            "/articles/" in split.path
            and (not split.netloc or split.netloc.casefold().endswith("wsj.com"))
        ):
            # Legacy templates embedded related-story cards as rich media
            # inside articleBody. Their thumbnail, teaser and heading are
            # recirculation rather than an image or paragraph of this story.
            card.decompose()
    # Pre-Oak WSJ pages placed related-story rails and section navigation in
    # generic ``module inset-box`` containers inside ``articleBody``.  The
    # same markup also carries real slideshows and graphics, so remove only
    # modules with narrow publisher-interface signatures observed in the
    # archived pages.
    for module in list(
        soup.select(
            ".module.inset-box, .module.rich-media-inset, .media-object"
        )
    ):
        if module.parent is None:
            continue
        module_text = _clean_text(
            module.get_text(" ", strip=True)
        ).casefold()
        heading_texts = {
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            for heading in module.select("h2, h3, h4, h5, h6")
        }
        links = list(module.select("a[href]"))
        hrefs = [str(link.get("href") or "").casefold() for link in links]
        legacy_link_rail = (
            bool(links)
            and (
                (
                    "more" in heading_texts
                    and module.select_one("ul.articleList") is not None
                )
                or bool(
                    heading_texts
                    & {"earlier", "journal community", "journal report"}
                )
                or any(
                    heading_text.startswith("more in ")
                    for heading_text in heading_texts
                )
            )
        )
        fins_workplace_rail = (
            module_text.startswith("fins: women in the workplace")
            and any("fins.com/" in href for href in hrefs)
        )
        saturday_rail = (
            module_text.startswith("also in saturday's wsj")
            and len(links) >= 2
        )
        olympics_rail = (
            any("/public/page/olympics-london.html" in href for href in hrefs)
            and len(links) >= 4
        )
        concierge_rail = (
            module_text.startswith("more journal concierge city guides")
            and len(links) >= 5
        )
        if any(
            (
                legacy_link_rail,
                fins_workplace_rail,
                saturday_rail,
                olympics_rail,
                concierge_rail,
            )
        ):
            module.decompose()
    # A real slideshow inset can append this generic gallery-directory CTA.
    # Drop only its list so the story-specific image and caption survive.
    for article_list in list(soup.select("ul.articleList")):
        text = _clean_text(article_list.get_text(" ", strip=True)).casefold()
        if text != "more photos and interactive graphics":
            continue
        link = article_list.select_one("a[href]")
        href = str(link.get("href") or "").casefold() if link else ""
        if "/public/page/0_0_wp_2003.html" in href:
            article_list.decompose()
    for paragraph in list(soup.select("p")):
        if (
            _clean_text(paragraph.get_text(" ", strip=True))
            .casefold()
            .startswith(
                "to explore and search through all our recipes, "
                "check out the new wsj recipes page"
            )
        ):
            paragraph.decompose()

    # Older WSJ captures flatten newsletter and recirculation cards into
    # ordinary paragraphs/headings inside the article wrapper.  Their
    # classes vary by template, so selector-only cleanup misses them.  Keep
    # this list deliberately narrow and operate only on standalone text
    # blocks; normal reporting sentences that merely mention a newsletter or
    # a related topic must remain in the body.
    wsj_interface_patterns = (
        re.compile(r"^related(?: stories)?$", re.IGNORECASE),
        re.compile(r"^read more:?$", re.IGNORECASE),
        re.compile(
            r"^subscribe to (?:our morning newsletter|the best of the web "
            r"(?:today )?email)\b.*$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^write to .+? at [\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^related(?: coverage| video)$", re.IGNORECASE),
        re.compile(r"^in other news$", re.IGNORECASE),
        re.compile(r"^number of the day$", re.IGNORECASE),
        re.compile(r"^quotable$", re.IGNORECASE),
        re.compile(r"^best of the rest$", re.IGNORECASE),
        re.compile(
            r"^here(?:'|’)s your morning roundup of the biggest marketing, "
            r"advertising and media industry news and happenings\.?$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^sign up:\s*with one click, get this newsletter delivered "
            r"to your inbox\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^click to read story$", re.IGNORECASE),
        re.compile(
            r"^sign up for the wsj book club here\s*\.?$",
            re.IGNORECASE,
        ),
        re.compile(r"^corrections?\s*&\s*amplifications$", re.IGNORECASE),
        re.compile(
            r"^today[’']s top supply chain and logistics news from wsj$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^cmo insights and analysis from deloitte$",
            re.IGNORECASE,
        ),
        re.compile(r"^content from our sponsor$", re.IGNORECASE),
        re.compile(
            r"^follow us on twitter:\s*@.+$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^please note:\s*the wall street journal news department "
            r"was not involved in the creation of the content above\.?$",
            re.IGNORECASE,
        ),
    )
    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        if node.parent is None:
            continue
        text = _clean_text(node.get_text(" ", strip=True))
        if any(pattern.fullmatch(text) for pattern in wsj_interface_patterns):
            node.decompose()

    for inset in list(
        soup.select(".media-object.type-InsetMediaIllustration")
    ):
        image = inset.select_one("img[src], img[data-enlarge]")
        image_url = (
            str(image.get("data-enlarge") or image.get("src") or "")
            if isinstance(image, Tag)
            else ""
        )
        caption = inset.select_one(".wsj-article-caption-content")
        caption_text = _clean_text(
            caption.get_text(" ", strip=True)
            if isinstance(caption, Tag)
            else ""
        ).casefold()
        if caption_text == "wsj" and re.search(
            r"(?i)://images\.wsj\.net/im-273836(?:[/?]|$)",
            image_url,
        ):
            # This fixed house illustration appears in unrelated articles as
            # an AMP-era presentation inset.  It is not editorial media from
            # either story and must not become a reusable body image.
            inset.decompose()
    for node in list(
        soup.select(
            ".coupon-list, [class*='SavingsUnited' i], "
            ".chiclet-wrapper, "
            "[class*='SnippetSignIn' i], .author-links, .author-info, "
            ".bylineWrap, "
            ".webui-newsletter-inset, #webui_newsletter_inset, "
            ".newsletter-inset, .wsj-ad, "
            "[class*='mobile-modal-author' i], .byline-wrap, "
            ".article__byline, .module.automated-news, "
            ".module.editors-picks, .share-bottom, .printSummary, "
            ".article-news-front, [class*='AuthoringContainer'], "
            ".media-object.type-InsetNewsletterSignup, "
            ".article__inset--type-InsetNewsletterSignup, "
            "[data-block='doNotPrint'], "
            "[data-module-zone='opinion_editors_picks'], "
            "[data-module-zone='contentCarousel'], "
            ".content-carousel, .olympics-carousel, "
            ".series-nav__inset-container, "
            "[class*='-JRStrap'], [class*='-JRNextArticle'], "
            "[class*='-JRMoreArticles'], "
            ".opinion-editors-picks"
        )
    ):
        node.decompose()
    for node in list(soup.select(".media-object.inline")):
        heading = node.select_one("h2, h3, h4, h5, h6")
        if (
            isinstance(heading, Tag)
            and _clean_text(heading.get_text(" ", strip=True))
            .casefold()
            .startswith("more ")
            and node.select_one("ul.articleList") is not None
        ):
            node.decompose()
    for heading in list(soup.select("h2.subhead")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "opinion editor's picks"
        ):
            continue
        sibling = heading.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        heading.decompose()
    for control in list(soup.select("a[role='button']")):
        if _clean_text(control.get_text(" ", strip=True)).casefold() != "see all":
            continue
        collection = next(
            (
                parent
                for parent in control.parents
                if isinstance(parent, Tag)
                and len(parent.select("article")) >= 2
            ),
            None,
        )
        if isinstance(collection, Tag):
            collection.decompose()
        else:
            control.decompose()
    for wrapper in list(
        soup.select(
            ".theme-nav-wrapper, "
            "[class*='theme-navigation-'][class*='-container']"
        )
    ):
        inset = wrapper.find_parent(
            class_=lambda value: value
            and "article__inset" in " ".join(
                value if isinstance(value, list) else [value]
            )
        )
        (inset if isinstance(inset, Tag) else wrapper).decompose()
    for node in list(soup.select(".media-object.type-InsetRichText")):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            text.startswith("stay informed get a coronavirus briefing")
            and "sign up here" in text
        ):
            node.decompose()
    for prompt in list(soup.select("p, h2, h3, h4, h5, h6")):
        text = _clean_text(prompt.get_text(" ", strip=True)).casefold()
        if text in {"- wsj news exclusive", "wsj news exclusive"}:
            prompt.decompose()
            continue
        if text != "share your thoughts":
            continue
        followup = prompt.find_next_sibling()
        if isinstance(followup, Tag) and "join the conversation" in (
            _clean_text(followup.get_text(" ", strip=True)).casefold()
        ):
            followup.decompose()
        prompt.decompose()
    text_nodes = list(soup.select("p, h2, h3, h4, h5, h6"))
    for index, node in enumerate(text_nodes):
        if node.parent is None:
            continue
        if (
            _clean_text(node.get_text(" ", strip=True)).casefold()
            != "stay informed"
        ):
            continue
        promo_nodes = [node]
        nearby = "stay informed"
        for candidate in text_nodes[index + 1 : index + 3]:
            if candidate.parent is None:
                continue
            promo_nodes.append(candidate)
            nearby += " " + _clean_text(
                candidate.get_text(" ", strip=True)
            ).casefold()
            if (
                "get a coronavirus briefing" in nearby
                and "sign up here" in nearby
            ):
                for promo_node in promo_nodes:
                    promo_node.decompose()
                break
    for node in list(soup.select("p, h2, h3, h4, h5, h6")):
        if node.parent is None:
            continue
        text = _clean_text(node.get_text(" ", strip=True))
        folded = text.casefold()
        classes = " ".join(node.get("class") or []).casefold()
        if (
            text in {".", "\u200b", "\ufeff"}
            or (
                folded.startswith("copyright ©")
                and "dow jones & company" in folded
            )
            or folded.startswith("already a member? sign in")
            or folded in {"listen", "listen to article"}
            or re.fullmatch(r"\(\d+\s+min(?:ute)?s?\)", folded)
            or (
                folded == "videos"
                and "sectionlabel" in classes
            )
            or (
                folded.startswith(
                    "buy side from wsj expert recommendations "
                    "on products and services"
                )
                and node.select_one(
                    "a[href*='wsj.com/buyside']"
                )
            )
        ):
            node.decompose()
            continue
        if (
            "sign up for our" in folded
            and "newsletter" in folded
            and (
                folded.startswith(("—for more wsj", "-for more wsj"))
                or len(folded) <= 400
            )
        ):
            node.decompose()


def _remove_ft_body_chrome(soup: BeautifulSoup) -> None:
    """Remove Next-era sharing, recirculation and follow-topic UI."""
    for button in list(soup.select("button")):
        button.decompose()
    # AMP captures from the 2021-era Next template append a Climate Capital
    # promotion inside the article body. Other cleanup removes its image and
    # descriptive CTA, but historically left the card heading as a bogus
    # final article block. Require both the exact heading and the publisher's
    # destination so genuine editorial sections named Climate Capital remain.
    for module in list(soup.select("experimental")):
        heading = module.select_one("h2, h3, h4")
        if not isinstance(heading, Tag):
            continue
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "climate capital"
        ):
            continue
        if module.select_one("a[href*='/climate-capital']"):
            module.decompose()
    for component in list(soup.select(".flashcomponent")):
        link = component.select_one("a.flashlink[href]")
        if not isinstance(link, Tag):
            continue
        source = str(link.get("href") or "").strip()
        if not source:
            continue
        iframe = soup.new_tag("iframe")
        iframe["src"] = source
        iframe["title"] = (
            _clean_text(link.get_text(" ", strip=True))
            or "Archived FT interactive"
        )
        iframe["data-interactive-provider"] = "ft-flash"
        component.replace_with(iframe)

    for node in list(
        soup.select(
            "[data-toolbar='share'], "
            ".article-info__byline, "
            ".o-message__content-main, "
            ".story-package[data-track-comp-name='moreOn'], "
            ".insideArticleShare, "
            "[data-trackable='podcast-services'], "
            ".ftlabsaudioplayerholder, "
            ".component-share, "
            ".component-share__button, "
            ".article__save, "
            ".article__share, "
            ".share, "
            "section.article-list, "
            ".package__nav--top, "
            ".package__nav--end, "
            ".teaser-wide-card, "
            ".jti-certification, "
            ".comment-disabled-notice, "
            "form.n-myft-ui, "
            "form[class*='n-myft-ui'], "
            "[data-component-id='myft-preferences-modal'], "
            "[class*='n-myft-ui'], "
            ".video__placeholder__up-next, "
            ".o-video__play-button, "
            ".player__video-trigger, "
            "button[data-trackable='expander-toggle'], "
            "button[data-trackable='save-for-later']"
        )
    ):
        node.decompose()
    # FT partner pages can place a small source logo directly inside the
    # licensed story wrapper.  It is attribution chrome, not an editorial
    # image, and otherwise survives as an archivable body block.
    for image in list(soup.select("img[alt]")):
        source = str(image.get("src") or image.get("data-src") or "")
        if (
            _clean_text(str(image.get("alt") or "")).casefold() == "ft"
            and "/ft-png-data.png" in unquote(urlsplit(source).path).casefold()
        ):
            wrapper = image.find_parent(class_="html-fragment")
            (wrapper if isinstance(wrapper, Tag) else image).decompose()
    # The legacy How To Spend It template placed topic tags in an unmarked
    # section headed ``See also`` inside the broad article wrapper.
    for heading in list(soup.select("h2, h3, h4")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "see also"
        ):
            continue
        section = heading.find_parent("section")
        if isinstance(section, Tag) and section.select_one(".tag-list"):
            section.decompose()
    for aside in list(soup.select("aside")):
        if any(
            _clean_text(node.get_text(" ", strip=True)).casefold()
            in {"read more", "continue reading"}
            for node in aside.select("a, p")
        ):
            aside.decompose()
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        folded_text = text.casefold()
        if re.fullmatch(r"_{2,}", text) or _FT_STRUCTURED_RULE_RE.fullmatch(
            text
        ):
            node.decompose()
            continue
        # Some 2021-era archived Next pages render the same terminal modules
        # that are appended to JSON-LD ``articleBody`` as ordinary body
        # paragraphs.  Apply the shared, publisher-specific signatures to
        # this representation as well.  These are deliberately anchored at
        # the start of a standalone paragraph so ordinary reporting about
        # climate policy, sustainability or newsletters remains untouched.
        if _FT_STRUCTURED_TERMINAL_CHROME_RE.match(text):
            node.decompose()
            continue
        # Very old Lex pages flatten the column's contact/subscription
        # boilerplate into the article body. These paragraphs are template
        # chrome, not reporting, and otherwise trigger the interface-noise
        # audit through their separator line.
        if folded_text.startswith("to e-mail the lex team "):
            node.decompose()
            continue
        if folded_text.startswith("the lex column is now on twitter"):
            node.decompose()
            continue
        if (
            folded_text.startswith("lex is the ft")
            and "agenda-setting column" in folded_text
        ):
            node.decompose()
            continue
        if (
            folded_text.startswith("related links:")
            and len(node.select("a[href]")) >= 2
        ):
            node.decompose()
            continue
        if folded_text == "subscribe now":
            node.decompose()
            continue
        if folded_text.startswith(
            "if you have questions or comments, please e-mail help@ft.com"
        ):
            node.decompose()
            continue
        # Recent FT podcast, survey, and channel pages flatten promotional
        # calls-to-action into the article body. They are interface chrome,
        # not reporting, and otherwise contaminate parser QA samples.
        if (
            folded_text.startswith(
                "subscribe to the rachman review wherever you get your "
                "podcasts"
            )
            or re.fullmatch(
                r"subscribe to the ft news briefing o(?:a)?n apple "
                r"podcasts or spotify[.!]?",
                folded_text,
            )
            or re.fullmatch(
                r"subscribe to the ft weekend podcast[.!]?",
                folded_text,
            )
            or folded_text == "sign up for the survey!"
            or (
                folded_text.startswith("sign up for the britain")
                and "healthiest workplace survey" in folded_text
            )
            or folded_text.startswith(
                "sign up for the financial times markets news channel"
            )
            or re.match(
                r"^sign up for the ft(?:'|’)s due diligence newsletter\b",
                folded_text,
            )
        ):
            node.decompose()
            continue
        # Infini-News flattens FT podcast newsletter controls into ordinary
        # paragraphs.  They are publisher UI, not part of the episode
        # description, and can otherwise trip the interface-noise audit.
        if (
            re.fullmatch(r"receive free .+ updates", folded_text)
            and " with " in folded_text
        ) or re.match(
            r"^we(?:'|’)ll send you a myft daily digest email rounding up "
            r"the latest .+ news every morning\.?$",
            folded_text,
        ):
            node.decompose()
            continue
        # The privacy sentence is also commonly concatenated to the end of
        # an otherwise substantive podcast paragraph by Infini-News.
        acast_marker = (
            "see acast.com/privacy for privacy and opt-out information"
        )
        if acast_marker in folded_text:
            cleaned = re.sub(
                r"(?i)\s*see acast\.com/privacy for privacy and opt-out "
                r"information\.?",
                "",
                text,
            ).strip()
            if cleaned:
                node.clear()
                node.append(cleaned)
            else:
                node.decompose()
            continue
        if re.fullmatch(
            r"(?:us and canada|asia|uk, europe and rest of the world)\s*:\s*"
            r"\+?[\d ()-]+"
            r"(?:\s+(?:asia|uk, europe and rest of the world)\s*:\s*"
            r"\+?[\d ()-]+)*",
            folded_text,
        ):
            node.decompose()
            continue
        if text.casefold() in {
            "sign in",
            "subscribe",
            "already a member? sign in",
        }:
            node.decompose()
            continue
        if re.fullmatch(
            r"(?i)see acast\.com/privacy for privacy and "
            r"opt-out information\.?",
            text,
        ):
            node.decompose()
            continue
        if re.match(r"(?i)^recommended\s*\*", text):
            node.decompose()
            continue
        if "follow @financialtimesfashion on instagram" in text.casefold():
            # Infini-News sometimes flattens the same fashion call-to-action
            # with the lead-in before the handle (rather than starting with
            # ``Follow``).  Both forms are publisher chrome, not article
            # prose, and should be removed before block extraction.
            node.decompose()
            continue
        if re.match(
            r"(?i)^the ft is offering a free \d+-day trial to "
            r"coronavirus business update\b",
            text,
        ):
            node.decompose()
            continue
        if re.fullmatch(
            r"(?i)email the lex team at lex@ft\.com\.?",
            text,
        ):
            node.decompose()
            continue
        if re.fullmatch(
            r"(?i)the most thought-provoking online contributions may be "
            r"published in the financial times newspaper\.?",
            text,
        ):
            node.decompose()

    _remove_ft_subscription_offer_chrome(soup)

    for marker in list(soup.select("p, h2, h3, h4")):
        if not re.fullmatch(
            r"read more:?",
            _clean_text(marker.get_text(" ", strip=True)).casefold(),
        ):
            continue
        sibling = marker.find_next_sibling()
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            text = _clean_text(sibling.get_text(" ", strip=True))
            linked_ft_stories = sibling.select(
                "a[href*='ft.com/content/'], a[href^='/content/']"
            )
            if sibling.name in {"ul", "ol"} or (
                sibling.name == "p"
                and len(text) <= 500
                and (
                    text.startswith(("-", "–", "—", "−"))
                    or len(linked_ft_stories) >= 2
                )
            ):
                sibling.decompose()
                sibling = next_sibling
                continue
            break
        marker.decompose()

    tail_markers: list[Tag] = list(
        soup.select(
            ".instant-alert-cta__text, "
            ".h2-promoted-content, "
            ".concept-list__title, "
            ".comments__disabled-message"
        )
    )
    for node in soup.select("h2, h3, p"):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if (
            text == "promoted content"
            or text == "recommended newsletters for you"
            or text.startswith("follow the topics in this ")
            or (
                text.startswith("get alerts on ")
                and text.endswith(" when a new story is published")
            )
            or (
                text.startswith(
                    "ft subscriber? sign up for the weekly "
                )
                and " newsletter" in text
            )
            or text in {
                "letter in response to this article:",
                "letter in response to this report:",
            }
        ):
            tail_markers.append(node)
    if not tail_markers:
        return
    top = soup.find()
    if not isinstance(top, Tag):
        return
    marker_ids = {id(marker) for marker in tail_markers}
    marker = next(
        (
            node
            for node in top.descendants
            if isinstance(node, Tag) and id(node) in marker_ids
        ),
        None,
    )
    if not isinstance(marker, Tag):
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


def _remove_ft_subscription_offer_chrome(soup: BeautifulSoup) -> None:
    """Remove modern FT subscription offers flattened into article bodies.

    Wayback captures of FT pages can retain the article together with the
    current subscription conversion UI. The offer is not consistently wrapped
    in one stable class, but its short CTA copy is stable enough to remove
    without touching ordinary reporting that discusses subscriptions.
    Prefer a marked offer container; otherwise remove only the individual
    block containing the CTA.
    """
    markers = (
        "subscribe to unlock this article",
        "try unlimited access",
        "only $1 for ",
        "then $75 per month",
        "complete digital access",
        "explore more offers",
    )

    def is_offer_text(value: str) -> bool:
        folded = _clean_text(value).casefold()
        return any(
            folded.startswith(marker) or folded == marker.rstrip()
            for marker in markers
        )

    # Newer FT templates usually expose an offer/upsell wrapper. Keep the
    # selector deliberately narrow and never decompose the article root.
    for container in list(
        soup.select(
            "[class*='paywall' i], [id*='paywall' i], "
            "[class*='subscription' i], [id*='subscription' i], "
            "[class*='upsell' i], [id*='upsell' i], "
            "[class*='offer' i], [id*='offer' i], "
            "[data-testid*='paywall' i], "
            "[data-testid*='subscription' i], "
            "[data-component*='paywall' i], "
            "[data-component*='subscription' i]"
        )
    ):
        if container.name in {"article", "main", "body", "html"}:
            continue
        if is_offer_text(container.get_text(" ", strip=True)):
            container.decompose()

    # Older captures flatten the offer as ordinary paragraphs/headings. Do
    # not match arbitrary mentions of subscriptions inside long prose.
    for node in list(
        soup.select("p, li, h2, h3, h4, h5, h6, button, a, span")
    ):
        if not is_offer_text(node.get_text(" ", strip=True)):
            continue
        target = node
        if node.name in {"a", "button", "span"}:
            parent = node.find_parent(
                ("p", "li", "h2", "h3", "h4", "h5", "h6")
            )
            if isinstance(parent, Tag):
                target = parent
        if target.name not in {"article", "main", "body", "html"}:
            target.decompose()


def _ft_infini_access_shell(soup: BeautifulSoup) -> bool:
    """Detect Infini-derived FT access shells with no article prose."""
    if soup.select_one(
        "article[data-jojo-representation='derived-infini-news']"
    ) is None:
        return False
    text = _clean_text(soup.get_text(" ", strip=True)).casefold()
    legacy_access_shell = (
        "new to the financial times?" in text
        and "enjoy 7 days of free access" in text
    ) or "to read: financial times" in text
    trial_offer_shell = (
        "what is included in my trial?" in text
        and "during your trial you will have complete digital access to ft.com"
        in text
        and (
            "standard digital includes access" in text
            or "premium digital includes access" in text
        )
    )
    return legacy_access_shell or trial_offer_shell


def _remove_ft_newsletter_promos(soup: BeautifulSoup) -> None:
    """Remove newsletter cards flattened into FT syndication body paragraphs."""
    coronavirus_headings = {
        "latest coronavirus news",
        "read more about the impact of coronavirus",
    }
    for heading in list(soup.select("h2, h3, h4")):
        heading_text = _clean_text(
            heading.get_text(" ", strip=True)
        ).casefold()
        card = heading.find_parent("experimental")
        if not isinstance(card, Tag):
            card = heading.find_parent(
                class_=lambda value: value and "n-content-layout" in value
            )
        card_text = (
            _clean_text(card.get_text(" ", strip=True)).casefold()
            if isinstance(card, Tag)
            else ""
        )
        coronavirus_card = False
        if isinstance(card, Tag):
            coronavirus_card = bool(
                heading_text == "latest coronavirus news"
                and (
                    "follow ft's live coverage" in card_text
                    or "follow ft’s live coverage" in card_text
                )
            ) or bool(
                heading_text == "read more about the impact of coronavirus"
                and (
                    "subscribers can use myft" in card_text
                    or len(card.select("a[href]")) >= 2
                )
            )
        coronavirus_editor_note = bool(
            isinstance(card, Tag)
            and heading_text in {"editor's note", "editor’s note"}
            and "the financial times is making key coronavirus coverage free "
            "to read" in card_text
        )
        if coronavirus_card or coronavirus_editor_note:
            card.decompose()
            continue
        if heading_text not in coronavirus_headings or isinstance(card, Tag):
            continue
        # One O3-era body flattened the coronavirus related-links card as
        # direct siblings. Remove only FT story/video links and the myFT CTA;
        # stop before author contacts or later reporting.
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            sibling_text = _clean_text(
                sibling.get_text(" ", strip=True)
            ).casefold()
            related_link = sibling.select_one(
                "a[href*='/content/'], a[href*='/video/']"
            )
            related_video = bool(
                "n-content-video" in " ".join(
                    sibling.get("class") or []
                ).casefold()
            )
            flattened_related_title = sibling_text in {
                "how markets woke up to the threat",
            }
            myft_cta = sibling_text.startswith(
                "subscribers can use myft to follow the latest "
            )
            if not (
                related_link is not None
                or related_video
                or flattened_related_title
                or myft_cta
            ):
                break
            sibling.decompose()
            sibling = next_sibling
        heading.decompose()
    for card in list(soup.select("experimental")):
        if card.select_one(
            "a[href*='ep.ft.com'][href*='newsletter'][href*='subscribe']"
        ):
            card.decompose()
    for paragraph in list(soup.select("p")):
        text = _clean_text(
            paragraph.get_text(" ", strip=True)
        ).casefold()
        if text == "coronavirus business update":
            sibling = paragraph.find_next_sibling()
            sibling_text = (
                _clean_text(sibling.get_text(" ", strip=True)).casefold()
                if isinstance(sibling, Tag)
                else ""
            )
            if "coronavirus newsletter" in sibling_text:
                paragraph.decompose()
                if isinstance(sibling, Tag):
                    sibling.decompose()
                continue
        if (
            text.startswith("sign up to ")
            and "must-read weekly briefing" in text
            and paragraph.select_one(
                "a[href*='ep.ft.com']"
                "[href*='newsletter'][href*='subscribe']"
            )
        ):
            paragraph.decompose()
            continue
        if (
            text.startswith("sign up for our ")
            and " newsletter" in text
            and len(text) <= 300
        ):
            paragraph.decompose()
    for heading in list(soup.select("h2, h3, h4, h5, h6")):
        if (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            != "related stories"
        ):
            continue
        sibling = heading.find_next_sibling()
        if isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            sibling.decompose()
        heading.decompose()
    # JSON-LD ``articleBody`` has no semantic heading tags. Some archived FT
    # pages append a recirculation heading plus one flattened paragraph of
    # story titles, which therefore arrives here as two ordinary ``p`` tags.
    # Treat the exact standalone marker as a tail boundary only when it has a
    # following sibling; prose that merely mentions related stories remains.
    for marker in list(soup.select("p")):
        if (
            _clean_text(marker.get_text(" ", strip=True)).casefold()
            != "related stories"
        ):
            continue
        sibling = marker.find_next_sibling()
        if not isinstance(sibling, Tag):
            continue
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            sibling.decompose()
            sibling = next_sibling
        marker.decompose()
    for heading in list(soup.select("h2, h3, h4")):
        heading_text = _clean_text(
            heading.get_text(" ", strip=True)
        ).casefold()
        card = heading.find_parent(
            class_=lambda value: value and "n-content-layout" in value
        )
        if not isinstance(card, Tag):
            continue
        card_text = _clean_text(card.get_text(" ", strip=True)).casefold()
        if (
            "newsletter" in heading_text
            or (
                heading_text == "house & home unlocked"
                and "newsletter" in card_text
            )
        ):
            card.decompose()
    cta_patterns = (
        re.compile(r"(?i)^sign up here with one click\b"),
        re.compile(r"(?i)^sign up here[.!]?$"),
        re.compile(
            r"(?i)^sign up for the newsletter by clicking here\b"
        ),
    )
    promo_patterns = (
        re.compile(r"(?i)\bnewsletter\b"),
        re.compile(r"(?i)\bin your inbox\b"),
        re.compile(r"(?i)^track trends in tech, media and telecoms\b"),
        re.compile(r"(?i)^house\s*&\s*home unlocked$"),
        re.compile(r"(?i)^follow @ft"),
    )
    direct_promo_patterns = (
        re.compile(
            r"(?i)^lex recommends the ft(?:'s|’s) .*newsletter\b"
        ),
        re.compile(
            r"(?i)^do you want to receive lex in your inbox\?\s*"
            r"sign up for the weekly best of lex email\b"
        ),
        re.compile(r"(?i)^our popular newsletter .*sign\s*up\s*here\b"),
        re.compile(
            r"(?i)^find out about our latest stories first\s*[—-]\s*"
            r"follow\s+@ftproperty\b"
        ),
        re.compile(r"(?i)^subscribers can use myft to follow\b"),
        re.compile(r"(?i)^follow ft(?:'s|’s) live coverage\b"),
        re.compile(r"(?i)^follow @ft"),
        re.compile(r"(?i)^join our online book group\b"),
        re.compile(
            r"(?i)^the ft is free to read today\.\s*"
            r"you can share this article\b"
        ),
        re.compile(
            r"(?i)^(?:just\s+)?high quality global journalism "
            r"requires investment\.\s*please share this article "
            r"with others using the link below\b.*"
            r"(?:copyright policy|ftsales\.support@ft\.com)\b"
        ),
        re.compile(
            r"(?i)^the financial times is making key coronavirus "
            r"coverage free to read\b"
        ),
        re.compile(
            r"(?i)^if you are a subscriber and would like to receive "
            r"alerts when lex articles are published\b"
        ),
        re.compile(r"(?i)^follow .+ with\s*myft and on\s*twitter\b"),
        re.compile(r"(?i)^sign up to our .+ newsletter\b"),
        re.compile(
            r"(?i)^sign up for the ft business school briefing\b.*"
        ),
        re.compile(r"(?i)^for more, sign up for our .+ newsletter\b"),
        re.compile(r"(?i)^ft premium subscribers can sign up here\b"),
        re.compile(r"(?i)^lex publishes two popular newsletters\b"),
        re.compile(
            r"(?i)^house\s*&\s*home unlocked\b.*\b"
            r"(?:newsletter|sign up)\b"
        ),
        re.compile(
            r"(?i)^ft subscribers can sign up for the email version\b"
        ),
        re.compile(
            r"(?i)^ft subscribers can click here to receive .* by email\b"
        ),
        re.compile(
            r"(?i)^coronavirus business update\s+sign up here "
            r"for our newsletter\b"
        ),
        re.compile(
            r"(?i)^we(?:'|’)re offering a free \d+-day trial to "
            r"coronavirus business update\b.*\bthey can sign up here\b"
        ),
        re.compile(
            r"(?i)^subscribe to the financial times chatbot here\.?\s*"
            r"it[’']s best viewed on a mobile device\.?$"
        ),
    )
    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if any(pattern.search(text) for pattern in direct_promo_patterns):
            node.decompose()
            continue
        if not any(pattern.search(text) for pattern in cta_patterns):
            continue
        previous = node.find_previous_sibling()
        for _ in range(4):
            if not isinstance(previous, Tag):
                break
            earlier = previous.find_previous_sibling()
            previous_text = _clean_text(
                previous.get_text(" ", strip=True)
            )
            if not any(
                pattern.search(previous_text)
                for pattern in promo_patterns
            ):
                break
            previous.decompose()
            previous = earlier
        node.decompose()


def _strip_ft_copyright_suffixes(soup: BeautifulSoup) -> None:
    """Remove syndication copyright footers without dropping article prose."""
    pattern = re.compile(
        r"""(?isx)
        \s*
        (?:data\s+visualisation\s+by\s+and\s+)?
        (?:[_–—−-]\s*)?
        \(?\s*copyright\s+(?:the\s+)?financial\s+times\s+limited
        (?:\s+\d{4})?
        (?:\.\s*all\s+rights\s+reserved\.|\.)?
        \s*\)?
        (?:\s*/\s*(?:bloomberg|new\s+york\s+times))?
        (?:\s+(?:share|join)\b.*)?
        \s*$
        """
    )
    for text_node in list(soup.find_all(string=pattern)):
        cleaned = pattern.sub("", str(text_node)).rstrip()
        if cleaned:
            text_node.replace_with(cleaned)
        else:
            text_node.extract()
    # Licensed partners often split one legal footer across italic and link
    # nodes (for example "Copyright The" + "Financial Times Limited" +
    # the year).  Match the rendered block as a fallback, while preserving
    # any real sentence that precedes the suffix.
    for node in list(soup.select("p, li")):
        text = _clean_text(node.get_text(" ", strip=True))
        cleaned = pattern.sub("", text).rstrip()
        if cleaned == text:
            continue
        if cleaned:
            node.clear()
            node.string = cleaned
        else:
            node.decompose()
    for node in list(soup.select("p")):
        if _clean_text(node.get_text(" ", strip=True)) == ".":
            node.decompose()


def _remove_ap_body_promos(soup: BeautifulSoup) -> None:
    """Remove AP calls-to-action embedded as legacy body paragraphs."""
    for module in list(
        soup.select(
            ".article-share, .sharedaddy, .sd-sharing, .item-newsletter, "
            ".PagePromo"
        )
    ):
        module.decompose()
    for node in list(
        soup.select(
            "#hn-headline, .hn-byline, #hn-distributor-copyright, "
            ".contin_below, .adver_cont_below, .mid_article_ad_label, "
            ".ad_wrapper"
        )
    ):
        node.decompose()
    for node in list(soup.select("[data-ap-readmore]")):
        node.decompose()
    for node in list(soup.select("form, input, select, textarea")):
        node.decompose()
    for button in list(soup.select("button")):
        button.decompose()

    # Some AP live-update/gallery stories include a plain ``Read more:``
    # paragraph followed by a run of related-story links and an ``___``
    # separator.  Those links are navigation chrome, not part of the wire
    # copy.  Remove the complete contiguous module while retaining the next
    # live-update heading and its substantive paragraphs.
    for marker in list(soup.select("p")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != (
            "read more:"
        ):
            continue
        sibling = marker.find_next_sibling()
        marker.decompose()
        while isinstance(sibling, Tag):
            next_sibling = sibling.find_next_sibling()
            text = _clean_text(sibling.get_text(" ", strip=True))
            sibling.decompose()
            if text == "___":
                break
            sibling = next_sibling

    # AP's syndicated legacy body uses inline ``RELATED`` link labels as
    # navigation chrome.  Keep the linked headline that follows, but remove
    # the standalone interface marker from the normalized prose.
    for marker in list(soup.select(".LinkEnhancement")):
        if _clean_text(marker.get_text(" ", strip=True)).rstrip(":").casefold() != "related":
            continue
        parent = marker.parent
        marker.decompose()
        if isinstance(parent, Tag) and not _clean_text(parent.get_text(" ", strip=True)):
            parent.decompose()

    patterns = (
        re.compile(
            r"(?i)\bsign up for (?:the )?ap(?:'s|’s) .*newsletter\b"
        ),
        re.compile(
            r"(?i)^sign up for .{0,120}\bnewsletter\b.{0,120}"
            r"\b(?:the )?ap(?:'s|’s)\b"
        ),
        re.compile(
            r"(?i)^for more lottery results,\s*go to jackpot\.com\b"
        ),
        re.compile(
            r"(?i)^(?:more\s+)?ap\s+(?:mlb|nfl|soccer|golf|nba|nhl|"
            r"college football)\s*:\s*https?://apnews\.com/hub/\S+"
            r"(?:\s+and\s+https?://(?:(?:www\.)?(?:twitter|x)\.com/|"
            r"apnews\.com/hub/)\S+)*\s*$"
        ),
        re.compile(
            r"(?i)^[▶►]?\s*view and download the (?:men(?:'|’)s|women(?:'|’)s) "
            r"ncaa tournament bracket\s*$"
        ),
    )
    for row in list(soup.select("tr")):
        cells = [
            _clean_text(cell.get_text(" ", strip=True))
            for cell in row.select(":scope > th, :scope > td")
        ]
        if cells and all(
            not text
            or re.fullmatch(r"[_=—–-]+", text)
            or re.fullmatch(r"[•·]{2,}", text)
            for text in cells
        ):
            row.decompose()
    for table in list(soup.select("table")):
        if not _clean_text(table.get_text(" ", strip=True)):
            table.decompose()

    for node in list(soup.select("p")):
        text = _clean_text(node.get_text(" ", strip=True))
        if (
            text == "."
            or re.fullmatch(r"[_=—–-]+", text)
            or re.fullmatch(r"[•·]{2,}", text)
            or text in {"<", ">"}
        ):
            node.decompose()
            continue
        if not any(pattern.search(text) for pattern in patterns):
            continue
        previous = node.find_previous_sibling()
        for _ in range(4):
            if not isinstance(previous, Tag):
                break
            earlier = previous.find_previous_sibling()
            if _clean_text(previous.get_text(" ", strip=True)) == "___":
                previous.decompose()
            previous = earlier
        node.decompose()


def _trim_reuters_recirculation_tail(soup: BeautifulSoup) -> None:
    """Drop modern Reuters recommendation modules appended inside body."""
    markers = list(
        soup.select(
            "[data-testid='Latest Updates'], "
            "[data-variant-id='article-latest-updates'], "
            "[class*='read-next-mobile__container']"
        )
    )
    for node in soup.select("p, div"):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if text.startswith(
            "our standards: the thomson reuters trust principles"
        ):
            markers.append(node)
    for node in soup.select("p"):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(r"<\^{10,}", text):
            markers.append(node)
            continue
        if (
            text.casefold() != "read more:"
        ):
            continue
        following_paragraphs = [
            sibling
            for sibling in node.find_next_siblings("p")
            if _clean_text(sibling.get_text(" ", strip=True))
        ]
        if len(following_paragraphs) >= 2:
            markers.append(node)
    if not markers:
        return
    top = soup.find()
    if not isinstance(top, Tag):
        return
    marker_ids = {id(marker) for marker in markers}
    marker = next(
        (
            node
            for node in top.descendants
            if isinstance(node, Tag) and id(node) in marker_ids
        ),
        None,
    )
    if not isinstance(marker, Tag):
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


def _normalize_reuters_legacy_press_release_media(
    soup: BeautifulSoup,
) -> None:
    """Restore Business Wire media nested inside one legacy body paragraph."""
    for media in list(soup.select("p > #bwbodyimg:has(img)")):
        paragraph = media.parent
        if not isinstance(paragraph, Tag) or paragraph.name != "p":
            continue

        before = BeautifulSoup("<p></p>", "html.parser").p
        after = BeautifulSoup("<p></p>", "html.parser").p
        if not isinstance(before, Tag) or not isinstance(after, Tag):
            continue

        before_nodes = list(media.previous_siblings)
        after_nodes = list(media.next_siblings)
        for node in before_nodes:
            before.append(node.extract())
        for node in after_nodes:
            after.append(node.extract())

        media.extract()
        media.name = "figure"
        caption = media.find("p")
        if isinstance(caption, Tag):
            caption.name = "figcaption"
            caption_text = _clean_text(caption.get_text(" ", strip=True))
            parenthetical_credit = re.fullmatch(
                r"(.+?)\s*\(((?:photographer|photo|credit|"
                r"illustration|graphic)s?\s*:\s*.+)\)",
                caption_text,
                flags=re.IGNORECASE,
            )
            if parenthetical_credit is not None:
                caption.string = (
                    f"{parenthetical_credit.group(1)}\n"
                    f"{parenthetical_credit.group(2)}"
                )

        if _clean_text(before.get_text(" ", strip=True)):
            paragraph.insert_before(before)
        paragraph.insert_before(media)
        if _clean_text(after.get_text(" ", strip=True)):
            paragraph.insert_before(after)
        paragraph.decompose()


def _nyt_legacy_recurring_columnist_portrait(url: str) -> bool:
    """Recognize legacy NYT columnist portraits reused across opinion pieces."""

    parts = urlsplit(url)
    if (parts.hostname or "").casefold() not in {
        "graphics8.nytimes.com",
        "static01.nyt.com",
    }:
        return False
    return bool(
        re.search(
            r"/images/\d{4}/\d{2}/\d{2}/opinion/"
            r"(?P<asset>[a-z0-9_-]+_new)/(?P=asset)-"
            r"(?:articleinline|thumblarge|thumbstandard|jumbo)(?:-v\d+)?"
            r"\.(?:avif|gif|jpe?g|png|webp)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    )


def _remove_nyt_body_chrome(soup: BeautifulSoup) -> None:
    """Drop a legacy NYT story header selected with the broad article body."""

    def trim_after_marker(marker: Tag) -> None:
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

    # The 2010-2014 template wraps ``header.story-header`` and the actual
    # story body in one ``article#story`` element.  When that broad wrapper is
    # the best recoverable body, the kicker, headline and byline would
    # otherwise become the first three content blocks even though each value
    # already has a structured top-level field.
    for header in list(soup.select("header.story-header, header#story-header")):
        header.decompose()

    # Legacy opinion columns append a standing author module after the final
    # editorial paragraph. It contains the columnist's blog and social-media
    # calls to action under ``authorIdentification``. The same class can also
    # hold a legitimate story-specific contributor credit, so require both
    # the standing invitation language and several explicit social profiles.
    for author_module in list(soup.select(".authorIdentification")):
        module_text = _clean_text(
            author_module.get_text(" ", strip=True)
        ).casefold()
        social_links = {
            urlsplit(str(anchor.get("href") or "")).hostname.casefold()
            for anchor in author_module.select("a[href]")
            if urlsplit(str(anchor.get("href") or "")).hostname
        }
        known_social_links = {
            host
            for host in social_links
            if host.endswith(
                (
                    "facebook.com",
                    "google.com",
                    "twitter.com",
                    "youtube.com",
                )
            )
        }
        if (
            "i invite you to visit my blog" in module_text
            and len(known_social_links) >= 2
        ):
            author_module.decompose()

    # TagDiv-based WordPress partners can select the complete page template
    # as the recoverable NYT body.  Their related-story title is followed by
    # next/previous navigation, a current-news sidebar and other unrelated
    # cards.  The exact title alone is not safe enough because an editorial
    # package may legitimately contain a "Related Stories" heading; require
    # the partner template's title/module classes and trim only at that
    # structural boundary.
    for heading in list(soup.select(".td-block-title")):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() != (
            "related stories"
        ):
            continue
        title_wrapper = heading.find_parent(class_="td-block-title-wrap")
        module = heading.find_parent(
            class_=lambda value: value
            and "td_block_title"
            in (value if isinstance(value, list) else [value])
        )
        if not isinstance(title_wrapper, Tag) or not isinstance(module, Tag):
            continue
        trim_after_marker(module)
        break

    # Older opinion templates place the columnist's standing portrait inside
    # every article body and also publish another rendition as structured lead
    # media.  The dated ``*_New`` asset family is reused across unrelated
    # columns, so it is author chrome rather than article-specific artwork.
    for image in list(soup.select("img[src]")):
        if not _nyt_legacy_recurring_columnist_portrait(
            str(image.get("src") or "")
        ):
            continue
        wrapper = image.find_parent("figure")
        if not isinstance(wrapper, Tag):
            wrapper = next(
                (
                    ancestor
                    for ancestor in image.parents
                    if isinstance(ancestor, Tag)
                    and any(
                        "articleinline" in str(name).casefold()
                        for name in (ancestor.get("class") or [])
                    )
                ),
                None,
            )
        (wrapper if isinstance(wrapper, Tag) else image).decompose()

    # Some Birdkit packages publish a series of profiles as separate article
    # URLs while embedding every profile in each HTML document.  The profile
    # belonging to the current URL is the only direct ``.leader.isFirst``
    # child; its siblings are cross-article navigation/content, not part of
    # this article.  Keep credits outside the leader list, since they apply to
    # the selected profile as well.
    for package in list(soup.select(".birdkit-body")):
        leaders = [
            child
            for child in package.find_all(recursive=False)
            if isinstance(child, Tag)
            and "leader" in (child.get("class") or [])
        ]
        current = [
            leader
            for leader in leaders
            if "isFirst" in (leader.get("class") or [])
        ]
        if len(leaders) < 3 or len(current) != 1:
            continue
        for leader in leaders:
            if leader is not current[0]:
                leader.decompose()
        for navigation in list(
            package.find_all(
                recursive=False,
                class_=lambda value: value
                and "map-container"
                in (value if isinstance(value, list) else [value]),
            )
        ):
            navigation.decompose()

    # The 2012-era multipage article template appends a numbered pagination
    # list to the selected article body.  Its stable id distinguishes the
    # control from genuine numbered editorial lists.
    for page_numbers in list(soup.select("#pageNumbers")):
        page_numbers.decompose()

    # Modern NYT articles can splice a promoted live-blog rail between two
    # genuine reporting paragraphs.  Its generated CSS classes vary, but the
    # complementary landmark and the heading it labels are stable.  Remove
    # only that self-contained rail: Morning Briefing headings such as
    # ``THE LATEST NEWS`` and ``Now Time to Play`` are editorial sections and
    # deliberately do not match this selector.
    for module in list(
        soup.select(
            "[role='complementary']"
            "[aria-labelledby='storyline-latest-updates']"
        )
    ):
        module.decompose()

    # NYT election-result pages place two large live-update/recirculation
    # rails around the race-specific tables and append a navigation footer.
    # Generated CSS classes change between snapshots, but their links retain
    # the election module's semantic query parameters. Remove the enclosing
    # module so tens of thousands of characters from unrelated races do not
    # overwhelm the actual district result or make distinct races appear to
    # be duplicate articles.
    for listing in list(soup.select("ul, ol")):
        recirculation_links = [
            link
            for link in listing.select("a[href]")
            if any(
                marker in str(link.get("href") or "").casefold()
                for marker in (
                    "context=election_recirc",
                    "region=stateresultsfooter",
                )
            )
        ]
        if len(recirculation_links) < 2:
            continue
        wrapper = listing.find_parent(class_="buttons-and-updates")
        if not isinstance(wrapper, Tag):
            wrapper = listing.find_parent(class_="footer")
        (wrapper if isinstance(wrapper, Tag) else listing).decompose()

    # The 2022 election package inserted a first-party cross-promotion rail
    # between the race timing and result-analysis modules. It advertises
    # Wordle, Cooking and newsletters and is explicitly marked as a
    # complementary landmark. Keep other complementary editorial callouts;
    # the stable ``links-of-joy`` child and exact heading identify this rail.
    for module in list(soup.select("[role='complementary']")):
        heading = module.select_one("h1, h2, h3, h4, h5, h6")
        heading_text = (
            _clean_text(heading.get_text(" ", strip=True)).casefold()
            if isinstance(heading, Tag)
            else ""
        )
        if (
            module.select_one(".links-of-joy") is not None
            and heading_text.startswith("while you’re waiting for results")
        ):
            module.decompose()

    # The same package appends a reporter-analysis recirculation component to
    # every individual race page. Its heading survives even when the cards
    # themselves are script-rendered, making unrelated races share identical
    # body text. Remove only the self-contained component with the package's
    # semantic header class; ordinary editorial headings remain untouched.
    for heading in list(soup.select(".visual-updates-hed")):
        heading_text = _clean_text(
            heading.get_text(" ", strip=True)
        ).casefold()
        if not heading_text.startswith("analyzing the vote"):
            continue
        component = heading.find_parent(
            class_=lambda value: value
            and "e-cmp" in (value if isinstance(value, list) else [value])
        )
        (component if isinstance(component, Tag) else heading).decompose()

    # Newer election pages dropped the semantic query markers from their
    # navigation footer. The generated CSS class changes, but the nested
    # ``footer-content-wrapper`` and dated General Election heading remain
    # stable. This is cross-race navigation, not the current result record.
    for footer in list(soup.select(".footer")):
        if footer.select_one(".footer-content-wrapper") is None:
            continue
        heading = footer.select_one("h1, h2, h3, h4, h5, h6")
        if not isinstance(heading, Tag):
            continue
        if re.fullmatch(
            r"20\d{2}\s+general election results",
            _clean_text(heading.get_text(" ", strip=True)).casefold(),
        ):
            footer.decompose()

    # Legacy NYT list articles used punctuation-only paragraphs as editorial
    # section breaks.  Preserve their position as semantic dividers instead
    # of leaking several slightly different dash runs into plain text.
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        if re.fullmatch(r"[—–-]{3,}", text):
            paragraph.clear()
            paragraph.name = "hr"

    # Legacy interactive packages can splice first-party promotion modules
    # into the middle of otherwise valid long-form reporting. Remove the
    # complete module so its heading, summary and tiny album-art image cannot
    # be serialized as editorial body content.
    for node in list(
        soup.select(
            "#interactive-news-tips-article-promo, "
            "[id^='interactive-20DAILY-player' i]"
        )
    ):
        node.decompose()

    # Some Morning Briefing templates append this client-support notice after
    # the editorial footer. It is application UI, not part of the briefing.
    for node in list(soup.select("p, li, div")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"(?i)if photographs appear out of order\s*,?\s*"
            r"please download the updated new york times app from "
            r"itunes or google play\s*\.?",
            text,
        ):
            node.decompose()

    # Election-result interactives append one or more recirculation rails
    # headed ``Latest updates``.  Modern NYT results pages render both a
    # mobile rail before the result tables and a desktop rail after them.
    # Removing everything after the first heading therefore destroys the
    # tables and collapses the interactive to its lede.  Remove the enclosing
    # reporter-update module instead; keep the fallback for older templates
    # that expose only a bare trailing heading.
    for marker in list(soup.select("h1, h2, h3, h4, h5, h6")):
        if _clean_text(marker.get_text(" ", strip=True)).casefold() != (
            "latest updates"
        ):
            continue
        reporter_module = marker.find_parent(
            class_=lambda value: value
            and "e-cmp-reporter-updates"
            in (value if isinstance(value, list) else [value])
        )
        if isinstance(reporter_module, Tag):
            reporter_module.decompose()
        else:
            trim_after_marker(marker)

    # The 2020 pandemic template appended the same generic FAQ package to
    # unrelated stories. Keep the article above the package, but not the
    # reusable outbreak explainer and its navigation links.
    for marker in list(soup.select("p, h2, h3, h4, h5")):
        text = _clean_text(marker.get_text(" ", strip=True)).casefold()
        if re.fullmatch(r"the coronavirus outbreak\s*[›>]?(?:\s*)", text):
            trim_after_marker(marker)

    # On Politics articles also flatten their newsletter sign-up paragraph
    # into the story body. It is interface copy, not reporting.
    newsletter_patterns = (
        re.compile(
            r"(?i)^on politics is also available as a newsletter\.\s*"
            r"sign up here to get it delivered to your inbox\.?$"
        ),
        re.compile(
            r"(?i)^sign up here to get on politics in your inbox every weekday\.?$"
        ),
    )
    for paragraph in list(soup.select("p, li")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        if any(pattern.fullmatch(text) for pattern in newsletter_patterns):
            paragraph.decompose()


def _trim_nyt_access_shell_tail(soup: BeautifulSoup) -> None:
    """Remove verification/paywall UI appended after a recovered NYT body."""
    marker = next(
        (
            node
            for node in soup.select("p, div")
            if _clean_text(node.get_text(" ", strip=True))
            .casefold()
            .startswith(
                "thank you for your patience while we verify access"
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


def _remove_zaobao_body_chrome(soup: BeautifulSoup) -> None:
    """Remove site-wide controls embedded in legacy Zaobao article wrappers."""

    # Drupal-era comic and visual pages can leave the editorial picture only
    # in ``<source data-srcset>`` nodes, without an ``<img>`` fallback.  Block
    # extraction intentionally works from images, so materialize the first
    # publisher rendition before removing the surrounding page controls.  The
    # source list is ordered from the largest desktop rendition down to the
    # transparent placeholder in these archived templates.
    for picture in soup.select("picture"):
        if any(
            isinstance(value, str)
            and value.strip()
            and not value.strip().casefold().startswith("data:")
            for image in picture.select("img")
            for attribute in ("src", "data-src", "srcset", "data-srcset")
            if (value := image.get(attribute)) is not None
        ):
            continue
        source_url = next(
            (
                url
                for source in picture.select("source")
                for url in _image_urls(
                    source,
                    base_url="https://www.zaobao.com.sg/",
                )
                if not _zaobao_non_editorial_image_url(url)
            ),
            None,
        )
        if not source_url:
            continue
        # BeautifulSoup's body-copy round trip can read the ``&times`` prefix
        # in an unescaped Drupal ``&timestamp=`` srcset parameter as the
        # multiplication entity. Restore it long enough to parse the query,
        # then discard that non-semantic cache-busting timestamp.
        source_url = re.sub(
            r"×tamp=",
            "&timestamp=",
            source_url,
            flags=re.IGNORECASE,
        )
        source_parts = urlsplit(source_url)
        source_query = [
            (key, value)
            for key, value in parse_qsl(
                source_parts.query,
                keep_blank_values=True,
            )
            if key.casefold() != "timestamp"
        ]
        source_url = urlunsplit(
            source_parts._replace(
                query=urlencode(source_query)
            )
        )
        image = soup.new_tag("img", src=source_url)
        title = _string_or_none(picture.get("title"))
        if title:
            image["alt"] = title
        picture.append(image)

    # Archived Zaobao pages commonly place share/follow and newsletter
    # controls inside the same ``article`` node as the historical body.
    # They are not editorial blocks and otherwise fail the normalized-body
    # interactive-tag audit.
    for node in list(soup.select("button, form, input, select, textarea")):
        node.decompose()

    # Freemium snapshots put the subscription roadblock and its generic
    # fallback artwork inside the same article wrapper as the recovered
    # paragraphs. Keep the editorial prose, but never archive the paywall UI
    # or its repeated default images as article content.
    for node in list(
        soup.select(
            "#freemium_subscribe, .freemium_subscribe, "
            ".microtransaction-body, .microtransaction-option, "
            ".article-microtransaction, .cta-subscribe, "
            ".overlay-microtransaction, "
            ".paywall-message, "
            "#related-articles, #mobile-recommend-articles, "
            ".bff-recommend-article"
        )
    ):
        node.decompose()
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True))
        direct_text = paragraph.string
        repeated_suffix_length = _terminal_tandem_repeat_length(text)
        if (
            repeated_suffix_length
            and isinstance(direct_text, NavigableString)
        ):
            # A small number of Drupal-era snapshots contain a damaged final
            # paragraph whose terminal clause was appended twice inside the
            # publisher's own HTML. Only repair an exact, long tandem suffix
            # in a text-only paragraph; preserving nested inline markup is
            # safer than attempting a lossy tree rewrite.
            direct_text.replace_with(text[:-repeated_suffix_length].rstrip())
            text = text[:-repeated_suffix_length].rstrip()
        if (
            text.startswith("此文章为早报")
            and "专享内容" in text
        ) or text in {
            "请您选择以下方式，阅读全文：",
            "已是早报订户，请您登录后继续阅读全文。",
        } or text.startswith("新用户体验价"):
            paragraph.decompose()
            continue
        if re.fullmatch(
            r"点击\s*《联合早报》世界杯专页\s*[，,]\s*"
            r"获知世界杯比分、赛程和最新新闻等资讯[。.]?",
            text,
        ):
            # This site-wide World Cup cross-promotion is injected as a plain
            # emphasized paragraph inside otherwise editorial article HTML.
            # Match the complete sentence only so genuine World Cup reporting
            # and links remain untouched.
            paragraph.decompose()
    for node in list(soup.select("p, h1, h2, h3, h4, h5, h6")):
        text = _clean_text(node.get_text(" ", strip=True))
        if re.fullmatch(
            r"请\s*like\s*我们的官方面簿网页以获取更多新信息\s*[。.]?",
            text,
            flags=re.IGNORECASE,
        ) or re.fullmatch(r"热词\s*[:：]", text):
            # The Drupal-era article wrapper flattened the site-wide
            # Facebook CTA and keyword-panel heading into ordinary editorial
            # blocks.  Neither is story text; keyword values remain available
            # from metadata rather than this empty UI label.
            node.decompose()
    for image in list(soup.select("img")):
        urls = _image_urls(image, base_url="https://www.zaobao.com.sg/")
        if not urls or not all(
            _zaobao_non_editorial_image_url(url) for url in urls
        ):
            continue
        container = image.find_parent(("figure", "a"))
        image.decompose()
        if (
            isinstance(container, Tag)
            and not container.get_text(" ", strip=True)
            and not container.select_one("img")
        ):
            container.decompose()


def _terminal_tandem_repeat_length(value: str) -> int:
    """Return the length of a long exact suffix repeated back-to-back."""

    normalized = _clean_text(value)
    punctuation = set("，,；;：:。！？.!?")
    for length in range(len(normalized) // 2, 23, -1):
        repeated = normalized[-length:]
        if (
            normalized[-2 * length : -length] == repeated
            and repeated[-1:] in punctuation
            and sum(character in punctuation for character in repeated) >= 2
        ):
            return length
    return 0


def _remove_aljazeera_body_chrome(soup: BeautifulSoup) -> None:
    """Remove legacy Al Jazeera recirculation modules from story bodies."""

    # Migrated 2010-era pages preserve sidebar/recirculation tables inside
    # ``wysiwyg--all-content``.  Their header cell is a stable discriminator;
    # removing arbitrary tables would also destroy genuine editorial data.
    for header in list(soup.select("td.Skyscrapper_Header")):
        if _clean_text(header.get_text(" ", strip=True)).casefold() not in {
            "special report",
            "in depth",
        }:
            continue
        table = header.find_parent("table")
        if isinstance(table, Tag):
            table.decompose()

    # Several migrated 2015 pages embed the same "New to Al Jazeera?" promo
    # cards as ordinary body images.  Keep surrounding editorial prose and
    # legitimate infographics while dropping only the confirmed shared assets.
    for image in list(soup.select("img")):
        urls = _image_urls(
            image,
            base_url="https://www.aljazeera.com/",
        )
        if not urls or not all(
            _aljazeera_non_editorial_image_url(url) for url in urls
        ):
            continue
        container = image.find_parent(("figure", "a"))
        image.decompose()
        if (
            isinstance(container, Tag)
            and not container.get_text(" ", strip=True)
            and not container.select_one("img")
        ):
            container.decompose()

    # Legacy story exports insert one or more related-story lists in the
    # middle of the article.  The tracking campaign is a narrow discriminator
    # for this publisher module; an ordinary editorial heading named "More"
    # without those links remains untouched.
    for heading in list(soup.select("p, h2, h3, h4, h5, h6")):
        if _clean_text(heading.get_text(" ", strip=True)).casefold() not in {
            "more",
            "more:",
        }:
            continue
        related_lists: list[Tag] = []
        sibling = heading.find_next_sibling()
        while isinstance(sibling, Tag) and sibling.name in {"ul", "ol"}:
            if not sibling.select_one(
                "a[href*='utm_campaign=read_more_links']"
            ):
                break
            related_lists.append(sibling)
            sibling = sibling.find_next_sibling()
        if not related_lists:
            continue
        heading.decompose()
        for listing in related_lists:
            listing.decompose()


def _remove_caixin_body_chrome(soup: BeautifulSoup) -> None:
    """Remove legacy Caixin print controls and subscription QR images."""

    legacy_body = soup.select_one("#Main_Content_Val")
    if isinstance(legacy_body, Tag):
        # Caixin's legacy CMS often emitted the lead or even the entire short
        # report as a direct text node beside a bold byline. The common block
        # extractor deliberately ignores loose text, so preserve these nodes
        # in document order as ordinary paragraphs before block extraction.
        for child in list(legacy_body.children):
            if not isinstance(child, NavigableString) or isinstance(
                child, Comment
            ):
                continue
            text = _clean_text(str(child))
            if len(text) < 2:
                continue
            paragraph = soup.new_tag("p")
            paragraph.string = text
            child.replace_with(paragraph)
    for node in list(soup.select(".fullUrl, #jumpurl, .yinduBottom")):
        node.decompose()
    for paragraph in list(soup.select("p")):
        text = _clean_text(paragraph.get_text(" ", strip=True)).casefold()
        if re.fullmatch(r"[（(]\s*财新记者[^()（）]{1,120}[)）]", text):
            # Older Caixin pages repeat the reporter credit as a standalone
            # paragraph inside the article body. The canonical byline is
            # already extracted from page metadata, so this is template
            # chrome rather than reporting prose.
            paragraph.decompose()
            continue
        if (
            text.startswith("欢迎关注财新网")
            and ("公号" in text or "公众号" in text)
        ) or (
            text.startswith("《知识分子》是由")
            and "移动新媒体平台" in text
        ) or (
            text.startswith("撰写：财小智")
            and "责编：财小新" in text
        ) or (
            text.startswith("今日敏感舆情指数")
            and "财新数据" in text
        ):
            # These recurring paragraphs are account promotion or generated
            # data-service notices embedded by Caixin's section templates.
            paragraph.decompose()
            continue
        if (
            text.startswith("推荐进入")
            and "财新数据库" in text
            and "可随时查阅" in text
        ) or (
            text.startswith("本文内容精选自财新高端订阅产品")
            and "财新数据通" in text
        ) or text.startswith(">>更多精彩内容请点击"):
            # Current and legacy Caixin pages append subscription marketing
            # inside the article wrapper. It is site chrome, not reporting.
            container = paragraph.find_parent(
                ("div", "aside"), class_=lambda value: value and "lanmu_textend" in value
            )
            if isinstance(container, Tag):
                container.decompose()
            else:
                paragraph.decompose()
            continue
        if (
            text.startswith("更多报道详见：")
            and paragraph.select_one(
                "a[href*='caixin.com/'][href*='/2013lh/']"
            )
        ):
            # Legacy 2013 reports appended a cross-site Two Sessions topic
            # link inside the broad article node. It is recirculation, not a
            # sentence from the report.
            paragraph.decompose()
            continue
        if text.startswith("marketwatch拥有位于三大洲的100多名记者"):
            # Caixin appended the same corporate description to syndicated
            # MarketWatch stories. Preserve the preceding original-URL
            # attribution, but do not treat this publisher boilerplate as
            # article prose.
            paragraph.decompose()
    for image in list(soup.select("img")):
        urls = _image_urls(
            image,
            base_url="https://www.caixin.com/",
        )
        if not urls or not all(
            _caixin_non_editorial_image_url(url) for url in urls
        ):
            continue
        container = image.find_parent("figure")
        image.decompose()
        if (
            isinstance(container, Tag)
            and not _clean_text(container.get_text(" ", strip=True))
        ):
            container.decompose()


def _caixin_legacy_gallery_body(soup: BeautifulSoup) -> Tag | None:
    """Convert Caixin's table-based photo channel into semantic figures."""

    source = soup.select_one("#pic_content")
    if not isinstance(source, Tag):
        return None
    document = BeautifulSoup(
        "<article data-jojo-source='caixin-legacy-gallery'></article>",
        "html.parser",
    )
    wrapper = document.select_one("article")
    if not isinstance(wrapper, Tag):
        return None
    for item in source.find_all("li", recursive=False):
        if not isinstance(item, Tag):
            continue
        image = next(
            (
                node
                for node in item.select(".imgBox img[src], img[src]")
                if isinstance(node, Tag)
                and not _caixin_non_editorial_image_url(
                    _normalized_url(
                        node.get("src"),
                        base_url="https://photos.caixin.com/",
                    )
                    or ""
                )
            ),
            None,
        )
        if not isinstance(image, Tag):
            continue
        figure = document.new_tag("figure")
        copied_image = document.new_tag("img")
        copied_image.attrs = dict(image.attrs)
        figure.append(copied_image)
        image_row = image.find_parent("tr")
        caption_row = (
            image_row.find_next_sibling("tr")
            if isinstance(image_row, Tag)
            else None
        )
        caption = (
            _clean_text(caption_row.get_text(" ", strip=True))
            if isinstance(caption_row, Tag)
            else ""
        )
        if not caption:
            caption = _clean_text(
                _tag_text(item.select_one("#subhead, .title")) or ""
            )
        if caption:
            figcaption = document.new_tag("figcaption")
            figcaption.string = caption
            figure.append(figcaption)
        wrapper.append(figure)
    return wrapper if wrapper.select_one("figure img") else None


def _caixin_legacy_gallery_expected_images(soup: BeautifulSoup) -> int:
    # The counter is a loose text node beside the controls in some snapshots,
    # not a descendant of `.op`; inspect the complete editorial wrapper.
    counter = _clean_text(_tag_text(soup.select_one(".focusBody")) or "")
    matches = re.findall(r"(?<!\d)\d+\s*/\s*(\d+)(?!\d)", counter)
    return max((int(value) for value in matches), default=1)


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


def _extract_blocks(
    body: BeautifulSoup,
    *,
    base_url: str,
    spec: PublisherSpec,
    starting_position: int,
    preserve_nyt_interactive_caption_prose: bool = False,
) -> tuple[list[ContentBlock], list[ImageCandidate]]:
    blocks: list[ContentBlock] = []
    images: list[ImageCandidate] = []
    selectors = [
        "p",
        "pre",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "figure",
        "img",
        "table",
        "hr",
        "iframe",
        "audio",
        "amp-brightcove",
        *spec.text_block_selectors,
    ]
    selected = body.select(", ".join(selectors))
    publisher_text_node_ids = {
        id(node)
        for selector in spec.text_block_selectors
        for node in body.select(selector)
    }
    for node in selected:
        has_selected_ancestor = _has_selected_ancestor(
            node,
            body,
            publisher_text_node_ids=publisher_text_node_ids,
        )
        nyt_interactive_caption_prose = bool(
            preserve_nyt_interactive_caption_prose
            and node.name == "p"
            and isinstance((figcaption := node.find_parent("figcaption")), Tag)
            and isinstance(node.find_parent("figure"), Tag)
            and len(figcaption.select("p")) >= 2
        )
        scmp_associated_media_image = bool(
            spec.publisher == "scmp"
            and node.name == "img"
            and node.get("data-jojo-scmp-associated-media") == "true"
            and isinstance(node.find_parent("p"), Tag)
            and node.find_parent("figure") is None
        )
        if (
            has_selected_ancestor
            and not nyt_interactive_caption_prose
            and not scmp_associated_media_image
        ):
            continue
        position = starting_position + len(blocks)
        name = node.name.lower()
        if name in {"p", "pre"}:
            text = _clean_text(node.get_text(" ", strip=True))
            bloomberg_embed = (
                node.select_one("a.bbg-embed[href]")
                if spec.publisher == "bloomberg" and name == "p"
                else None
            )
            if isinstance(bloomberg_embed, Tag) and text == _clean_text(
                bloomberg_embed.get_text(" ", strip=True)
            ):
                source = _normalized_url(
                    bloomberg_embed.get("href"),
                    base_url=base_url,
                )
                if source:
                    blocks.append(
                        ContentBlock(
                            type=BlockType.EMBED,
                            position=position,
                            embed_url=source,
                            html=str(node),
                        )
                    )
                    continue
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.PARAGRAPH,
                        position=position,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"div", "span"} and id(node) in publisher_text_node_ids:
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                event = node.find_parent("article")
                is_heading = bool(
                    isinstance(event, Tag)
                    and "title" in (event.get("class") or [])
                )
                blocks.append(
                    ContentBlock(
                        type=(
                            BlockType.HEADING
                            if is_heading
                            else BlockType.PARAGRAPH
                        ),
                        position=position,
                        level=2 if is_heading else None,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"h2", "h3", "h4", "h5", "h6"}:
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.HEADING,
                        position=position,
                        level=int(name[1]),
                        text=text,
                        html=str(node),
                    )
                )
        elif name == "blockquote":
            text = _clean_text(node.get_text(" ", strip=True))
            if text:
                blocks.append(
                    ContentBlock(
                        type=BlockType.QUOTE,
                        position=position,
                        text=text,
                        html=str(node),
                    )
                )
        elif name in {"ul", "ol"}:
            items = [
                _clean_text(item.get_text(" ", strip=True))
                for item in node.find_all("li", recursive=False)
            ]
            items = [item for item in items if item]
            if items:
                blocks.append(
                    ContentBlock(
                        type=BlockType.LIST,
                        position=position,
                        text="\n".join(items),
                        items=items,
                        html=str(node),
                    )
                )
        elif name in {"figure", "img"}:
            image_nodes = (
                [node]
                if name == "img"
                else [
                    image_node
                    for image_node in node.find_all("img")
                    if image_node.find_parent("figure") is node
                ]
            )
            # Legacy NYT embedded graphics can place several independent
            # chart images inside one layout figure.  The generic figure
            # path historically retained only ``find('img')`` and silently
            # discarded every later chart.  Expand this narrowly for NYT;
            # other publishers' gallery-specific paths remain authoritative.
            if spec.publisher != "nyt":
                image_nodes = image_nodes[:1]
            for image_node in image_nodes:
                image_container = node
                if name == "figure" and len(image_nodes) > 1:
                    image_container = _nyt_multi_image_figure_container(
                        image_node,
                        figure=node,
                    )
                image = _image_from_tag(
                    image_node,
                    container=image_container,
                    base_url=base_url,
                    spec=spec,
                )
                if not image:
                    continue
                images.append(image)
                blocks.append(
                    ContentBlock(
                        type=BlockType.IMAGE,
                        position=starting_position + len(blocks),
                        asset_id=image.asset_id,
                        caption=image.caption,
                        credit=image.credit,
                        html=str(image_container),
                    )
                )
        elif name == "table":
            text = _clean_text(node.get_text(" ", strip=True))
            blocks.append(
                ContentBlock(
                    type=BlockType.TABLE,
                    position=position,
                    text=text or None,
                    html=str(node),
                )
            )
        elif name == "hr":
            blocks.append(ContentBlock(type=BlockType.DIVIDER, position=position))
        elif name == "iframe":
            source = _normalized_url(node.get("src"), base_url=base_url)
            if source:
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
        elif name == "audio":
            source_node = node.select_one("source[src]")
            source_value = (
                source_node.get("src")
                if isinstance(source_node, Tag)
                else node.get("src")
            )
            source = _normalized_url(source_value, base_url=base_url)
            if source:
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
        elif name == "amp-brightcove":
            account = _string_or_none(node.get("data-account"))
            player = _string_or_none(node.get("data-player")) or "default"
            embed = _string_or_none(node.get("data-embed")) or "default"
            video_id = _string_or_none(node.get("data-video-id"))
            if account and video_id:
                source = (
                    f"https://players.brightcove.net/{account}/"
                    f"{player}_{embed}/index.html?videoId={video_id}"
                )
                blocks.append(
                    ContentBlock(
                        type=BlockType.EMBED,
                        position=position,
                        embed_url=source,
                        html=str(node),
                    )
                )
    return blocks, images


def _nyt_multi_image_figure_container(
    image: Tag,
    *,
    figure: Tag,
) -> Tag:
    """Find the per-image wrapper and caption in a legacy NYT figure."""

    candidate = image.parent
    while isinstance(candidate, Tag) and candidate is not figure:
        if (
            len(candidate.select("img")) == 1
            and candidate.select_one(
                "figcaption, [class*='caption' i], [class*='credit' i]"
            )
            is not None
        ):
            return candidate
        candidate = candidate.parent
    return figure


def _has_selected_ancestor(
    node: Tag,
    body: BeautifulSoup,
    *,
    publisher_text_node_ids: set[int] | None = None,
) -> bool:
    selected_names = {
        "p",
        "pre",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "figure",
        "table",
        "iframe",
    }
    parent = node.parent
    while isinstance(parent, Tag) and parent is not body:
        if (
            publisher_text_node_ids is not None
            and id(parent) in publisher_text_node_ids
        ):
            return True
        if node.name in {"iframe", "audio"} and parent.name in {"p", "pre"}:
            # Some migrated CMS pages emit invalid ``<p><div><iframe>``
            # markup, while archived audio players legitimately nest their
            # ``audio`` element inside a paragraph. Keep the media block even
            # though its paragraph shell is also a selected block.
            parent = parent.parent
            continue
        if (
            parent.name == "figure"
            and parent.select_one("img") is None
        ):
            # Modern scrollytelling packages use <figure> as a layout shell
            # around narrative paragraphs rather than as an image container.
            parent = parent.parent
            continue
        if (
            node.name == "img"
            and parent.name == "p"
            and not _clean_text(parent.get_text(" ", strip=True))
        ):
            parent = parent.parent
            continue
        if parent.name and parent.name.lower() in selected_names:
            return True
        parent = parent.parent
    return False


def _wsj_is_editorial_letter(soup: BeautifulSoup) -> bool:
    """Identify intentionally short WSJ letters without relaxing news gates."""
    values = (
        _meta_content(soup, "name", "article.type"),
        _meta_content(soup, "name", "article.type.display"),
        _meta_content(soup, "name", "article.page"),
    )
    return any(
        value and _clean_text(value).casefold() == "letters"
        for value in values
    )


def _deduplicate_blocks(
    blocks: list[ContentBlock],
    *,
    deduplicate_contained_pull_quotes: bool = False,
    deduplicate_bloomberg_dateline_variants: bool = False,
) -> list[ContentBlock]:
    contained_pull_quotes: set[int] = set()
    bloomberg_dateline_sequence_duplicates: set[int] = set()
    textual_types = {
        BlockType.PARAGRAPH,
        BlockType.QUOTE,
    }
    pull_quote_candidates = (
        enumerate(blocks) if deduplicate_contained_pull_quotes else ()
    )
    for index, block in pull_quote_candidates:
        if block.type not in textual_types or not block.text:
            continue
        normalized = _normalize_block_text(block.text)
        if len(normalized) < 60:
            continue
        decorative_paragraph = (
            block.type == BlockType.PARAGRAPH
            and not normalized.rstrip().endswith((".", "?", "!", "”", '"'))
        )
        if block.type != BlockType.QUOTE and not decorative_paragraph:
            continue
        for other_index, other in enumerate(blocks):
            if (
                other_index == index
                or abs(other_index - index) > 3
                or other.type not in textual_types
                or not other.text
            ):
                continue
            other_normalized = _normalize_block_text(other.text)
            if (
                len(other_normalized) > len(normalized)
                and normalized in other_normalized
            ):
                contained_pull_quotes.add(index)
                break
    if deduplicate_bloomberg_dateline_variants:
        for index, block in enumerate(blocks):
            if block.type not in textual_types or not block.text:
                continue
            normalized = _normalize_block_text(block.text)
            dateline_stripped = re.sub(
                r"(?i)^[a-z]{3,9}\.?\s+\d{1,2}"
                r"(?:,\s*\d{4})?\s+\(bloomberg\)\s*--\s*",
                "",
                normalized,
            )
            if dateline_stripped == normalized or len(dateline_stripped) < 80:
                continue
            pieces: list[str] = []
            candidate_indexes: list[int] = []
            for other_index in range(index + 1, min(len(blocks), index + 4)):
                other = blocks[other_index]
                if other.type not in textual_types or not other.text:
                    break
                pieces.append(_normalize_block_text(other.text))
                candidate_indexes.append(other_index)
                combined = " ".join(pieces)
                if combined == dateline_stripped:
                    bloomberg_dateline_sequence_duplicates.update(
                        candidate_indexes
                    )
                    break
                if len(combined) >= len(dateline_stripped):
                    break
    seen_text: set[str] = set()
    seen_assets: set[str] = set()
    unique: list[ContentBlock] = []
    for index, block in enumerate(blocks):
        if (
            index in contained_pull_quotes
            or index in bloomberg_dateline_sequence_duplicates
        ):
            continue
        if block.text:
            normalized = _normalize_block_text(block.text)
            if normalized and normalized in seen_text:
                continue
            dateline_stripped = ""
            if (
                deduplicate_bloomberg_dateline_variants
                and block.type in textual_types
                and len(normalized) >= 80
            ):
                dateline_stripped = re.sub(
                    r"(?i)^[a-z]{3,9}\.?\s+\d{1,2}"
                    r"(?:,\s*\d{4})?\s+\(bloomberg\)\s*--\s*",
                    "",
                    normalized,
                )
                if (
                    dateline_stripped != normalized
                    and dateline_stripped in seen_text
                ):
                    continue
            if normalized:
                seen_text.add(normalized)
                if dateline_stripped and dateline_stripped != normalized:
                    seen_text.add(dateline_stripped)
        if block.type == BlockType.IMAGE and block.asset_id:
            if block.asset_id in seen_assets:
                continue
            seen_assets.add(block.asset_id)
        block.position = len(unique)
        unique.append(block)
    return unique


def _normalize_block_text(value: str) -> str:
    return _clean_text(value).casefold()


def _image_from_tag(
    image_node: Tag,
    *,
    container: Tag,
    base_url: str,
    spec: PublisherSpec,
) -> ImageCandidate | None:
    candidates = _image_urls(image_node, base_url=base_url)
    if not candidates:
        return None
    if spec.publisher == "bloomberg":
        candidates = _promote_bloomberg_image_candidates(candidates)
    if spec.publisher == "npr":
        candidates = _promote_npr_image_candidates(candidates)
    if spec.publisher == "ft":
        candidates = _promote_ft_image_candidates(candidates)
    if spec.publisher == "reuters":
        candidates = _promote_reuters_image_candidates(candidates)
    if spec.publisher == "nyt":
        candidates = _promote_nyt_image_candidates(candidates)
        media_viewer_source = _normalized_url(
            image_node.get("data-mediaviewer-src"),
            base_url=base_url,
        )
        if media_viewer_source in candidates:
            # Legacy NYT figures expose the full-resolution editorial asset
            # explicitly for the publisher's media viewer.  Prefer it over
            # the smaller ``src`` rendition while retaining both URLs as
            # fallbacks for archival retrieval.
            candidates.remove(media_viewer_source)
            candidates.insert(0, media_viewer_source)
        if candidates and not _is_placeholder_image_url(candidates[0]):
            # The 2014-era NYT newsgraphics wrapper used a shared transparent
            # 10x10 GIF in ``src`` and kept the real chart/map in ``data-src``.
            # Promote the actual asset in both the normalized image record and
            # sanitized body HTML so unrelated graphics do not share the
            # placeholder's asset identity.
            image_node["src"] = candidates[0]
        if all(_is_placeholder_image_url(value) for value in candidates):
            return None
    original_url = candidates[0]
    if spec.publisher == "nyt":
        width = _absolute_image_dimension(image_node, "width")
        height = _absolute_image_dimension(image_node, "height")
    else:
        width = _integer_attribute(image_node, "width")
        height = _integer_attribute(image_node, "height")
    alt = _first_text(
        _clean_text(image_node.get("alt", "")),
        _clean_text(image_node.get("aria-label", "")),
    )
    caption_container = container
    if spec.publisher == "ap":
        carousel_slide = image_node.find_parent(
            class_=lambda value: value and "Carousel-slide" in value
        )
        if isinstance(carousel_slide, Tag):
            caption_container = carousel_slide
    if spec.publisher == "npr":
        legacy_bucket = image_node.find_parent(
            "div",
            class_=lambda value: value
            and "bucketwrap" in str(value).casefold(),
        )
        if isinstance(legacy_bucket, Tag):
            caption_container = legacy_bucket
    if spec.publisher == "npr":
        caption, credit = _npr_caption_credit(caption_container)
    elif spec.publisher == "nyt":
        caption, credit = _nyt_caption_credit(caption_container)
    elif spec.publisher == "bloomberg":
        caption, credit = _bloomberg_caption_credit(caption_container)
        if (
            caption
            and _clean_text(caption).casefold() == "olympus digital camera"
        ):
            caption = None
            caption_node = caption_container.select_one(
                "figcaption, [class*='caption' i]"
            )
            if isinstance(caption_node, Tag):
                caption_node.decompose()
        if alt and _clean_text(alt).casefold() == "olympus digital camera":
            alt = None
            image_node.attrs.pop("alt", None)
    else:
        caption, credit = _caption_credit(caption_container)
    if spec.publisher == "reuters" and caption:
        caption = re.sub(
            r"(?i)\s*purchase\s+licensing\s+rights\s*,?\s*"
            r"opens\s+new\s+tab\s*$",
            "",
            caption,
        ).rstrip() or None
    context = " ".join(
        filter(
            None,
            [
                container.get("class") and " ".join(container.get("class", [])),
                container.get("id"),
                image_node.get("class") and " ".join(image_node.get("class", [])),
                image_node.get("id"),
                original_url,
            ],
        )
    )
    noise_context = context
    if spec.publisher == "npr":
        # NPR asset directories can be named after a story subject (for
        # example the film ``/avatar/``).  Only let the filename contribute
        # URL noise signals so legitimate editorial images are not treated
        # as author portraits.
        image_filename = urlsplit(original_url).path.rpartition("/")[2]
        if not re.search(
            r"(?i)(?:^|[_.-])avatar(?:[_.-]|$)", image_filename
        ):
            image_filename = re.sub(r"(?i)avatar", "", image_filename)
        noise_context = context.replace(original_url, image_filename)
    reasons = ["inside-article-body"]
    role = ImageRole.BODY
    if _TRACKING_RE.search(noise_context) or (
        width is not None
        and height is not None
        and width <= 2
        and height <= 2
    ):
        role = ImageRole.TRACKING
        reasons.append("tracking-signal")
    elif spec.publisher == "axios" and any(
        marker in context.casefold()
        for marker in (
            "axios-visual-apple-fallback-image",
            "axios-visual-newsletter-fallback-image",
        )
    ):
        # Axios chart-led stories render an editorial fallback image inside
        # a class containing ``newsletter``.  The generic chrome detector
        # would otherwise demote the actual chart to an icon while keeping
        # the site's metadata placeholder as the lead image.
        role = ImageRole.CHART
        reasons.append("axios-visual-fallback")
    elif _NOISE_RE.search(noise_context):
        if re.search(r"(?i)(advert|sponsor|promo)", noise_context):
            role = ImageRole.ADVERTISEMENT
        elif re.search(r"(?i)(recommend|related)", noise_context):
            role = ImageRole.RECOMMENDATION
        elif re.search(r"(?i)avatar", noise_context):
            role = ImageRole.AUTHOR_AVATAR
        elif re.search(r"(?i)logo", noise_context):
            role = ImageRole.LOGO
        else:
            role = ImageRole.ICON
        reasons.append("non-editorial-context")
    elif width is not None and height is not None and max(width, height) <= 64:
        role = ImageRole.ICON
        reasons.append("small-dimensions")
    elif _GRAPHIC_RE.search(context):
        role = (
            ImageRole.INFOGRAPHIC
            if re.search(r"(?i)infographic", context)
            else ImageRole.CHART
        )
        reasons.append("graphic-context")
    if caption:
        reasons.append("has-caption")
    if urlsplit(original_url).hostname in spec.preferred_image_hosts:
        reasons.append("publisher-image-host")
    return _image_candidate(
        url=original_url,
        candidate_urls=candidates,
        role=role,
        spec=spec,
        reasons=reasons,
        caption=caption,
        credit=credit,
        alt=alt,
        width=width,
        height=height,
    )


def _image_candidate(
    *,
    url: str,
    candidate_urls: list[str],
    role: ImageRole,
    spec: PublisherSpec,
    reasons: list[str],
    caption: str | None = None,
    credit: str | None = None,
    alt: str | None = None,
    width: int | None = None,
    height: int | None = None,
) -> ImageCandidate:
    if (
        role == ImageRole.LEAD
        and "structured-lead-image" in reasons
        and not any((caption, credit, alt, width, height))
        and _structured_site_branding_image_url(url)
    ):
        # Syndication sites sometimes publish their compact masthead logo as
        # ``NewsArticle.image`` when the original story has no artwork. A
        # metadata-only, explicitly size-labelled logo is site chrome, not a
        # lead photograph, even though the structured field normally carries
        # strong editorial-image weight.
        role = ImageRole.LOGO
        reasons = [*reasons, "structured-site-branding"]
    if _is_placeholder_image_url(url):
        role = ImageRole.LOGO
        reasons = [*reasons, "generic-publisher-branding"]
    if spec.publisher == "zaobao" and _zaobao_non_editorial_image_url(url):
        role = ImageRole.LOGO
        reasons = [*reasons, "zaobao-paywall-default-artwork"]
    if spec.publisher == "nyt" and _nyt_generic_branding_image(url):
        role = ImageRole.LOGO
        reasons = [*reasons, "generic-publisher-branding"]
    if (
        spec.publisher == "nyt"
        and _nyt_author_avatar_image(
            url,
            alt=alt,
            allow_opinion_social=role != ImageRole.BODY,
        )
    ):
        role = ImageRole.AUTHOR_AVATAR
        reasons = [*reasons, "author-avatar-url"]
    if spec.publisher == "nyt" and _nyt_interactive_sprite_image(url):
        role = ImageRole.ICON
        reasons = [*reasons, "interactive-sprite-asset"]
    if spec.publisher == "nyt" and _nyt_non_editorial_image(url):
        role = ImageRole.ICON
        reasons = [*reasons, "social-or-author-icon-url"]
    identity = _image_identity(url)
    asset_id = (
        f"urlsha256:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"
    )
    return ImageCandidate(
        asset_id=asset_id,
        role=role,
        original_url=url,
        candidate_urls=candidate_urls,
        caption=caption,
        credit=credit,
        alt=alt,
        width=width,
        height=height,
        should_archive=role in ARCHIVABLE_IMAGE_ROLES,
        selection_reasons=sorted(set(reasons)),
    )


def _image_identity(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    archive_image = None
    if host in {"arquivo.pt", "www.arquivo.pt"}:
        archive_image = re.match(
            r"^/(?:noFrame/)?replay/\d{14}(?:[a-z_]+)?/"
            r"(?P<url>https?://.+)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    elif host == "web.archive.org":
        archive_image = re.match(
            r"^/web/\d{14}(?:[a-z_]+)?/(?P<url>https?://.+)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    if archive_image is not None:
        # Archive replay wrappers are delivery locations, not editorial
        # asset identities. Preserve their outer query as part of the
        # recovered source URL; recursive normalization then unwraps nested
        # FT Origami proxies and strips rendition-only parameters.
        nested_archive_url = archive_image.group("url")
        if parts.query:
            nested_archive_url = f"{nested_archive_url}?{parts.query}"
        return _image_identity(nested_archive_url)
    if (
        host in {"images.ft.com", "d1e00ek4ebabms.cloudfront.net"}
        or re.fullmatch(r"(?:www-)?images-ft-com\.ezproxy\..+", host)
    ):
        # FT Next pages expose one UPP photograph as ``ftcms:<uuid>``, as a
        # CloudFront production URL, and through institution-specific image
        # proxy hosts.  The UUID is stable across all of those delivery URLs;
        # crop/source/width parameters only select a rendition.
        ft_asset = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12})",
            unquote(parts.path),
            flags=re.IGNORECASE,
        )
        if ft_asset is not None:
            return f"ft-image:{ft_asset.group(1).casefold()}"
    if (
        host in {"swissinfo.ch", "www.swissinfo.ch"}
        and unquote(parts.path).casefold().startswith(
            "/content/wp-content/uploads/"
        )
    ):
        # Swissinfo's licensed FT pages publish the same upload as several
        # JSON-LD lead crops (resize/fit) plus the body ``ver`` rendition.
        # Keep the URLs as fallbacks but represent the source photograph once.
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if unquote(parts.path).casefold().startswith(
        "/wp-content/uploads/migration/"
    ):
        # Tribune Publishing partners expose syndicated NYT photographs as
        # several JSON-LD lead renditions plus a body image. Width/height and
        # crop parameters differ, and relative body URLs can be resolved
        # against the NYT canonical host instead of the partner host.  The
        # migration path contains a stable generated asset id, so it is the
        # identity across those delivery hosts and rendition queries.
        return f"wordpress-migration-image:{unquote(parts.path).casefold()}"
    normalized_legacy_nyt_url: str | None = None
    if (
        host == "static01.nyt.com"
        or re.fullmatch(r"(?:graphics|static)\d*\.nytimes\.com", host)
    ):
        legacy_rendition_query = parse_qsl(
            parts.query,
            keep_blank_values=False,
        )
        if legacy_rendition_query and all(
            key.casefold() in {"year", "h", "w", "s", "k", "tw"}
            for key, _ in legacy_rendition_query
        ):
            # Legacy NYT templates often emit the same static image once as
            # the canonical path and once with resize/signature parameters.
            # Those parameters select a rendition; they do not identify a
            # second editorial asset.
            parts = parts._replace(query="", fragment="")
            normalized_legacy_nyt_url = urlunsplit(
                (
                    parts.scheme.casefold(),
                    parts.netloc.casefold(),
                    parts.path,
                    "",
                    "",
                )
            )
    if (
        host == "markets.on.nytimes.com"
        and parts.path.casefold().endswith("/research/tools/builder/api.asp")
    ):
        # The endpoint path is shared by every NYT stock chart; ``sym`` and
        # ``duration`` identify the rendered editorial graphic.  Styling and
        # output dimensions are rendition details and must not split it.
        semantic_query = urlencode(
            sorted(
                (key.casefold(), value)
                for key, value in parse_qsl(
                    parts.query,
                    keep_blank_values=False,
                )
                if key.casefold() in {"sym", "duration"} and value
            )
        )
        if semantic_query:
            return f"nyt-market-chart:{semantic_query}"
    if (
        host in {"aljazeera.com", "www.aljazeera.com"}
        and unquote(parts.path).casefold().startswith("/wp-content/uploads/")
    ):
        # Al Jazeera's structured image list exposes several resize/crop
        # query strings for the same uploaded file.  Preserve every rendition
        # as a candidate URL while representing the underlying photograph as
        # one asset.
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host in {"cdn.i-scmp.com", "cdn1.i-scmp.com", "img.i-scmp.com"}:
        # SCMP exposes one editorial asset through an original CDN URL,
        # Drupal ``styles/<preset>/public`` renditions, and Cloudflare's
        # ``cdn-cgi/image`` proxy.  The query tokens and rendition prefixes
        # vary while the path below ``sites/default/files`` is stable.
        scmp_path = unquote(parts.path)
        scmp_path = re.sub(
            r"^/cdn-cgi/image/[^/]+/(?=sites/default/files/)",
            "/",
            scmp_path,
            flags=re.IGNORECASE,
        )
        scmp_path = re.sub(
            r"^/sites/default/files/styles/[^/]+/public/",
            "/sites/default/files/",
            scmp_path,
            flags=re.IGNORECASE,
        )
        # Legacy Methode payloads name renditions of one photograph with the
        # same UUID and article suffix but a different size token, for example
        # ``..._image_hires_151415.jpg`` and ``..._1320x770_151415.jpg``.
        # Treat those as candidate URLs of one asset so the caption and image
        # are not emitted twice.
        scmp_path = re.sub(
            r"_(?:image_hires|\d+x\d*)_(\d+)(\.[a-z0-9]+)$",
            r"_\1\2",
            scmp_path,
            flags=re.IGNORECASE,
        )
        # Earlier Methode assets use the same UUID with only a terminal
        # rendition label and no generated numeric suffix, for example
        # ``..._image_hires.JPG`` and ``..._1280x720.JPG``. They are also
        # alternate deliveries of one photograph, not two body images.
        scmp_path = re.sub(
            r"_(?:image_hires|\d+x\d*)(\.[a-z0-9]+)$",
            r"\1",
            scmp_path,
            flags=re.IGNORECASE,
        )
        if scmp_path.casefold().startswith("/sites/default/files/"):
            return f"scmp-image:{scmp_path.casefold()}"
    if host == "images.axios.com":
        # Axios places a signing token, crop and resize instructions before a
        # stable date/filename suffix. Different renditions of one editorial
        # image must remain alternate URLs of one asset, not duplicate images.
        axios_asset = re.search(
            r"/(\d{4}/\d{2}/\d{2}/[^/]+)$",
            parts.path,
            flags=re.IGNORECASE,
        )
        if axios_asset is not None:
            return f"axios-image:{axios_asset.group(1).casefold()}"
    if host in {"media.npr.org", "media.npr.com"}:
        # NPR emits one source photograph as multiple filenames: a structured
        # ``*_wide-<digest>`` lead plus body ``-<digest>-s1100`` and
        # ``-<digest>-s1200`` renditions.  The date directory and filename
        # stem before that generated suffix identify the editorial asset.
        directory, separator, filename = unquote(parts.path).rpartition("/")
        rendition = re.fullmatch(
            r"(.+?)(?:_(?:wide|sq|custom))?-[0-9a-f]{40}"
            r"(?:-s\d+)?\.[a-z0-9]+",
            filename,
            flags=re.IGNORECASE,
        )
        if separator and rendition is not None:
            return (
                "npr-image:"
                f"{directory.casefold()}/{rendition.group(1).casefold()}"
            )
        legacy_delivery_query = parse_qsl(
            parts.query,
            keep_blank_values=False,
        )
        if not legacy_delivery_query or all(
            key.casefold() in {"s", "t"}
            for key, _ in legacy_delivery_query
        ):
            # Pre-digest NPR assets keep one stable filename and select the
            # crop/size with ``s`` plus a cache timestamp in ``t``.  Preserve
            # every delivery URL as a candidate while treating the underlying
            # path as one photograph (including http/https host aliases).
            return f"npr-image:{unquote(parts.path).casefold()}"
    if (
        (
            host == "zaobao.com.sg"
            or host.endswith(".zaobao.com.sg")
            or host.endswith(".zaobao.com")
        )
        and "/sites/default/files/styles/" in parts.path.casefold()
    ):
        # Legacy Drupal pages expose one upload through several named style
        # paths (social-card, article-large, mobile) and attach independent
        # ``itok``/timestamp delivery tokens to each.  The stable path below
        # ``public`` identifies the editorial asset.
        zaobao_path = re.sub(
            r"^/sites/default/files/styles/[^/]+/public/",
            "/sites/default/files/",
            unquote(parts.path),
            flags=re.IGNORECASE,
        )
        return f"zaobao-image:{zaobao_path.casefold()}"
    if host == "dims.apnews.com":
        nested_match = re.search(
            r"(?:^|&)url=([^&]+)",
            parts.query,
            flags=re.IGNORECASE,
        )
        if nested_match is not None:
            nested = unquote(nested_match.group(1))
            nested_parts = urlsplit(nested)
            if (
                nested_parts.scheme in {"http", "https"}
                and nested_parts.netloc
            ):
                return _image_identity(nested)
    if host in {"ft.com", "www.ft.com"} and "/images/raw/" in parts.path:
        nested = unquote(parts.path.split("/images/raw/", 1)[1])
        for _ in range(4):
            nested_parts = urlsplit(nested)
            if "/images/raw/" not in nested_parts.path:
                break
            nested = unquote(
                nested_parts.path.split("/images/raw/", 1)[1]
            )
        nested_parts = urlsplit(nested)
        if nested_parts.scheme in {"http", "https"} and nested_parts.netloc:
            return _image_identity(
                urlunsplit(
                    (
                        nested_parts.scheme.casefold(),
                        nested_parts.netloc.casefold(),
                        nested_parts.path,
                        "",
                        "",
                    )
                )
            )
    if (
        host in {"irishtimes.com", "www.irishtimes.com"}
        and parts.path.casefold().startswith("/resizer/v2/")
    ):
        # Irish Times syndication pages expose the same source photograph as
        # landscape, portrait, square and social-card crops. The stable
        # resizer asset path identifies the photograph; auth, smart-crop and
        # width/height parameters only select a rendition.
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host == "d1e00ek4ebabms.cloudfront.net":
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host.endswith("reutersmedia.net") and parts.path == "/resources/r/":
        legacy_id = re.search(
            r"(?:^|&)i=(\d+)(?:&|$)",
            parts.query,
            flags=re.IGNORECASE,
        )
        if legacy_id is not None:
            return f"reuters-image:{legacy_id.group(1)}"
    if host in {
        "prod-upp-image-read.ft.com",
        "com.ft.imagepublish.upp-prod-eu.s3.amazonaws.com",
    }:
        ft_asset = re.search(
            r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12})(?:$|[./])",
            parts.path,
            re.IGNORECASE,
        )
        if ft_asset is not None:
            return f"ft-image:{ft_asset.group(1).casefold()}"
    if host == "img.ksl.com":
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host == "assets.bwbx.io":
        bloomberg_asset = re.fullmatch(
            r"(.+/v\d+)/[^/]+",
            parts.path,
            re.IGNORECASE,
        )
        if bloomberg_asset is not None:
            return f"bloomberg-image:{bloomberg_asset.group(1).casefold()}"
    if host == "article-image-ix.nikkei.com":
        nested = unquote(parts.path.lstrip("/"))
        nested_parts = urlsplit(nested)
        if (
            nested_parts.scheme in {"http", "https"}
            and nested_parts.netloc
        ):
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
    if host == "int.nyt.com" and "/newsgraphics/" in parts.path:
        responsive_path = re.sub(
            r"_(?:300|480|720|800|945)_v(?=\d+\.[a-z0-9]+$)",
            "_responsive_v",
            parts.path,
            flags=re.IGNORECASE,
        )
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                responsive_path,
                "",
                "",
            )
        )
    if (
        host == "static01.nyt.com"
        or re.fullmatch(r"graphics\d+\.nytimes\.com", host)
    ) and "/images/" in parts.path:
        directory, separator, filename = parts.path.rpartition("/")
        asset_name = directory.rsplit("/", 1)[-1]
        if (
            separator
            and asset_name
            and filename.casefold().startswith(asset_name.casefold())
        ):
            return f"nyt-image:{directory.casefold()}"
    wsj_image = (
        re.fullmatch(
            r"(/im-\d+)(?:/(?:social|portrait))?/?",
            parts.path,
            re.IGNORECASE,
        )
        if host in {"images.wsj.net", "opinion-images.wsj.net"}
        else None
    )
    if wsj_image is not None:
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                wsj_image.group(1),
                "",
                "",
            )
        )
    if host == "si.wsj.net":
        legacy_wsj_image = re.fullmatch(
            r"(.+?)_(?:G|D|M|SOC|TOP|IM)_(\d+)\.([a-z0-9]+)",
            parts.path,
            re.IGNORECASE,
        )
        if legacy_wsj_image is not None:
            return (
                "wsj-legacy-image:"
                f"{legacy_wsj_image.group(1).casefold()}_"
                f"{legacy_wsj_image.group(2)}."
                f"{legacy_wsj_image.group(3).casefold()}"
            )
    return normalized_legacy_nyt_url or url


_ALJAZEERA_NON_EDITORIAL_IMAGE_FILENAMES = frozenset(
    {
        "445ed4f604cc49698f3836f370e3bd83_6.jpeg",
        "face24c59e154577ab3a9ac3fae037c5_6.jpeg",
        "689d319d19954da39884b1ed32bc111b_6.jpeg",
        "9092c8160ac341cf8595d7551b94cd0a_6.jpeg",
        "5dcea9e1193048efa4a46fdc4754adee_18.jpeg",
        "5b28784782164b5ea20f5c0071206fd7_6.jpeg",
    }
)


def _aljazeera_non_editorial_image_url(url: str) -> bool:
    """Recognize confirmed shared Al Jazeera branding and promo artwork."""
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() not in {
        "aljazeera.com",
        "www.aljazeera.com",
    }:
        return False
    path = unquote(parts.path).casefold().rstrip("/")
    return (
        path == "/images/logo_aje_social.png"
        or path.rsplit("/", 1)[-1]
        in _ALJAZEERA_NON_EDITORIAL_IMAGE_FILENAMES
    )


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


def _caixin_non_editorial_image_url(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    return (
        host == "file.caing.com"
        and path.endswith("/images/channel/content/images/fullurl.gif")
    ) or (
        host == "file.caixin.com"
        and (
            path.endswith("/file/vip/images/code.jpg")
            or path.endswith("/images/common/images/shareimg.jpg")
        )
    ) or (
        host == "file.caixin.com"
        and re.search(
            r"/images/common/images/logo[^/]*\.(?:gif|jpe?g|png|webp)$",
            path,
        )
        is not None
    ) or (
        host == "entities.caixin.com"
        and path.endswith("/support.png")
    )


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


def _zaobao_non_editorial_image_url(url: str) -> bool:
    """Recognize Zaobao paywall/default artwork, not story media."""
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold()
    if host not in {"www.zaobao.com.sg", "static.zaobao.com"}:
        return False
    return bool(
        re.search(
            r"/themes/custom/zbsg2020/images/default-img\.png$|"
            r"/themes/custom/zbsg2020/images/social-share\.png$|"
            r"/dist/images/zbsg/default-image\.png$|"
            r"/sites/all/themes/zb2016/assets/imgs/(?:zbsg/)?default-image\.png$|"
            r"/sites/all/themes/zb2016/assets/imgs/icon_(?:newspost|newsmine)_(?:cn|en)_new\.png$|"
            r"/sites/all/themes/zb2013/img/zb_logo\.jpg$|"
            r"/assets/newspost-[a-z0-9_-]+\.svg$|"
            r"/r0lgodlhaqabaiaaaaaaap/[a-z0-9_-]+$|"
            r"/zbsg/zaobaosg-facebook-share\.png$|"
            r"/freemium_images/[^/]+/[^/]*default[-_](?:desktop|mobile)[^/]*\.(?:gif|jpe?g|png|webp)$|"
            r"/(?:11_mobile_updated_covid_19_0|desktop_covid_19_0)\.png$",
            path,
            flags=re.IGNORECASE,
        )
    )


def _nyt_generic_branding_image(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if host != "static01.nyt.com" and re.fullmatch(
        r"graphics\d+\.nytimes\.com",
        host,
    ) is None:
        return False
    return bool(
        re.search(
            r"/vi-assets/images/share/\d+x\d+_(?:nameplate|t)\.png$|"
            r"/images/icons/t_logo_\d+_black\.png$|"
            r"/images/common/icons/t_wb_\d+\.gif$",
            parts.path,
            flags=re.IGNORECASE,
        )
    )


def _repair_ft_damaged_smart_quotes(soup: BeautifulSoup) -> None:
    """Repair the exact smart-quote corruption found in archived FT AMP HTML."""

    replacements = {
        "i\u20ac\u0153": "“",
        "i\u20ac\ufffd": "”",
    }
    for node in list(
        soup.find_all(
            string=lambda value: value
            and any(marker in value for marker in replacements)
        )
    ):
        if not isinstance(node, NavigableString):
            continue
        repaired = str(node)
        for damaged, replacement in replacements.items():
            repaired = repaired.replace(damaged, replacement)
        if repaired != str(node):
            node.replace_with(repaired)


def _repair_nyt_replacement_characters(
    soup: BeautifulSoup,
    html_bytes: bytes,
) -> None:
    """Recover NYT Burst emoji lost in its server-rendered HTML.

    Some archived Burst interactives contain literal U+FFFD characters in
    the rendered paragraph while the same text in the embedded application
    payload retains the intended scalar as an ECMAScript ``\\u{...}`` escape.
    Use matching surrounding text to recover only unambiguous occurrences.
    """

    if b"\xef\xbf\xbd" not in html_bytes:
        return
    source = html_bytes.decode("utf-8", errors="replace")
    for node in list(soup.find_all(string=lambda value: value and "\ufffd" in value)):
        if not isinstance(node, NavigableString):
            continue
        value = str(node)
        repaired = value
        for damaged in dict.fromkeys(re.findall(r"\ufffd+", value)):
            offset = repaired.find(damaged)
            if offset < 0:
                continue
            prefix = repaired[max(0, offset - 48) : offset]
            suffix = repaired[offset + len(damaged) : offset + len(damaged) + 48]
            if len(prefix.strip()) < 12 and len(suffix.strip()) < 1:
                continue
            match = re.search(
                re.escape(prefix)
                + r"\\u\{([0-9a-fA-F]{1,6})\}"
                + re.escape(suffix),
                source,
            )
            if match is None:
                # Burst's serialized JSON often has a different wrapper than
                # the rendered HTML node, so exact prefix/suffix matching is
                # not possible. Fall back to a bounded textual-anchor search
                # around each ECMAScript escape.
                prefix_anchor = re.sub(
                    r"\s+", " ", prefix
                ).strip().casefold()[-64:]
                suffix_anchor = re.sub(
                    r"\s+", " ", suffix
                ).strip().casefold()[:64]
                if not prefix_anchor and not suffix_anchor:
                    continue
                recovered: set[int] = set()
                for escape in re.finditer(
                    r"\\u\{([0-9a-fA-F]{1,6})\}",
                    source,
                ):
                    before = re.sub(
                        r"\s+", " ", source[max(0, escape.start() - 256) : escape.start()]
                    ).casefold()
                    after = re.sub(
                        r"\s+", " ", source[escape.end() : escape.end() + 256]
                    ).casefold()
                    if prefix_anchor and not before.rstrip().endswith(
                        prefix_anchor
                    ):
                        continue
                    if suffix_anchor and not after.lstrip().startswith(
                        suffix_anchor
                    ):
                        continue
                    recovered.add(int(escape.group(1), 16))
                if len(recovered) != 1:
                    continue
                codepoint = recovered.pop()
            else:
                codepoint = int(match.group(1), 16)
            if codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
                continue
            repaired = repaired.replace(damaged, chr(codepoint), 1)
        # A small set of archived NYT interactives contains literal U+FFFD
        # runs in the rendered HTML (typically a flag/emoji that was already
        # lost by the publisher before the archive snapshot).  There is no
        # recoverable scalar in those snapshots, but exposing the replacement
        # glyph in normalized article text is worse than retaining the raw
        # HTML and leaving a clean, readable gap.  Keep the raw object as the
        # lossless evidence and normalize only this residual decode marker.
        repaired = re.sub(r"\ufffd+", " ", repaired)
        if repaired != value:
            node.replace_with(repaired)


def _nyt_author_avatar_image(
    url: str,
    *,
    alt: str | None = None,
    allow_opinion_social: bool = True,
) -> bool:
    parts = urlsplit(url)
    if _nyt_legacy_recurring_columnist_portrait(url):
        return True
    if (parts.hostname or "").casefold() != "static01.nyt.com":
        return False
    explicit_author = re.search(
        r"/(?:author-[^/]+|author-head-[^/]+)/"
        r"[^/]*(?:thumb(?:large|standard)|author-head)[^/]*"
        r"\.(?:avif|gif|jpe?g|png|webp)$",
        parts.path,
        flags=re.IGNORECASE,
    )
    if explicit_author is not None:
        return True
    legacy_chatblog_author = re.search(
        r"/[^/]*(?:twitter|reporter)[-_]chatblog[^/]*/"
        r"[^/]*thumb(?:large|standard)(?:-v\d+)?"
        r"\.(?:avif|gif|jpe?g|png|webp)$",
        parts.path,
        flags=re.IGNORECASE,
    )
    if legacy_chatblog_author is not None and alt:
        # Election interactives also embedded reporter portraits from older
        # live-chat packages.  Those directories contain the module suffix
        # (and occasionally a misspelled name), so alt-to-slug equality is
        # not reliable, but the chatblog + thumb rendition shape is specific
        # to reporter chrome.
        return True
    legacy_multimedia_author = re.search(
        r"/multimedia/(?P<slug>[^/]+)/(?P=slug)-"
        r"thumb(?:large|standard)(?:-v\d+)?"
        r"\.(?:avif|gif|jpe?g|png|webp)$",
        parts.path,
        flags=re.IGNORECASE,
    )
    if legacy_multimedia_author is not None and alt:
        # Older NYT election/live modules put reporter portraits under
        # ``/multimedia/<name>/<name>-thumbLarge`` rather than the newer
        # ``author-*`` directories.  Require the image alt text to match the
        # path slug so ordinary story thumbnails with the same URL shape do
        # not get demoted.
        normalized_alt = re.sub(
            r"[^a-z0-9]+",
            "-",
            _clean_text(alt).casefold(),
        ).strip("-")
        if normalized_alt == legacy_multimedia_author.group("slug").casefold():
            return True
    return bool(
        allow_opinion_social
        and re.search(
            r"/opinion/([^/]+)/\1-"
            r"(?:videoSixteenByNineJumbo1600|superJumbo|facebookJumbo)"
            r"(?:-v\d+)?\.(?:avif|gif|jpe?g|png|webp)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    )


def _nyt_interactive_sprite_image(url: str) -> bool:
    """Recognize NYT interactive CSS sprites that are not editorial media."""
    parts = urlsplit(url)
    if (parts.hostname or "").casefold() != "static01.nyt.com":
        return False
    return bool(
        re.search(
            r"/projects/assets/oscars_2013/images/2013/"
            r"[^/]*sprite[^/]*\.(?:gif|jpe?g|png|webp)$|"
            r"/[^/]*sprite[^/]*\.(?:gif|jpe?g|png|webp)$",
            parts.path,
            flags=re.IGNORECASE,
        )
    )


def _nyt_non_editorial_image(url: str) -> bool:
    """Recognize NYT social/author icon renditions rather than story media."""
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path).casefold().rstrip("/")
    if "social-images-by-section/" in path:
        # During the pandemic NYT assigned the same section-level social card
        # to unrelated Business stories. It is sharing metadata, not story art.
        return True
    if (host, path) in {
        (
            "images.wral.com",
            "/4687bfb9-1153-4ec6-b63e-01c2ae696033",
        ),
        (
            "assets.wral.com",
            "/a1cc0e86-adab-48e9-bd80-703cd2c56aff",
        ),
    }:
        # WRAL's archived NYT syndication template publishes these same two
        # metadata-only UUID assets as ``NewsArticle.image`` for unrelated
        # stories. They are template defaults, not editorial photographs.
        return True
    if host != "static01.nyt.com":
        # Legacy NYT article metadata used graphics8/9 for both editorial
        # photographs and UI artwork.  A section directory ending in
        # ``-icon`` is the latter (for example the old ``ccc-icon`` comment
        # control), while ordinary historical image directories do not use
        # this shape. Keep the rule scoped to the legacy graphics hosts so
        # genuine static01 On Politics artwork remains editorial.
        if re.fullmatch(r"graphics\d+\.nytimes\.com", host) is None:
            return False
        return bool(
            re.search(
                r"/(?:[^/]+-)?icon/[^/]+\.(?:gif|jpe?g|png|webp)$",
                path,
                flags=re.IGNORECASE,
            )
        )
    if re.search(r"/video-player/[^/]+\.svg$", path):
        # NYT newsgraphics packages put first-party loading/play/pause SVGs
        # beside the editorial assets. They are playback controls, not
        # article images, even when a legacy package serializes them in the
        # selected body or structured image list.
        return True
    if "healthquiz-art/" in path:
        return True
    if re.search(
        r"/business/norrispic/norrispic-(?:articleinline|"
        r"thumblarge|jumbo|superjumbo)(?:-v\d+)?\.(?:jpe?g|png|webp)$",
        path,
        flags=re.IGNORECASE,
    ):
        # Floyd Norris's fixed headshot was reused as the structured image for
        # unrelated columns. It is an author portrait, not article media.
        return True
    return bool(
        re.search(
            # NYT has used both ``_icon`` and ``-icon`` directory names for
            # social/quiz renditions (for example ``11Well-HealthQuiz-icon``).
            r"(?:^|/)\d{1,4}[^/]*(?:[_-])icon/",
            path,
            flags=re.IGNORECASE,
        )
    )


def _nyt_non_editorial_lead_image(
    url: str,
    *,
    canonical_url: str,
) -> bool:
    """Recognize metadata images that are unrelated to the current NYT page."""

    image_path = unquote(urlsplit(url).path).casefold()
    article_path = unquote(urlsplit(canonical_url).path).casefold()
    return bool(
        "/interactive/" in article_path
        and "/elections/results-" in article_path
        and "election-2024-reporter-updates" in image_path
    )


def _ft_image_led_article(
    article: dict[str, Any],
    *,
    body_characters: int,
    images: list[ImageCandidate],
) -> bool:
    if not article or body_characters >= _MINIMUM_BODY_CHARACTERS or not images:
        return False
    word_count = article.get("wordCount")
    article_body = _string_or_none(article.get("articleBody"))
    structured_image = article.get("image")
    if not isinstance(word_count, int) or word_count > 30:
        return False
    if not article_body or len(_clean_text(article_body)) >= 120:
        return False
    if not isinstance(structured_image, dict):
        return False
    width = structured_image.get("width")
    height = structured_image.get("height")
    return (
        isinstance(width, int)
        and isinstance(height, int)
        and width >= 800
        and height >= 600
    )


def _zaobao_visual_short_record(
    article: dict[str, Any],
    *,
    body_characters: int,
    images: list[ImageCandidate],
) -> bool:
    """Recognize old Zaobao photo-news records with caption-only bodies."""
    if not article or not any(image.should_archive for image in images):
        return False
    access_mode = _string_or_none(article.get("accessMode"))
    if not access_mode or access_mode.casefold() != "visual":
        return False
    word_count = article.get("wordCount")
    if not isinstance(word_count, int) or word_count > 120:
        return False
    article_body = _string_or_none(article.get("articleBody"))
    if not article_body or not _clean_text(article_body):
        return False
    return body_characters < _MINIMUM_BODY_CHARACTERS


def _zaobao_structured_visual_body_is_more_complete(
    article: dict[str, Any],
    *,
    body: Tag,
    structured_body: Tag,
) -> bool:
    """Prefer complete JSON-LD text over a truncated legacy visual body."""
    if not article:
        return False
    access_mode = _string_or_none(article.get("accessMode"))
    if not access_mode or access_mode.casefold() != "visual":
        return False
    editorial_body = body.select_one(
        ".article-content-container, #FineDining"
    )
    if not isinstance(editorial_body, Tag):
        return False
    dom_text = _clean_text(editorial_body.get_text(" ", strip=True))
    structured_text = _clean_text(
        structured_body.get_text(" ", strip=True)
    )
    return (
        len(structured_text) >= _MINIMUM_BODY_CHARACTERS
        and len(structured_text) > len(dom_text)
    )


def _ft_explicit_truncation_notice(soup: BeautifulSoup) -> bool:
    text = _clean_text(soup.get_text(" ", strip=True))
    return (
        "您已阅读" in text
        and "剩余" in text
        and "订阅以继续探索完整内容" in text
    )


def _ft_missing_legacy_visual(soup: BeautifulSoup) -> bool:
    """Detect migrated caption-only FT pages whose visual asset was lost."""
    body = soup.select_one(
        "article .article-body[itemprop='articleBody'], "
        "article .article-body"
    )
    if not isinstance(body, Tag):
        return False
    paragraphs = [
        _clean_text(node.get_text(" ", strip=True))
        for node in body.select("p")
        if "copyright" not in " ".join(
            str(value).casefold()
            for value in node.get("class", [])
        )
        and _clean_text(node.get_text(" ", strip=True))
    ]
    if len(paragraphs) != 1 or len(paragraphs[0]) >= 350:
        return False
    if body.select_one(
        "img[src], amp-img[src], figure, iframe[src], video, "
        "amp-video, amp-brightcove, object, embed"
    ):
        return False
    text = paragraphs[0]
    return bool(
        (
            re.search(r"\([LR]\)", text)
            and re.search(r"\([LR]\)", text[re.search(r"\([LR]\)", text).end():])
        )
        or re.search(
            r"(?i)\b(?:pictured|poses? for (?:a )?photograph|"
            r"photographer\s*:|photo shows?|shakes? hands with)\b",
            text,
        )
    )


def _bloomberg_teaser_shell(soup: BeautifulSoup) -> bool:
    if bool(
        soup.select_one(
            "[class*='teaser-body'], "
            ".body-content[class*='teaser-content']"
        )
    ):
        return True
    marker = (
        "to continue reading this article you must be a bloomberg "
        "professional service subscriber"
    )
    for node in soup.select("p"):
        text = _clean_text(node.get_text(" ", strip=True)).casefold()
        if marker not in text:
            continue
        current: Tag | None = node
        hidden = False
        while isinstance(current, Tag):
            style = _clean_text(str(current.get("style") or "")).casefold()
            if (
                current.has_attr("hidden")
                or str(current.get("aria-hidden") or "").casefold() == "true"
                or re.search(r"(?:^|;)\s*display\s*:\s*none\b", style)
            ):
                hidden = True
                break
            current = current.parent if isinstance(current.parent, Tag) else None
        if not hidden:
            return True
    return False


def _merge_candidate_urls(
    existing: ImageCandidate,
    incoming: ImageCandidate,
) -> None:
    for url in (
        incoming.original_url,
        *incoming.candidate_urls,
    ):
        if url not in existing.candidate_urls:
            existing.candidate_urls.append(url)


def _image_urls(image: Tag, *, base_url: str) -> list[str]:
    values: list[tuple[int, str]] = []
    for attribute in (
        "src",
        "data-src",
        "data-original",
        "data-image",
        "data-mediaviewer-src",
        "data-flickity-lazyload",
    ):
        normalized = _normalized_url(image.get(attribute), base_url=base_url)
        if normalized and urlsplit(normalized).scheme != "data":
            values.append((0, normalized))
    for attribute in (
        "srcset",
        "data-srcset",
        "data-flickity-lazyload-srcset",
    ):
        raw = image.get(attribute)
        if not isinstance(raw, str):
            continue
        for entry in raw.split(","):
            parts = entry.strip().split()
            if not parts:
                continue
            normalized = _normalized_url(parts[0], base_url=base_url)
            if not normalized or urlsplit(normalized).scheme == "data":
                continue
            score = 0
            if len(parts) > 1 and parts[1].endswith("w"):
                try:
                    score = int(parts[1][:-1])
                except ValueError:
                    score = 0
            values.append((score, normalized))
    values.sort(key=lambda item: item[0], reverse=True)
    result: list[str] = []
    for _, value in values:
        if value not in result:
            result.append(value)
    return result


def _lead_image_urls(
    soup: BeautifulSoup,
    article: dict[str, Any],
    base_url: str,
) -> list[str]:
    values: list[str] = []
    if article:
        values.extend(_flatten_image_values(article.get("image")))
    values.extend(
        filter(
            None,
            [
                _meta_content(soup, "property", "og:image"),
                _meta_content(soup, "name", "twitter:image"),
                _meta_content(soup, "name", "parsely-image-url"),
            ],
        )
    )
    result: list[str] = []
    for value in values:
        normalized = _normalized_url(value, base_url=base_url)
        if (
            normalized
            and not _is_placeholder_image_url(normalized)
            and normalized not in result
        ):
            result.append(normalized)
    if "ft.com" in (urlsplit(base_url).hostname or "").casefold():
        return _promote_ft_image_candidates(result)
    if "reuters.com" in (urlsplit(base_url).hostname or "").casefold():
        return _promote_reuters_image_candidates(result)
    return result


def _is_placeholder_image_url(url: str) -> bool:
    decoded = unquote(url).casefold()
    path_leaf = urlsplit(decoded).path.rstrip("/").rsplit("/", 1)[-1]
    if path_leaf in {
        "10x10.gif",
        "null",
        "none",
        "social-share.png",
        "transparent.gif",
        "transparent.png",
        "undefined",
    }:
        return True
    return any(
        marker in decoded
        for marker in (
            "/defaultshareimage",
            "/default-share-image",
            "the-ap-default-image-",
            "/default_social",
            "/default-social",
            "/defaultpromocrop.",
            "/rcom-default.png",
            "/reuters-default.png",
            "/r-generic-hdr.png",
            "/images/reuters.jpg",
            "twitter_ms_fdnoir.png",
            "/javelin/images/social-",
            "/javelin/public/images/social-",
            "/lightsaber/_next/static/media/social-",
            "/~assets/social-default.",
            # Syndication pages commonly reuse a generic social card when
            # the original NYT artwork is unavailable. It is branding, not
            # an article image, and must not be archived as the lead asset.
            "social-default",
            "yahoo_default_logo",
            "yahoo-finance-default-logo",
            "/m/img/social/og-ft-logo",
            # Legacy FT article chrome: a 210x39 GIF reused across unrelated
            # stories, not editorial artwork.
            "bc1ec196-2767-11e2-8c4f-00144feabdc0.gif",
            # A legacy FT fallback image reused as the lead asset across
            # unrelated stories about media, cosmetics, retail, tobacco and
            # finance. Its stable UPP id identifies template artwork rather
            # than an image belonging to any one article.
            "0db36b94-146a-11e7-80f4-13e067d5072c",
            # Euro2day's FT republications expose these partner/template
            # assets as the article's social image or copyright logo.
            "static.euro2day.gr/images/fbdefault.jpg",
            "/images/ft.png",
            "/__assets/creatives/open-graph/ft-v1.jpg",
            "/__assets/creatives/open-graph/fastft-v1.jpg",
            "/__assets/creatives/brand-ft/icons/v2/open-graph.png",
            "/__assets/creatives/brand-ft/icons/v2/favicon-",
            "/__assets/creatives/brand-ft/icons/v3/open-graph.png",
            "/img/meta/wsj-social-share.",
            "/img/wsj_logo_black_social.",
            "/img/wsj_profile_lg.",
            "/common/imgs/wsjsection.",
            "/img/social/opengraph/ij-social-default-",
            "axios-placeholder-",
            "/social/breaking-news.png",
            "/include/images/facebook-default.jpg",
            "add-the-print-as-a-trusted-source-",
            # Reading Eagle's WordPress syndication template publishes this
            # masthead card as NewsArticle.image for unrelated NYT stories.
            "readingeagle.com/wp-content/uploads/2021/08/readeag.jpg",
            # NYT Briefing's recurring live-updates cover is a section card,
            # not editorial artwork belonging to any individual article.
            "us-briefing-promo-image-print",
            # Legacy NYT fashion pages use this generic question-mark card as
            # a social fallback when no article artwork is available.
            "/fashion/social_inline/social_inline-",
            # Partner sites can be the best surviving source for an AP wire
            # story, but their structured metadata often supplies a shared
            # brand card instead of editorial art.
            "/fox-news/og/",
            "/today-socialshareimages-bento/",
            "/newsgroup-logos/nbcnews/social/",
            "restrictedimagesub.jpg",
            "/thegrio-default-",
            "google_preferred_source_badge",
        )
    )


def _promote_nyt_image_candidates(urls: list[str]) -> list[str]:
    """Put a real NYT lazy image ahead of its shared transparent shim."""

    editorial = [url for url in urls if not _is_placeholder_image_url(url)]
    placeholders = [url for url in urls if _is_placeholder_image_url(url)]
    return [*editorial, *placeholders]


def _structured_site_branding_image_url(url: str) -> bool:
    leaf = unquote(urlsplit(url).path).casefold().rsplit("/", 1)[-1]
    return bool(
        re.fullmatch(
            r"(?:[a-z0-9]{1,24}[-_])*logo[-_]"
            r"(?:sm|small|lg|large|basic|header|masthead|mobile|desktop|"
            r"\d{2,4}x\d{2,4})"
            r"\.(?:avif|gif|jpe?g|png|webp)",
            leaf,
        )
    )


def _flatten_image_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return _flatten_image_values(value.get("url") or value.get("contentUrl"))
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(_flatten_image_values(item))
        return result
    return []


def _caption_credit(container: Tag) -> tuple[str | None, str | None]:
    caption_node = container.select_one("figcaption, [class*='caption' i]")
    if not caption_node:
        return None, None
    raw = _dedupe_lines(caption_node.get_text("\n", strip=True))
    if not raw:
        return None, None
    match = _CREDIT_RE.search(raw)
    if not match:
        return raw, None
    caption = _clean_text(raw[: match.start()]) or None
    credit = _clean_text(raw[match.start() :]) or None
    if caption and credit and caption.casefold() == credit.casefold():
        caption = None
    return caption, credit


def _npr_caption_credit(container: Tag) -> tuple[str | None, str | None]:
    """Separate legacy NPR cartoon captions from adjacent credit spans."""
    annotated_image = container.select_one("img[data-jojo-npr-caption]")
    if isinstance(annotated_image, Tag):
        return (
            _clean_text(annotated_image.get("data-jojo-npr-caption", ""))
            or None,
            _clean_text(annotated_image.get("data-jojo-npr-credit", ""))
            or None,
        )
    caption_node = container.select_one(
        ".captionwrap .caption, .caption-wrap .caption, figcaption, "
        "[class*='caption' i]"
    )
    caption: str | None = None
    if isinstance(caption_node, Tag):
        copy = BeautifulSoup(str(caption_node), "html.parser").find()
        if isinstance(copy, Tag):
            for hidden in copy.select(
                ".hide-caption, .toggle-caption, .credit"
            ):
                hidden.decompose()
            caption = _clean_text(copy.get_text(" ", strip=True)) or None
    credit_parts: list[str] = []
    seen_credit: set[str] = set()
    for credit_node in container.select(".creditwrap, .credit"):
        value = _clean_text(credit_node.get_text(" ", strip=True))
        key = value.casefold()
        if value and key not in seen_credit:
            credit_parts.append(value)
            seen_credit.add(key)
    credit = " / ".join(credit_parts) or None
    if caption is None and credit is None:
        return _caption_credit(container)
    return caption, credit


def _nyt_caption_credit(container: Tag) -> tuple[str | None, str | None]:
    """Separate legacy NYT credit spans from the visible image caption."""
    caption_node = container.select_one("figcaption, [class*='caption' i]")
    if not isinstance(caption_node, Tag):
        return None, None
    copy = BeautifulSoup(str(caption_node), "html.parser").find()
    if not isinstance(copy, Tag):
        return None, None
    for hidden in copy.select(
        "[class*='visuallyHidden' i], .visually-hidden, .sr-only"
    ):
        hidden.decompose()
    credit_parts: list[str] = []
    credit_nodes = list(
        copy.select(
            "[itemprop='copyrightHolder'], [class*='credit' i], "
            "[data-testid='credit']"
        )
    )
    if not credit_nodes:
        caption, credit = _caption_credit(container)
        if (
            caption
            and credit is None
            and len(caption.split()) <= 12
            and re.search(
                r"(?i)(?:\s+for\s+|/)\s*the new york times$",
                caption,
            )
        ):
            return None, caption
        return caption, credit
    for credit_node in credit_nodes:
        credit_text = _clean_text(credit_node.get_text(" ", strip=True))
        if credit_text and credit_text.casefold() != "credit":
            credit_parts.append(credit_text)
        credit_node.decompose()
    caption = _clean_text(copy.get_text(" ", strip=True)) or None
    credit = _dedupe_lines("\n".join(credit_parts)) or None
    return caption, credit


def _bloomberg_caption_credit(
    container: Tag,
) -> tuple[str | None, str | None]:
    """Keep Bloomberg's explicit figure credit out of the caption field."""
    caption_node = container.select_one("figcaption, [class*='caption' i]")
    if not isinstance(caption_node, Tag):
        return None, None
    copy = BeautifulSoup(str(caption_node), "html.parser").find()
    if not isinstance(copy, Tag):
        return None, None
    credit_parts: list[str] = []
    credit_nodes = list(
        copy.select(
            ".news-figure-credit, [class*='credit' i], "
            "[itemprop='copyrightHolder']"
        )
    )
    if not credit_nodes:
        return _caption_credit(container)
    for credit_node in credit_nodes:
        credit_text = _clean_text(credit_node.get_text(" ", strip=True))
        if credit_text:
            credit_parts.append(credit_text)
        credit_node.decompose()
    caption = _clean_text(copy.get_text(" ", strip=True)) or None
    credit = _dedupe_lines("\n".join(credit_parts)) or None
    if (
        caption
        and credit
        and caption.casefold() == credit.casefold()
    ):
        caption = None
    return caption, credit


def _dedupe_lines(value: str) -> str:
    result: list[str] = []
    seen: set[str] = set()
    for line in value.splitlines():
        clean = _clean_text(line)
        key = clean.casefold()
        if clean and key not in seen:
            result.append(clean)
            seen.add(key)
    return "\n".join(result)


def _extract_authors(
    article: dict[str, Any],
    soup: BeautifulSoup,
    *,
    publisher: str,
) -> list[Author]:
    values: list[str] = []
    source = article.get("author") if article else None
    if isinstance(source, str):
        values.append(source)
    elif isinstance(source, dict):
        name = _string_or_none(source.get("name"))
        if name:
            values.append(name)
    elif isinstance(source, list):
        for item in source:
            if isinstance(item, str):
                values.append(item)
            elif isinstance(item, dict):
                name = _string_or_none(item.get("name"))
                if name:
                    values.append(name)
    if not values:
        meta = _meta_content(soup, "name", "author")
        if meta:
            values.extend(part.strip() for part in meta.split(","))
    if not values and publisher == "scmp":
        legacy_byline = _tag_text(
            soup.select_one(".field-name-field-byline")
        )
        if legacy_byline:
            clean_byline = re.sub(
                r"(?i)\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b",
                "",
                legacy_byline,
            )
            clean_byline = _clean_text(clean_byline).strip(" ,;|")
            if clean_byline:
                values.append(clean_byline)
    result: list[Author] = []
    seen: set[str] = set()
    for value in values:
        clean = _clean_text(value)
        if clean and clean.casefold() not in seen:
            result.append(Author(name=clean))
            seen.add(clean.casefold())
    return result


def _content_type(article: dict[str, Any], canonical_url: str) -> ContentType:
    article_type = article.get("@type") if article else None
    url = canonical_url.casefold()
    if (
        "zaobao.com.sg" in url
        and "/shorts/" in url
    ):
        # Zaobao's modern shorts desk is video-first even when the archived
        # JSON-LD incorrectly declares the package as a NewsArticle.
        return ContentType.VIDEO
    if article_type == "LiveBlogPosting" or re.search(
        r"/(?:live|liveblog)(?:/|$)",
        url,
    ):
        return ContentType.LIVEBLOG
    if "newsletter" in url:
        return ContentType.NEWSLETTER
    if "transcript" in url:
        return ContentType.TRANSCRIPT
    if "podcast" in url:
        return ContentType.AUDIO
    if "opinion" in url:
        return ContentType.OPINION
    if "video" in url:
        return ContentType.VIDEO
    if "/watching/" in url:
        return ContentType.INTERACTIVE
    if "interactive" in url or "/features/" in url:
        return ContentType.INTERACTIVE
    if isinstance(article_type, str) and article_type == "ReportageNewsArticle":
        return ContentType.ARTICLE
    return ContentType.ARTICLE


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


def _looks_like_gallery(
    blocks: list[ContentBlock],
    *,
    allow_uncaptioned: bool = False,
) -> bool:
    image_blocks = [
        block for block in blocks if block.type == BlockType.IMAGE
    ]
    text_blocks = [
        block
        for block in blocks
        if block.type
        in {
            BlockType.PARAGRAPH,
            BlockType.HEADING,
            BlockType.QUOTE,
            BlockType.LIST,
            BlockType.TABLE,
        }
    ]
    caption_characters = sum(
        len(_clean_text(block.caption or ""))
        for block in image_blocks
    )
    text_characters = sum(
        len(_clean_text(block.text or ""))
        for block in text_blocks
    )
    if not image_blocks or len(text_blocks) > 2:
        return False
    if (
        allow_uncaptioned
        and len(image_blocks) >= 3
        and text_characters < _MINIMUM_BODY_CHARACTERS
    ):
        return True
    return bool(
        caption_characters >= 100
        and caption_characters >= text_characters
    )


def _block_plain_text(block: ContentBlock) -> str | None:
    if block.text and block.type in {
        BlockType.PARAGRAPH,
        BlockType.HEADING,
        BlockType.QUOTE,
        BlockType.LIST,
        BlockType.TABLE,
    }:
        return _clean_text(block.text)
    if block.type == BlockType.IMAGE:
        parts: list[str] = []
        for value in (block.caption, block.credit):
            clean = _clean_text(value or "")
            if clean and clean not in parts:
                parts.append(clean)
        return "\n".join(parts) or None
    return None


def _document_language(soup: BeautifulSoup, *, default: str) -> str:
    node = soup.find("html")
    if isinstance(node, Tag):
        value = node.get("lang")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def _meta_content(
    soup: BeautifulSoup,
    attribute: str,
    value: str,
) -> str | None:
    node = soup.select_one(f'meta[{attribute}="{value}"]')
    if not isinstance(node, Tag):
        return None
    return _string_or_none(node.get("content"))


def _tag_text(node: Tag | None) -> str | None:
    return _clean_text(node.get_text(" ", strip=True)) if node else None


def _tag_attribute(node: Tag | None, attribute: str) -> str | None:
    if not isinstance(node, Tag):
        return None
    return _string_or_none(node.get(attribute))


def _nyt_visible_published_at(soup: BeautifulSoup) -> str | None:
    value = _tag_text(soup.select_one(".PostV2__datePublished"))
    if not value:
        return None
    for format_string in ("%B %d, %Y", "%b. %d, %Y", "%b %d, %Y"):
        try:
            parsed = datetime.strptime(value, format_string)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc).isoformat()
    return None


def _bloomberg_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Recover the timestamp rendered by Bloomberg's pre-2015 story template."""
    node = soup.select_one("#story_meta .datestamp noscript")
    if node is None:
        return None
    value = node.get_text(" ", strip=True)
    if not value:
        return None
    try:
        parsed = datetime.strptime(value, "%a %b %d %H:%M:%S GMT %Y")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc).isoformat()


def _ft_legacy_published_at(soup: BeautifulSoup) -> str | None:
    value = _tag_text(
        soup.select_one(".fullstoryBody .time, .fullstory .time")
    )
    if not value:
        return None
    for format_string in ("%B %d, %Y %I:%M %p", "%b %d, %Y %I:%M %p"):
        try:
            parsed = datetime.strptime(value, format_string)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc).isoformat()
    return None


def _wsj_legacy_published_at(soup: BeautifulSoup) -> str | None:
    """Read publication dates serialized by WSJ's pre-Oak templates."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?:publicationDate\s*:\s*|"""
            r"""setMetaData\(\s*["']apublished["']\s*,\s*)"""
            r"""["'](?P<date>\d{4}-\d{2}-\d{2}"""
            r"""(?:T\d{2}:\d{2}(?::\d{2})?)?)["']""",
            value,
        )
        if match:
            return match.group("date")
    return None


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


def _caixin_legacy_published_at(soup: BeautifulSoup) -> str | None:
    value = _clean_text(
        _tag_text(soup.select_one(".focusBody .infobox"))
        or _tag_text(soup.select_one(".focusBody .op"))
        or _tag_text(soup.select_one(".datetime"))
        or ""
    )
    match = re.search(
        r"(?:发表时间\s*[：:]\s*)?(?P<year>20\d{2})年"
        r"(?P<month>\d{1,2})月(?P<day>\d{1,2})日"
        r"(?:\s*(?P<hour>\d{1,2}):(?P<minute>\d{2}))?",
        value,
    )
    if match is None:
        return None
    return (
        f"{int(match.group('year')):04d}-"
        f"{int(match.group('month')):02d}-"
        f"{int(match.group('day')):02d}T"
        f"{int(match.group('hour') or 0):02d}:"
        f"{int(match.group('minute') or 0):02d}:00+08:00"
    )


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


def _caixin_legacy_headline(soup: BeautifulSoup) -> str | None:
    """Skip the empty site-logo ``h1`` in Caixin's legacy template."""

    # Older Caixin pages put an empty ``h1.logo`` before the real headline
    # under ``.the_content``.  ``select_one('h1')`` therefore returns the
    # logo and leaves an otherwise usable article without a headline.
    for node in soup.select(".the_content h1, #Main_Content_Val h1, h1"):
        if "logo" in (node.get("class") or []):
            continue
        value = _tag_text(node)
        if value:
            return value
    return None


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


def _zaobao_embedded_published_at(soup: BeautifulSoup) -> str | None:
    """Read publication time from RSC data or legacy visible date markup."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        if "publication_date" not in value.casefold():
            continue
        # Next.js serializes the Drupal article payload inside a quoted RSC
        # frame, so field names and values commonly appear as \"...\".
        # Removing only escaped quote delimiters leaves other escape sequences
        # untouched and makes both flattened pairs and ordinary JSON match.
        normalized = value.replace(r'\"', '"')
        match = re.search(
            r'''["']publication_date["']\s*(?::|,)\s*["']'''
            r'''(?P<date>20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}'''
            r'''(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)["']''',
            normalized,
            flags=re.IGNORECASE,
        )
        if match is None:
            continue
        published_at = match.group("date")
        if not re.search(r"(?:Z|[+-]\d{2}:?\d{2})$", published_at):
            published_at += "+08:00"
        return published_at
    for node in soup.select("p.date, .date"):
        text = _clean_text(node.get_text(" ", strip=True))
        match = re.search(
            r"(?P<year>20\d{2})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日",
            text,
        )
        if match is not None:
            return (
                f"{int(match.group('year')):04d}-"
                f"{int(match.group('month')):02d}-"
                f"{int(match.group('day')):02d}T00:00:00+08:00"
            )
    return None


def _wsj_legacy_headline(soup: BeautifulSoup) -> str | None:
    """Read headlines serialized by WSJ's legacy video templates."""
    for script in soup.select("script"):
        value = script.string or script.get_text()
        match = re.search(
            r"""(?:articleHeadline|clickTitle)\s*:\s*"""
            r"""(?P<quote>["'])(?P<headline>.+?)(?P=quote)"""
            r"""(?=\s*[,}])""",
            value,
        )
        if match:
            headline = _clean_text(match.group("headline"))
            headline = re.sub(r"(?i)^wsj\.com\s*-\s*", "", headline)
            if headline:
                return headline
    title = _tag_text(soup.select_one("head > title"))
    if title:
        title = re.sub(r"(?i)\s*-\s*wsj\.com\s*$", "", title).strip()
        if title and title.casefold() not in {
            "the wall street journal",
            "wsj",
            "wsj.com",
        }:
            return title
    return None


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        result = isoparse(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if result.tzinfo else result.replace(tzinfo=timezone.utc)


def _first_text(*values: str | None) -> str | None:
    for value in values:
        clean = _clean_text(value or "")
        if clean:
            return clean
    return None


def _clean_text(value: str) -> str:
    unescaped = html_module.unescape(value)
    if re.search(r"[\x80-\x9f]", unescaped):
        unescaped = unescaped.translate(_WINDOWS_1252_C1_TRANSLATION)
    return _SPACE_RE.sub(" ", unescaped).strip()


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _normalized_url(value: Any, *, base_url: str) -> str | None:
    if not isinstance(value, str):
        return None
    value = html_module.unescape(value.strip())
    if not value or value.startswith(("data:", "blob:", "javascript:")):
        return None
    if value.startswith("//"):
        value = "https:" + value
    value = urljoin(base_url, value)
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return value


def _integer_attribute(node: Tag, name: str) -> int | None:
    value = node.get(name)
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str):
        match = re.match(r"^\d+", value)
        if match:
            return int(match.group(0))
    return None


def _absolute_image_dimension(node: Tag, name: str) -> int | None:
    """Read an absolute HTML image dimension without treating percent as px."""

    value = node.get(name)
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+)(?:px)?\s*", value, flags=re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def _inner_html(soup: BeautifulSoup) -> str:
    root = soup.body or soup
    return "".join(str(child) for child in root.contents).strip()
