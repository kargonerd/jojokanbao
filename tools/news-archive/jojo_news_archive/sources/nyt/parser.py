from __future__ import annotations

import ast
import copy
from datetime import datetime, timezone
import html as html_module
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, unquote, urlsplit, urlunsplit
from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from jojo_news_archive.models import (
    ARCHIVABLE_IMAGE_ROLES,
    Author,
    BlockType,
    ContentBlock,
    ContentType,
    ImageCandidate,
    ImageRole,
)
from jojo_news_archive.parsing.images import (
    generic_image_identity as _generic_image_identity,
    is_placeholder_image_url as _is_placeholder_image_url,
)
from jojo_news_archive.parsing.primitives import (
    caption_credit as _caption_credit,
    clean_text as _clean_text,
    dedupe_lines as _dedupe_lines,
    first_text as _first_text,
    json_object_after_key as _json_object_after_key,
    meta_content as _meta_content,
    normalized_url as _normalized_url,
    string_or_none as _string_or_none,
    tag_attribute as _tag_attribute,
    tag_text as _tag_text,
    walk_json_objects as _walk_json_objects,
)
from jojo_news_archive.parsing.limits import (
    MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
)


def _nyt_source_image_identity(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").casefold()
    path = unquote(parts.path)
    if path.casefold().startswith("/wp-content/uploads/migration/"):
        return f"wordpress-migration-image:{path.casefold()}"

    normalized_legacy_url: str | None = None
    if (
        host == "static01.nyt.com"
        or re.fullmatch(r"(?:graphics|static)\d*\.nytimes\.com", host)
    ):
        rendition_query = parse_qsl(parts.query, keep_blank_values=False)
        if rendition_query and all(
            key.casefold() in {"year", "h", "w", "s", "k", "tw"}
            for key, _ in rendition_query
        ):
            normalized_legacy_url = urlunsplit(
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
    return normalized_legacy_url


def _image_identity(url: str) -> str:
    generic = _generic_image_identity(url)
    return (
        _nyt_source_image_identity(url)
        or _nyt_source_image_identity(generic)
        or generic
    )


_NYT_ATTENDEE_RE = re.compile(
    r'name:"((?:\\.|[^"\\])*)",caption:"((?:\\.|[^"\\])*)"'
)


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


def _promote_nyt_image_candidates(urls: list[str]) -> list[str]:
    """Put a real NYT lazy image ahead of its shared transparent shim."""

    editorial = [url for url in urls if not _is_placeholder_image_url(url)]
    placeholders = [url for url in urls if _is_placeholder_image_url(url)]
    return [*editorial, *placeholders]


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


from jojo_news_archive.parsing.parser_contracts import (
    BaseSourceParser,
    ImageParseContext,
    ParseContext,
)


class NytParser(BaseSourceParser):
    def preprocess(self, context: ParseContext) -> None:
        _repair_nyt_replacement_characters(context.soup, context.html_bytes)
        context.source_data["preloaded_metadata"] = _nyt_preloaded_article_metadata(
            context.soup,
            canonical_url=context.canonical_url,
        )

    def select_body(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.body import (
            select_body as _select_body,
            select_default_body as _select_default_body,
        )
        from jojo_news_archive.parsing.syndication import (
            generic_syndication_allowed as _generic_syndication_allowed,
            generic_syndication_body as _generic_syndication_body,
            postmedia_syndication_body as _postmedia_syndication_body,
        )
        from jojo_news_archive.parsing.primitives import (
            clean_text as _clean_text,
        )
        from jojo_news_archive.parsing.limits import (
            MINIMUM_BODY_CHARACTERS as _MINIMUM_BODY_CHARACTERS,
        )

        soup = context.soup
        canonical_url = context.canonical_url
        body = _nyt_story_body_companions(soup)
        if body is None and _generic_syndication_allowed(context):
            body = _postmedia_syndication_body(soup)
            if body is None:
                body = _generic_syndication_body(soup)
        if body is None:
            body = _nyt_legacy_article_body(soup)
        if body is None and "/watching/" in canonical_url.casefold():
            body = _nyt_watching_body(soup)
        interactive_selected = False
        multi_url_selected = False
        if "/interactive/" in canonical_url.casefold():
            interactive = _nyt_interactive_body(
                soup,
                canonical_url=canonical_url,
            )
            if interactive is not None:
                body = interactive
                interactive_selected = True
                multi_url_selected = _nyt_legacy_multi_url_story_matches(
                    interactive,
                    canonical_url=canonical_url,
                )
        preloaded = _nyt_preloaded_article_body(
            soup,
            canonical_url=canonical_url,
        )
        if preloaded is not None and (
            body is None
            or len(body.get_text(" ", strip=True))
            < len(preloaded.get_text(" ", strip=True))
        ):
            body = preloaded
        embedded = _nyt_preloaded_embedded_interactive_body(
            soup,
            canonical_url=canonical_url,
        )
        if embedded is not None and (
            body is None
            or len(embedded.get_text(" ", strip=True))
            > len(body.get_text(" ", strip=True))
        ):
            body = embedded
            interactive_selected = True
        adventure = _nyt_adventure_resource_body(
            soup,
            dependent_resources=context.dependent_resources,
        )
        if adventure is not None:
            body = adventure
        document_card = _nyt_document_card_body(soup)
        if document_card is not None:
            body = document_card
        sketchbook = _nyt_books_review_sketchbook_body(
            soup,
            canonical_url=canonical_url,
            metadata=context.source_data.get("preloaded_metadata", {}),
        )
        image_led = (
            sketchbook
            or _nyt_single_image_comics_body(soup)
            or _nyt_preloaded_editorial_cartoon_body(soup)
        )
        if image_led is not None:
            body = image_led
            context.structured_image_gallery_selected = True
            context.source_data["books_review_sketchbook_selected"] = (
                sketchbook is not None
            )
        if body is None:
            body = _select_body(soup, context.spec)

        addressed_story_html = (
            str(body)
            if multi_url_selected and isinstance(body, Tag)
            else None
        )
        legacy_interactive = _nyt_legacy_interactive_graphic(soup)
        if legacy_interactive is not None:
            body = legacy_interactive
        embedded_lede = _nyt_embedded_interactive_lede(soup)
        if embedded_lede is not None and (
            body is None
            or _nyt_noninteractive_body_length(body)
            < len(embedded_lede.get_text(" ", strip=True))
        ):
            body = embedded_lede
        for candidate in (
            _nyt_legacy_newsgraphic_body(soup),
            _nyt_legacy_standalone_newsgraphic_body(soup),
            _nyt_escaped_legacy_interactive_body(soup),
            _nyt_legacy_flex_body(soup),
        ):
            if candidate is not None:
                body = candidate
        interactive_documents = _nyt_interactive_document_body(
            soup,
            canonical_url=canonical_url,
        )
        if interactive_documents is not None:
            body_text = _clean_text(body.get_text(" ", strip=True)) if body else ""
            has_document_pages = bool(
                body is not None
                and body.select_one("img[data-src*='/data/documenttools/']")
            )
            if body is None or (
                len(body_text) < 2 * _MINIMUM_BODY_CHARACTERS
                and not has_document_pages
            ):
                body = interactive_documents
            else:
                for embed_node in list(interactive_documents.select("iframe")):
                    body.append(embed_node)
        inline = _nyt_inline_interactive_media(
            soup,
            canonical_url=canonical_url,
        )
        if inline is not None:
            body_text = _clean_text(body.get_text(" ", strip=True)) if body else ""
            if body is None or len(body_text) < _MINIMUM_BODY_CHARACTERS:
                body = inline
            else:
                for child in list(inline.children):
                    body.append(child)
        ballot = _nyt_balloteer_body(soup, canonical_url=canonical_url)
        if ballot is not None:
            if body is None:
                body = ballot
            else:
                for child in list(ballot.children):
                    body.append(child)
        if "/interactive/" in canonical_url.casefold():
            redirect = _nyt_interactive_redirect_body(soup)
            if redirect is not None:
                body = redirect
            metadata_body = _nyt_interactive_metadata_body(soup)
            body_text = _clean_text(body.get_text(" ", strip=True)) if body else ""
            metadata_text = (
                _clean_text(metadata_body.get_text(" ", strip=True))
                if metadata_body is not None
                else ""
            )
            if metadata_body is not None and (
                body is None
                or body.select_one(
                    "p, h1, h2, h3, h4, li, table, figure, iframe, img[src]"
                )
                is None
                or (
                    len(body_text) < 2 * _MINIMUM_BODY_CHARACTERS
                    and body.select_one("img[src], figure, iframe") is None
                    and len(metadata_text) > len(body_text)
                    and metadata_text.casefold() not in body_text.casefold()
                )
            ):
                body = metadata_body
        if addressed_story_html is not None:
            restored = BeautifulSoup(addressed_story_html, "html.parser").select_one(
                "article.story[data-slug]"
            )
            if isinstance(restored, Tag):
                body = restored

        gallery = _nyt_preloaded_image_gallery(soup)
        op_art_found = False
        linked_card_found = False
        if gallery is None:
            gallery = _nyt_legacy_op_art_gallery(soup)
            op_art_found = gallery is not None
        if gallery is None:
            gallery = _nyt_linked_slideshow_card_body(soup)
            linked_card_found = gallery is not None
        if (
            gallery is not None
            and not linked_card_found
            and not interactive_selected
            and (not op_art_found or body is None)
            and _nyt_should_select_gallery_body(soup, body=body)
        ):
            body = gallery
            context.structured_image_gallery_selected = True
        elif (
            gallery is not None
            and body is not None
            and not interactive_selected
            and (_nyt_linked_slideshow_page(soup) or op_art_found)
        ):
            document = BeautifulSoup("<article></article>", "html.parser")
            combined = document.article
            if isinstance(combined, Tag):
                sources = (gallery, body) if op_art_found else (body, gallery)
                for source in sources:
                    for child in list(source.children):
                        combined.append(copy.copy(child))
                body = combined
                context.structured_image_gallery_selected = True
        legacy_video = _nyt_legacy_lede_video_body(soup, body=body)
        if (
            legacy_video is not None
            and not context.structured_image_gallery_selected
            and not interactive_selected
        ):
            body = legacy_video
        body = _select_default_body(context, initial_body=body)
        birdkit = _nyt_birdkit_attendee_body(soup)
        if birdkit is not None:
            body = birdkit
        context.source_data["interactive_body_selected"] = interactive_selected
        context.source_data["legacy_multi_url_story_selected"] = bool(
            multi_url_selected
            and _nyt_legacy_multi_url_story_matches(
                body,
                canonical_url=canonical_url,
            )
        )
        context.body = body

    def clean_body_before_noise(self, context: ParseContext) -> None:
        if context.clean_body is None:
            return
        _remove_nyt_body_chrome(context.clean_body)
        _remove_nyt_promos(context.clean_body)
        _trim_nyt_access_shell_tail(context.clean_body)

    def clean_body_after_noise(self, context: ParseContext) -> None:
        if context.clean_body is not None:
            _remove_nyt_promos(context.clean_body)

    def extract_metadata(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            parse_datetime as _parse_datetime,
        )

        metadata = context.source_data.get("preloaded_metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        context.headline = _first_text(
            _string_or_none(metadata.get("headline")),
            context.headline,
            _tag_text(context.soup.select_one("#article-summary")),
        )
        context.description = _first_text(
            _string_or_none(metadata.get("description")),
            context.description,
        )
        metadata_authors = metadata.get("authors")
        if isinstance(metadata_authors, list) and metadata_authors:
            context.authors = [
                Author(name=value)
                for value in metadata_authors
                if isinstance(value, str) and value.strip()
            ]
        preloaded_published_at = _parse_datetime(
            _string_or_none(metadata.get("published_at"))
        )
        if preloaded_published_at is not None:
            context.published_at = preloaded_published_at
        elif context.published_at is None:
            context.published_at = _parse_datetime(
                _nyt_visible_published_at(context.soup)
            )
        preloaded_modified_at = _parse_datetime(
            _string_or_none(metadata.get("modified_at"))
        )
        if preloaded_modified_at is not None:
            context.modified_at = preloaded_modified_at

    def classify_content(self, context: ParseContext) -> None:
        if "/watching/" in context.canonical_url.casefold():
            context.content_type = ContentType.INTERACTIVE
        context.content_type = _nyt_media_content_type(
            context.soup,
            default=context.content_type,
            structured_image_gallery_selected=(
                context.structured_image_gallery_selected
            ),
            interactive_body_selected=bool(
                context.source_data.get("interactive_body_selected")
            ),
            canonical_url=context.canonical_url,
        )

    def accept_lead_image(self, context: ParseContext, url: str) -> bool:
        if context.source_data.get("legacy_multi_url_story_selected"):
            return False
        if context.source_data.get("books_review_sketchbook_selected"):
            return False
        return not _nyt_non_editorial_lead_image(
            url,
            canonical_url=context.canonical_url,
        )

    def image_identity(self, url: str) -> str | None:
        return _nyt_source_image_identity(url)

    def is_placeholder_image_url(
        self,
        context: ParseContext,
        url: str,
    ) -> bool:
        decoded = unquote(url).casefold()
        return any(
            marker in decoded
            for marker in (
                # NYT's legacy newsgraphics metadata uses this same generic
                # promo-crop filename as Reuters-era templates.
                "/defaultpromocrop.",
                "readingeagle.com/wp-content/uploads/2021/08/readeag.jpg",
                "us-briefing-promo-image-print",
                "/fashion/social_inline/social_inline-",
            )
        )

    def adjust_image_candidate(
        self,
        context: ParseContext,
        image: ImageCandidate,
        *,
        tag: Tag | None,
    ) -> ImageCandidate:
        from jojo_news_archive.parsing.primitives import (
            absolute_image_dimension as _absolute_image_dimension,
            normalized_url as _normalized_url,
        )

        candidates = _promote_nyt_image_candidates(
            list(dict.fromkeys([image.original_url, *image.candidate_urls]))
        )
        if tag is not None:
            media_viewer_source = _normalized_url(
                tag.get("data-mediaviewer-src"),
                base_url=context.canonical_url,
            )
            if media_viewer_source in candidates:
                candidates.remove(media_viewer_source)
                candidates.insert(0, media_viewer_source)
            if candidates and not _is_placeholder_image_url(candidates[0]):
                tag["src"] = candidates[0]
        if candidates and all(
            _is_placeholder_image_url(value) for value in candidates
        ):
            return image.model_copy(
                update={
                    "role": ImageRole.LOGO,
                    "should_archive": False,
                    "selection_reasons": sorted(
                        set(
                            image.selection_reasons
                            + ["generic-publisher-branding"]
                        )
                    ),
                }
            )

        role = image.role
        reasons = list(image.selection_reasons)
        original_url = candidates[0] if candidates else image.original_url
        if _nyt_generic_branding_image(original_url):
            role = ImageRole.LOGO
            reasons.append("generic-publisher-branding")
        if _nyt_author_avatar_image(
            original_url,
            alt=image.alt,
            allow_opinion_social=role != ImageRole.BODY,
        ):
            role = ImageRole.AUTHOR_AVATAR
            reasons.append("author-avatar-url")
        if _nyt_interactive_sprite_image(original_url):
            role = ImageRole.ICON
            reasons.append("interactive-sprite-asset")
        if _nyt_non_editorial_image(original_url):
            role = ImageRole.ICON
            reasons.append("social-or-author-icon-url")

        updates: dict[str, Any] = {
            "original_url": original_url,
            "candidate_urls": candidates,
            "role": role,
            "should_archive": role in ARCHIVABLE_IMAGE_ROLES,
            "selection_reasons": sorted(set(reasons)),
        }
        if tag is not None:
            updates["width"] = _absolute_image_dimension(tag, "width")
            updates["height"] = _absolute_image_dimension(tag, "height")
        return image.model_copy(update=updates)

    def prepare_image(self, context: ImageParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            absolute_image_dimension as _absolute_image_dimension,
            normalized_url as _normalized_url,
        )

        context.candidates = _promote_nyt_image_candidates(context.candidates)
        media_viewer_source = _normalized_url(
            context.image_node.get("data-mediaviewer-src"),
            base_url=context.article.canonical_url,
        )
        if media_viewer_source in context.candidates:
            context.candidates.remove(media_viewer_source)
            context.candidates.insert(0, media_viewer_source)
        if context.candidates and not _is_placeholder_image_url(
            context.candidates[0]
        ):
            context.image_node["src"] = context.candidates[0]
        if context.candidates and all(
            _is_placeholder_image_url(value) for value in context.candidates
        ):
            context.discard = True
        context.width = _absolute_image_dimension(context.image_node, "width")
        context.height = _absolute_image_dimension(context.image_node, "height")
        context.caption, context.credit = _nyt_caption_credit(context.container)

    def retain_nested_block(self, context: ParseContext, node: Tag) -> bool:
        figcaption = node.find_parent("figcaption")
        return bool(
            context.source_data.get("interactive_body_selected")
            and node.name == "p"
            and isinstance(figcaption, Tag)
            and isinstance(node.find_parent("figure"), Tag)
            and len(figcaption.select("p")) >= 2
        )

    def figure_image_nodes(
        self,
        context: ParseContext,
        node: Tag,
        images: list[Tag],
    ) -> list[Tag]:
        return images

    def image_container(
        self,
        context: ParseContext,
        image: Tag,
        container: Tag,
    ) -> Tag:
        if len(container.find_all("img")) <= 1:
            return container
        return _nyt_multi_image_figure_container(image, figure=container)

    def postprocess_output(self, context: ParseContext) -> None:
        from jojo_news_archive.parsing.primitives import (
            looks_like_gallery as _looks_like_gallery,
        )

        if context.content_type == ContentType.ARTICLE and (
            context.structured_image_gallery_selected
            or _looks_like_gallery(context.blocks)
        ):
            context.content_type = ContentType.GALLERY

    def accepts_short_body(self, context: ParseContext) -> bool:
        plain_text = context.plain_text
        if (
            context.content_type == ContentType.GALLERY
            and (
                any(block.type == BlockType.IMAGE for block in context.blocks)
                or any(image.should_archive for image in context.images)
            )
        ):
            return True
        metadata = context.source_data.get("preloaded_metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        if _nyt_image_led_editorial(
            context.soup,
            body=context.clean_body,
            canonical_url=context.canonical_url,
            metadata=metadata,
        ):
            return True
        if context.content_type in {
            ContentType.INTERACTIVE,
            ContentType.VIDEO,
            ContentType.AUDIO,
            ContentType.TRANSCRIPT,
            ContentType.LIVEBLOG,
            ContentType.NEWSLETTER,
        }:
            if any(
                block.type in {BlockType.EMBED, BlockType.IMAGE}
                for block in context.blocks
            ):
                return True
            if (
                context.content_type == ContentType.INTERACTIVE
                and (
                    _nyt_legacy_interactive_shell_document(
                        context.soup,
                        canonical_url=context.canonical_url,
                    )
                    or _nyt_has_interactive_metadata(context.soup)
                )
            ):
                return True
        if not context.headline or len(plain_text) < 50:
            return False
        page_text = _clean_text(
            context.soup.get_text(" ", strip=True)
        ).casefold()
        metropolitan_diary_paragraphs = context.soup.select(
            "p.story-body-text[itemprop='articleBody']"
        )
        metropolitan_diary = bool(
            "/nyregion/metropolitan-diary-"
            in context.canonical_url.casefold()
            and plain_text.casefold().startswith("dear diary:")
            and len(metropolitan_diary_paragraphs) >= 2
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
        return bool(
            (
                "sports briefing" in page_text
                and any(
                    marker in page_text
                    for marker in (
                        "by the associated press",
                        "by associated press",
                        "by reuters",
                    )
                )
            )
            or (
                context.headline.casefold().startswith("corrections:")
                and re.fullmatch(
                    r"(?i)no corrections appeared in print on .+",
                    plain_text,
                )
            )
            or metropolitan_diary
        )

    def quality_warnings(self, context: ParseContext) -> list[str]:
        warnings: list[str] = []
        if (
            context.content_type == ContentType.GALLERY
            and not any(image.should_archive for image in context.images)
        ):
            warnings.append("incomplete-gallery")
        if _nyt_unhydrated_interactive_shell(
            context.soup,
            content_type=context.content_type,
            plain_text=context.plain_text,
            blocks=context.blocks,
            images=context.images,
        ):
            warnings.append("incomplete-interactive")
        return warnings

    def short_body_warning(self, context: ParseContext) -> str | None:
        plain_text = context.plain_text
        if not context.headline or len(plain_text) < 50:
            return None
        page_text = _clean_text(
            context.soup.get_text(" ", strip=True)
        ).casefold()
        paragraphs = context.soup.select(
            "p.story-body-text[itemprop='articleBody']"
        )
        diary = bool(
            "/nyregion/metropolitan-diary-"
            in context.canonical_url.casefold()
            and plain_text.casefold().startswith("dear diary:")
            and len(paragraphs) >= 2
            and not re.search(r"(?:\.\.\.|…)\s*$", plain_text)
        )
        structured = bool(
            (
                "sports briefing" in page_text
                and any(
                    marker in page_text
                    for marker in (
                        "by the associated press",
                        "by associated press",
                        "by reuters",
                    )
                )
            )
            or (
                context.headline.casefold().startswith("corrections:")
                and re.fullmatch(
                    r"(?i)no corrections appeared in print on .+",
                    plain_text,
                )
            )
            or diary
        )
        return "structured-short-record" if structured else None


PARSER: NytParser = NytParser()
