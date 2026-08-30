from __future__ import annotations


CONTENT_AUDIT_FORMAT_VERSION = "jojo-parser-validation-content-audit/6"


# QA rules are versioned independently from the body parser. Changing body
# extraction rotates to a zero-overlap cohort through parser_version; changing
# only a QA rule replays the same sample against the new policy.
_QA_POLICY_REVISIONS = {
    # Archived Al Jazeera LiveBlog shells often contain only the closing
    # notice; exclude those non-recoverable dynamic packages from the article
    # cohort while retaining their raw captures and content type.
    # Short legacy Wayback teaser shells are screened from the text cohort.
    # Individual gallery ``photo-N`` routes are alternate representations of
    # the named gallery article, not independent stories.  Screen them before
    # sampling and rotate existing cohorts so the 800-row denominator cannot
    # contain both representations.
    # CMS ``hold-`` routes are staging aliases of final articles.  Exclude
    # them from both new sampling and replay of previously selected cohorts.
    "aljazeera": 6,
    # AP's canonical UTC timestamp can fall on January 1 while the publisher's
    # own catalog offset still places the article on December 31. Re-evaluate
    # prior rows using the capture timezone instead of the raw UTC year.
    "ap": 1,
    # FT Wayback captures can be subscription-only shells whose document
    # title is exactly "Subscribe to read | Financial Times". Generic
    # ``/content/<uuid>`` sitemap URLs can also redirect to first-party video
    # pages that retain a player and description but no article transcript.
    # Legacy Photo Diary caption packages and Weekend Quiz answer keys are
    # also retained raw but excluded from the text-news denominator.
    # Complete FT pages whose parsed publication timestamp disagrees with the
    # date-less catalog assignment must rotate out of that year's denominator.
    "ft": 7,
    "axios": 7,
    "caixin": 1,
    # SCMP access shells, image-only slideshow/graphic packages, native
    # multimedia shells, archived empty Young Post body containers, corporate
    # About Us/announcement desks, topic-index redirect targets and unrecoverable
    # visual handoffs have no text-article body; explicit liveblog packages
    # are retained as non-text editorial records instead of being mistaken
    # for truncated articles. Young Post answer keys and short Presented
    # multimedia redirects are likewise utility/media packages rather than
    # recoverable text-news articles.
    "scmp": 19,
    # Zaobao's sitemap includes interactive packages, horse-racing result
    # desks, and legacy forum shells with no headline/body. These records are
    # useful raw captures but are not recoverable text-news articles for the
    # parser cohort.
    # A small set of Wayback packages retain only a video teaser, a shorts
    # video shell, or an empty special-report shell. Keep the raw capture,
    # but exclude it from the recoverable text-article denominator.
    # Drupal-era source HTML can contain a long terminal clause duplicated
    # inside one paragraph. Parser 0.1.21 repairs exact tandem suffixes, and
    # QA-6 makes any surviving form a hard validation finding.
    "zaobao": 6,
    # Exclude legacy NYT admin-package pages, image-only editorial cartoons,
    # short live-blog shells, empty archived story shells, Opinion pages that
    # retain only author/footer chrome, and Editors' Note placeholders whose
    # archive snapshot contains no recoverable article body.
    # County-level COVID dashboards remain archived as interactive records,
    # but are excluded from the independent article denominator because the
    # publisher repeats the same prose and image across hundreds of routes.
    # Legacy ``/pageoneplus/quotation-of-the-day`` utility cards are screened
    # alongside their newer ``/todayspaper/`` equivalents.
    # Legacy NYT prose can contain the words "share this article" as an
    # editorial sentence; the generic interface detector now only treats an
    # exact standalone share-control block as noise.
    "nyt": 9,
    # NPR's legacy audio-only pages can retain metadata and a player while
    # exposing no recoverable article body. Keep those captures, but exclude
    # them from the text-article QA denominator.
    "npr": 1,
    # Legacy Nikkei bodies can contain recirculation, subscription and topic
    # panels inside the broad article wrapper. Parser 0.1.10 removes them;
    # rotate the QA cohort so previously accepted records are independently
    # revalidated against the clean-body contract.
    "nikkei": 1,
    # WSJ Infini-News captures can preserve a media-only "Article Not
    # Supported" shell and related subscription chrome without the article
    # body. Keep those raw records but exclude them from text-article QA.
    # WSJ article paragraphs can contain an inline, parenthesized newsletter
    # mention. Only short standalone promo blocks count as interface noise.
    # Legacy Wayback snapshots can also retain a short preview followed by
    # "Get The Full Story / Subscribe or Log In". These are valid raw
    # captures, but not complete article bodies; the QA screen now excludes
    # them from the article denominator.
    # Full Infini-derived articles may retain an unsupported-media notice in
    # hidden source chrome. QA-6 screens that signature only when the parsed
    # body is itself a short shell; long recovered reporting stays eligible.
    "wsj": 6,
    # Reuters press-release bodies can contain legitimate copyright language;
    # the interface-noise rule now limits legal-footer detection to short
    # standalone blocks.
    # Reuters syndicated pages can expose a standalone "Trending Stories"
    # label. The parser now removes that UI node before extraction.
    "reuters": 2,
}


def qa_policy_revision(publisher: str) -> int:
    return _QA_POLICY_REVISIONS.get(publisher, 0)
