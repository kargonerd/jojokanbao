from __future__ import annotations

from dataclasses import dataclass


COMMON_REMOVE_SELECTORS = (
    "script",
    "style",
    "noscript",
    "template",
    "[aria-label*='advertisement' i]",
    "[class*='advertisement' i]",
    "[class*='recommended' i]",
    "[class*='related-' i]",
    "[data-testid*='ad-' i]",
    "[data-testid*='related' i]",
    "[data-component*='newsletter' i]",
    "[data-component*='paywall' i]",
    "nav",
    "footer",
)


@dataclass(frozen=True)
class PublisherSpec:
    publisher: str
    parser_version: str
    domains: tuple[str, ...]
    default_language: str
    edition: str | None
    body_selectors: tuple[str, ...]
    remove_selectors: tuple[str, ...] = ()
    text_block_selectors: tuple[str, ...] = ()
    preferred_image_hosts: tuple[str, ...] = ()
    use_structured_article_body: bool = False
    embedded_html_body_keys: tuple[str, ...] = ()


PUBLISHER_SPECS = {
    "ap": PublisherSpec(
        publisher="ap",
        parser_version="ap-parser/0.6.27",
        domains=(
            "apnews.com",
            "hosted.ap.org",
            "hosted2.ap.org",
            "news.yahoo.com",
            "www.google.com",
            "www.huffingtonpost.com",
            "bigstory.ap.org",
        ),
        default_language="en",
        edition="us",
        body_selectors=(
            "[data-key='article']",
            ".RichTextStoryBody",
            "[data-testid='article-body']",
            ".ap-story-table .entry-content",
            "#yn-story .yn-story-content",
            "#hostednews-article .hn-copy > .g-section:first-child",
            ".entry .entry_content",
            ".node-body .node-content",
            # AP wire stories recovered from current partner pages (including
            # Fox and MediaNews sites) expose the exact story in this node;
            # their outer article also contains sharing, newsletter and
            # recommendation rails.
            ".article-body",
            "article",
        ),
        preferred_image_hosts=("dims.apnews.com", "storage.googleapis.com"),
        embedded_html_body_keys=("storyHTML",),
    ),
    "wsj": PublisherSpec(
        publisher="wsj",
        parser_version="wsj-parser/0.8.78",
        domains=("wsj.com", "www.wsj.com"),
        default_language="en",
        edition="us",
        body_selectors=(
            "[data-type='article-body']",
            "[data-testid='article-body']",
            "#wsj-article-wrap",
            "[itemprop='articleBody']",
            ".article-content",
            "#articleTabs_panel_article .article.story",
            "#articleTabs_panel_article",
            "article",
        ),
        remove_selectors=(
            "p[style*='left:-15000px']",
            "#article_tools",
            ".article_tools",
            ".share_tools",
            "[data-module-name$='/shareTools']",
            "#trending_now",
            ".article-breadCrumb-wrapper",
            ".newsletter-home",
            "#newsletter-home",
            ".googlenews",
            "#cx-snippet-overlay",
            ".snippet-promotion",
            ".resume-subscription-scrim-overlay",
            "#livefyre-wrapper",
            "[data-module-name*='livefyre' i]",
            ".jr-module",
            "[data-module-name*='journalReports' i]",
            "#right-rail",
        ),
        preferred_image_hosts=("images.wsj.net", "s.wsj.net"),
    ),
    "bloomberg": PublisherSpec(
        publisher="bloomberg",
        parser_version="bloomberg-parser/0.10.300",
        domains=("bloomberg.com", "www.bloomberg.com"),
        default_language="en",
        edition="global",
        body_selectors=(
            ".body-copy-v2",
            ".body-copy",
            "[data-component='article-body']",
            ".article-body__content",
            "#story_content",
            "article .body-content",
            "article [itemprop='articleBody']",
            "main article[data-story-id]",
            ".dvz-content",
            "#main",
            "article",
        ),
        remove_selectors=(
            "[data-position='in-article']",
            "[data-position='mobile-box']",
            ".right-rail",
            ".recirc",
            ".inline-newsletter",
            ".news-designed-for-consumer-media",
            ".share-article-button",
            "[class*='share-article-button']",
            "#story_social_toolbar_top_container",
            "#story_social_toolbar_bottom",
            "#related_news_bottom",
            ".content-type-footer",
            ".topic-list",
            "table:has(.news-rsf-table-string)",
        ),
        text_block_selectors=(
            ".body-copy-v2 > div:not([class])",
            ".timeline_header #current-title",
            ".event .text",
            ".event .caption",
        ),
        preferred_image_hosts=("assets.bwbx.io", "assets.bwbx.com"),
    ),
    "nyt": PublisherSpec(
        publisher="nyt",
        parser_version="nyt-parser/0.8.158",
        domains=("nytimes.com", "www.nytimes.com"),
        default_language="en",
        edition="us",
        body_selectors=(
            "section[name='articleBody']",
            "[data-testid='article-body']",
            ".StoryBodyCompanionColumn",
            ".story-body",
            ".PostV2__postBody",
            ".Post__body",
            ".interactive-body",
            "article",
        ),
        remove_selectors=(
            ".story-print-citation",
            ".story-footer-links",
            "[data-testid='optimistic-truncator-message']",
            "[class*='relatedcoverage' i]",
            "[class*='Recirculation-' i]",
            ".rad-series-box",
            "#newsletter-module",
            "[class*='Newsletter-wrap']",
            "figure[id^='Newsletter-embed-']",
            "section[role='complementary']"
            "[aria-labelledby='styln-toplinks-title']",
            ".mainTabsContainer",
        ),
        preferred_image_hosts=("static01.nyt.com", "static.nytimes.com"),
    ),
    "reuters": PublisherSpec(
        publisher="reuters",
        parser_version="reuters-parser/0.7.32",
        domains=("reuters.com", "www.reuters.com"),
        default_language="en",
        edition="global",
        body_selectors=(
            "[data-testid='article-body']",
            ".article-body__content",
            "[class*='ArticleBody__content']",
            "[class*='article-body__content']",
            "[class*='StandardArticleBody_body']",
            "[class*='ArticleBody_body']",
            "#articleText",
            "#rcs-articleContent",
            "article",
        ),
        remove_selectors=(
            "[class*='ReadTime-read-time']",
            "[class*='TrustBadge-trust-badge']",
            "[data-testid='promo-box']",
            "[data-testid='ToolbarItemContainer']",
            "[data-testid='LicenceContentButton']",
            "#div_with_disclaimer_id",
            "p:has(a[href*='trust-principles'])",
            ".info-box",
            ".more-on",
        ),
        text_block_selectors=("[data-testid^='paragraph-']",),
        preferred_image_hosts=("cloudfront-us-east-2.images.arcpublishing.com",),
        embedded_html_body_keys=("body",),
    ),
    "ft": PublisherSpec(
        publisher="ft",
        parser_version="ft-parser/0.8.69",
        domains=("ft.com", "www.ft.com"),
        default_language="en",
        edition="global",
        body_selectors=(
            ".article__content-body",
            "#article-body",
            "#storyContent",
            "[data-trackable='article-body']",
            ".article-body[itemprop='articleBody']",
            ".article-body",
            "article",
        ),
        preferred_image_hosts=("www.ft.com", "d1e00ek4ebabms.cloudfront.net"),
        use_structured_article_body=True,
    ),
    "axios": PublisherSpec(
        publisher="axios",
        parser_version="axios-parser/0.1.33",
        domains=("axios.com", "www.axios.com"),
        default_language="en",
        edition="us",
        body_selectors=(
            "[data-testid='article-content']",
            ".ArticleBody",
            ".story-body",
            ".story-body-text",
            ".story-content",
            "[itemprop='articleBody']",
            ".article-body",
            "[class*='DraftjsBlocks_draftjs']",
            "#main-content",
            "article",
        ),
        preferred_image_hosts=("images.axios.com",),
        use_structured_article_body=True,
        embedded_html_body_keys=("articleBody", "body", "content"),
    ),
    "npr": PublisherSpec(
        publisher="npr",
        parser_version="npr-parser/0.1.59",
        domains=("npr.org", "www.npr.org"),
        default_language="en",
        edition="us",
        body_selectors=("#storytext", ".storytext", "[data-testid='storytext']", "article"),
        preferred_image_hosts=("media.npr.org",),
        use_structured_article_body=True,
    ),
    "nikkei": PublisherSpec(
        publisher="nikkei",
        parser_version="nikkei-parser/0.1.11",
        domains=("nikkei.com", "www.nikkei.com", "asia.nikkei.com"),
        default_language="ja",
        edition="jp",
        body_selectors=(
            # Nikkei Asian Review / Nikkei Asia's legacy English template.
            # These pages predate the current nikkei.com component tree and
            # keep the complete story in this dedicated wrapper.
            ".articleBodyText",
            ".article-body",
            ".cmn-article_body",
            ".cmn-article_text",
            "article",
        ),
        preferred_image_hosts=("www.nikkei.com", "asia.nikkei.com"),
        use_structured_article_body=True,
    ),
    "zaobao": PublisherSpec(
        publisher="zaobao",
        parser_version="zaobao-parser/0.1.22",
        domains=("zaobao.com.sg", "www.zaobao.com.sg"),
        default_language="zh",
        edition="sg",
        body_selectors=(
            ".field-name-body",
            ".article-content",
            "#article_content .a_body",
            "#article-content",
            "article",
        ),
        preferred_image_hosts=("www.zaobao.com.sg",),
        use_structured_article_body=True,
    ),
    "aljazeera": PublisherSpec(
        publisher="aljazeera",
        parser_version="aljazeera-parser/0.1.21",
        domains=("aljazeera.com", "www.aljazeera.com"),
        default_language="en",
        edition="global",
        body_selectors=(".wysiwyg", ".article__body", ".article__content", "article"),
        remove_selectors=(".more-on",),
        preferred_image_hosts=("www.aljazeera.com",),
        use_structured_article_body=True,
    ),
    "scmp": PublisherSpec(
        publisher="scmp",
        parser_version="scmp-parser/0.1.53",
        domains=("scmp.com", "www.scmp.com"),
        default_language="en",
        edition="hk",
        body_selectors=(
            ".article__body",
            ".article-body",
            "[data-qa='article-body']",
            # Young Post's 2022 Next.js template renders the story inside a
            # styled-components wrapper and uses bare ``article`` elements
            # only for recommendation cards.  Match the stable component
            # name instead of its generated hash/class suffix.
            "[class*='ArticleContent__StyledBody-']",
            ".pane-node-body .pane-content",
            ".pane-node-body .field-name-body",
            ".field-name-body",
            "article",
        ),
        # Young Post's React/Apollo renderer represents semantic paragraphs
        # as styled ``div`` nodes.  Some releases add a literal ``p`` class
        # while older archived releases do not, so use the stable component
        # name itself. Without this selector the sanitized body is preserved,
        # but block/plain-text extraction sees only nested links.
        text_block_selectors=(
            "[class*='Body__StyledFallBackDiv-']:not(:has(img))",
        ),
        preferred_image_hosts=("cdn.i-scmp.com", "www.scmp.com"),
        use_structured_article_body=True,
    ),
    "caixin": PublisherSpec(
        publisher="caixin",
        parser_version="caixin-parser/0.1.15",
        domains=("caixin.com", "www.caixin.com", "magazine.caixin.com"),
        default_language="zh",
        edition="cn",
        # ``.content`` is a legacy page-layout wrapper on archived Caixin
        # pages. When the real article node is absent it contains rankings,
        # recommendations, sharing controls and subscription forms, which can
        # be long enough to masquerade as a complete article. Only accept
        # article-specific containers here; legacy stories use the explicit
        # #Main_Content_Val override in news_parser.py.
        body_selectors=(".article-content", ".article_body", "article"),
        preferred_image_hosts=("img.caixin.com", "file.caixin.com"),
        use_structured_article_body=True,
    ),
}


def publisher_spec(publisher: str) -> PublisherSpec:
    try:
        return PUBLISHER_SPECS[publisher]
    except KeyError as exc:
        supported = ", ".join(sorted(PUBLISHER_SPECS))
        raise ValueError(
            f"unsupported publisher {publisher!r}; expected one of: {supported}"
        ) from exc
