from __future__ import annotations

from datetime import datetime, timezone
from difflib import SequenceMatcher
import re
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, NavigableString, Tag
from jojo_news_archive.models import BlockType, ContentType, ImageCandidate
from jojo_news_archive.parsing.primitives import (
    clean_text as _clean_text,
    first_text as _first_text,
    meta_content as _meta_content,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _ft_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    if (
        host in {"images.ft.com", "d1e00ek4ebabms.cloudfront.net"}
        or re.fullmatch(r"(?:www-)?images-ft-com\.ezproxy\..+", host)
    ):
        asset = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12})",
            unquote(parts.path),
            flags=re.IGNORECASE,
        )
        if asset is not None:
            return f"ft-image:{asset.group(1).casefold()}"
    if (
        host in {"swissinfo.ch", "www.swissinfo.ch"}
        and unquote(parts.path).casefold().startswith(
            "/content/wp-content/uploads/"
        )
    ):
        return urlunsplit(
            (
                parts.scheme.casefold(),
                parts.netloc.casefold(),
                parts.path,
                "",
                "",
            )
        )
    if host in {"ft.com", "www.ft.com"} and "/images/raw/" in parts.path:
        nested = unquote(parts.path.split("/images/raw/", 1)[1])
        for _ in range(4):
            nested_parts = urlsplit(nested)
            if "/images/raw/" not in nested_parts.path:
                break
            nested = unquote(nested_parts.path.split("/images/raw/", 1)[1])
        nested_parts = urlsplit(nested)
        if nested_parts.scheme in {"http", "https"} and nested_parts.netloc:
            normalized = urlunsplit(
                (
                    nested_parts.scheme.casefold(),
                    nested_parts.netloc.casefold(),
                    nested_parts.path,
                    "",
                    "",
                )
            )
            return _ft_image_identity(normalized) or normalized
    if (
        host in {"irishtimes.com", "www.irishtimes.com"}
        and parts.path.casefold().startswith("/resizer/v2/")
    ):
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
    if host in {
        "prod-upp-image-read.ft.com",
        "com.ft.imagepublish.upp-prod-eu.s3.amazonaws.com",
    }:
        asset = re.search(
            r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            r"[0-9a-f]{4}-[0-9a-f]{12})(?:$|[./])",
            parts.path,
            flags=re.IGNORECASE,
        )
        if asset is not None:
            return f"ft-image:{asset.group(1).casefold()}"
    return None


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


from jojo_news_archive.models import CaptureProvider
from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


def _ft_structured_article_body(news_article: dict[str, Any]) -> Tag | None:
    value = news_article.get("articleBody")
    if not isinstance(value, str):
        return None
    paragraphs = _clean_ft_structured_paragraphs(
        [
            paragraph
            for paragraph in re.split(r"\n\s*\n", value)
            if _clean_text(paragraph)
        ]
    )
    if not paragraphs:
        return None
    document = BeautifulSoup("<article></article>", "html.parser")
    article = document.article
    if not isinstance(article, Tag):
        return None
    for raw_paragraph in paragraphs:
        media_nodes, paragraph = _ft_structured_media_nodes(
            document,
            raw_paragraph,
        )
        if _FT_STRUCTURED_TERMINAL_CHROME_RE.match(_clean_text(paragraph)):
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
    return article


def _deduplicate_ft_pull_quotes(
    blocks: list[ContentBlock],
) -> list[ContentBlock]:
    textual = {BlockType.PARAGRAPH, BlockType.QUOTE}
    excluded: set[int] = set()
    for index, block in enumerate(blocks):
        if block.type not in textual or not block.text:
            continue
        normalized = _clean_text(block.text).casefold()
        if len(normalized) < 60:
            continue
        decorative = (
            block.type == BlockType.PARAGRAPH
            and not normalized.rstrip().endswith((".", "?", "!", "”", '"'))
        )
        if block.type != BlockType.QUOTE and not decorative:
            continue
        for other_index, other in enumerate(blocks):
            if (
                other_index == index
                or abs(other_index - index) > 3
                or other.type not in textual
                or not other.text
            ):
                continue
            other_text = _clean_text(other.text).casefold()
            if len(other_text) > len(normalized) and normalized in other_text:
                excluded.add(index)
                break
    from jojo_news_archive.parsing.primitives import (
        deduplicate_blocks as _deduplicate_blocks,
    )

    return _deduplicate_blocks(
        [block for index, block in enumerate(blocks) if index not in excluded]
    )


def _clean_ft_syndication_partner_noise(
    body: Tag,
    source_document: BeautifulSoup,
) -> None:
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
    if hostname != "euro2day.gr" and not hostname.endswith(".euro2day.gr"):
        return
    for node in list(
        body.select(
            ".sidebar, #cpContent_pnlCopyright, #cpContent_pnlFTsponsor, "
            ".article-socail-bar-comments, .social-bottom, .bnrwrp, "
            ".adsbygoogle, .comments, .e2ddiscover, .thumbnail"
        )
    ):
        node.decompose()


class FtParser(BaseSourceParser):
    def preprocess(self, context: ParseContext) -> None:
        _repair_ft_damaged_smart_quotes(context.soup)

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.syndication import (
            generic_syndication_body as _generic_syndication_body,
            postmedia_syndication_body as _postmedia_syndication_body,
        )

        body = None
        syndicated = bool(
            context.allow_generic_syndication
            or (
                context.raw_capture is not None
                and context.raw_capture.selected_candidate.provider
                in {CaptureProvider.OTHER, CaptureProvider.INFINI_NEWS}
            )
        )
        if syndicated:
            body = _postmedia_syndication_body(context.soup)
            if body is None:
                body = _generic_syndication_body(
                    context.soup,
                    partner_noise_cleaner=_clean_ft_syndication_partner_noise,
                )
        if body is None:
            body = _select_body(context.soup, context.spec)
        crossword = _ft_crossword_body(context.soup, body=body)
        if crossword is not None:
            body = crossword
            context.source_data["crossword_selected"] = True
        context.body = _select_default_body(
            context,
            initial_body=body,
            apply_structured=False,
            partner_noise_cleaner=_clean_ft_syndication_partner_noise,
        )
        if context.spec.use_structured_article_body:
            from jojo_news_archive.parsing.body import (
                prefer_structured_body_with_media as _prefer_structured_body_with_media,
            )

            structured = _ft_structured_article_body(context.news_article)
            if context.body is None:
                context.body = structured
            elif structured is not None:
                context.body = _prefer_structured_body_with_media(
                    context.body,
                    structured_body=structured,
                )

    def clean_body_after_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _remove_ft_body_chrome(context.clean_body)
        _remove_ft_newsletter_promos(context.clean_body)
        _strip_ft_copyright_suffixes(context.clean_body)

    def is_noise_node(
        self,
        context: ParseContext,
        node: Tag,
        text: str,
    ) -> bool:
        return bool(
            (len(text) >= 2 and set(text) == {"_"})
            or (
                node.name == "p"
                and text.startswith("copyright the financial times limited")
                and "please don't " in text
                and "articles from ft.com" in text
            )
        )

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            parse_datetime as _parse_datetime,
        )

        if context.headline:
            context.headline = re.sub(
                r"(?i)\s*[-–—]\s*FT\.com\s*$",
                "",
                context.headline,
            ).strip()
        if context.published_at is None:
            context.published_at = _parse_datetime(
                _ft_legacy_published_at(context.soup)
            )

    def classify_content(self, context: ParseContext) -> None:
        missing_visual = _ft_missing_legacy_visual(context.soup)
        context.source_data["missing_legacy_visual"] = missing_visual
        if context.source_data.get("crossword_selected"):
            context.content_type = ContentType.INTERACTIVE
        if missing_visual:
            context.content_type = ContentType.GALLERY
        if context.soup.select_one(
            ".flashcomponent a.flashlink[href*='.swf' i]"
        ):
            context.content_type = ContentType.INTERACTIVE

    def adjust_image_candidate(
        self,
        context: ParseContext,
        image: ImageCandidate,
        *,
        tag: Tag | None,
    ) -> ImageCandidate:
        candidates = _promote_ft_image_candidates(
            list(dict.fromkeys([image.original_url, *image.candidate_urls]))
        )
        return image.model_copy(
            update={
                "original_url": candidates[0],
                "candidate_urls": candidates,
            }
        )

    def prepare_image(self, context: ImageParseContext) -> None:
        context.candidates = _promote_ft_image_candidates(context.candidates)

    def image_identity(self, url: str) -> str | None:
        return _ft_image_identity(url)

    def transform_lead_image_urls(
        self,
        context: ParseContext,
        urls: list[str],
    ) -> list[str]:
        return _promote_ft_image_candidates(urls)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                "/m/img/social/og-ft-logo",
                "bc1ec196-2767-11e2-8c4f-00144feabdc0.gif",
                "0db36b94-146a-11e7-80f4-13e067d5072c",
                "static.euro2day.gr/images/fbdefault.jpg",
                "/images/ft.png",
                "/__assets/creatives/open-graph/ft-v1.jpg",
                "/__assets/creatives/open-graph/fastft-v1.jpg",
                "/__assets/creatives/brand-ft/icons/v2/open-graph.png",
                "/__assets/creatives/brand-ft/icons/v2/favicon-",
                "/__assets/creatives/brand-ft/icons/v3/open-graph.png",
            )
        )

    def postprocess_blocks(self, context: ParseContext) -> None:
        context.blocks = _deduplicate_ft_pull_quotes(context.blocks)

    def postprocess_output(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            looks_like_gallery as _looks_like_gallery,
        )

        images = context.images
        if context.content_type == ContentType.ARTICLE and (
            context.structured_image_gallery_selected
            or _looks_like_gallery(
                context.blocks,
                allow_uncaptioned=True,
            )
            or _ft_image_led_article(
                context.news_article,
                body_characters=len(context.plain_text),
                images=images,
            )
        ):
            context.content_type = ContentType.GALLERY

    def accepts_short_body(self, context: ParseContext) -> bool:
        if (
            context.content_type == ContentType.GALLERY
            and (
                any(block.type == BlockType.IMAGE for block in context.blocks)
                or any(image.should_archive for image in context.images)
            )
        ):
            return True
        return bool(
            context.content_type
            in {
                ContentType.INTERACTIVE,
                ContentType.VIDEO,
                ContentType.AUDIO,
                ContentType.TRANSCRIPT,
                ContentType.LIVEBLOG,
                ContentType.NEWSLETTER,
            }
            and any(
                block.type in {BlockType.EMBED, BlockType.IMAGE}
                for block in context.blocks
            )
        )

    def quality_warnings(self, context: ParseContext) -> list[str]:
        warnings: list[str] = []
        if (
            _ft_explicit_truncation_notice(context.soup)
            or _ft_infini_access_shell(context.soup)
        ):
            warnings.append("truncated-body")
        if (
            context.source_data.get("missing_legacy_visual")
            and not any(image.should_archive for image in context.images)
            and not any(
                block.type in {BlockType.IMAGE, BlockType.EMBED}
                for block in context.blocks
            )
        ):
            warnings.append("incomplete-gallery")
        return warnings


PARSER: FtParser = FtParser()
