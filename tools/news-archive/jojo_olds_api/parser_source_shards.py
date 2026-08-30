from __future__ import annotations


SUPPORTED_YEARS = range(2010, 2027)

# A source shard is only a validation candidate when the publisher existed
# and the configured public archive can plausibly contain its own articles.
_PUBLISHER_MINIMUM_YEARS = {
    "axios": 2017,
    "zaobao": 2016,
}

# Independent B2 audits exhausted thousands of archived ``www.nikkei.com``
# captures for these years.  Wayback and Common Crawl consistently contain
# only the publisher's signed-out 200-character paid excerpt, and the separate
# Nikkei Asia probe still does not provide an 800-article full-text pool.
# URL counts therefore overstate usable source capacity.  Keep these cells out
# of the formal 800-article scheduler until an independent full-text source is
# added; the raw catalogs remain preserved for future source research.
_PROVEN_FULL_TEXT_UNAVAILABLE_YEARS = {
    "nikkei": frozenset(range(2012, 2016)),
}


def parser_source_manifest_shard(publisher: str, year: int) -> str:
    if year not in SUPPORTED_YEARS:
        raise ValueError("parser validation year must be between 2010 and 2026")
    minimum_year = _PUBLISHER_MINIMUM_YEARS.get(publisher)
    if minimum_year is not None and year < minimum_year:
        raise ValueError(
            f"{publisher} validation is unavailable before {minimum_year}"
        )
    if year in _PROVEN_FULL_TEXT_UNAVAILABLE_YEARS.get(publisher, ()):
        raise ValueError(
            f"{publisher} full-text validation is unavailable for {year}"
        )
    if publisher == "reuters":
        if year <= 2015:
            return "reuters/2010-2015/wayback-urlkey"
        if year <= 2020:
            return "reuters/2016-2020/wayback-urlkey"
        return "reuters/2021-2026/reuters-sitemap-wayback"
    if publisher in {"ap", "bloomberg", "ft", "nyt"}:
        window = "2010-2015" if year <= 2015 else "2016-2026"
        return f"{publisher}/{window}/sitemap-wayback"
    if publisher == "aljazeera":
        window = "2010-2015" if year <= 2015 else "2016-2026"
        return f"aljazeera/{window}/sitemap-wayback"
    if publisher == "zaobao":
        return "zaobao/2016-2026/sitemap-wayback"
    if publisher == "wsj":
        window = "2010-2015" if year <= 2015 else "2016-2026"
        # The URL-key shard is a compact pre-index.  The replay manifest has
        # materially broader coverage for current-era WSJ years and remains
        # the canonical source root for any newly captured raw object.
        if year >= 2016:
            return f"wsj/{window}/wayback"
        return f"wsj/{window}/wayback-urlkey"
    if publisher == "axios":
        return "axios/2017-2026/wayback-urlkey"
    if publisher in {"npr", "nikkei", "scmp", "caixin"}:
        window = "2010-2015" if year <= 2015 else "2016-2026"
        return f"{publisher}/{window}/wayback-urlkey"
    raise ValueError(f"unsupported parser publisher: {publisher}")


def parser_supplemental_manifest_shards(
    publisher: str,
    year: int,
) -> tuple[str, ...]:
    """Return catalog-only sources merged into a validation cell."""
    # Validate the cell and keep its supported-year semantics aligned with
    # parser_source_manifest_shard before deriving supplemental paths.
    parser_source_manifest_shard(publisher, year)
    if publisher == "ap" and year <= 2015:
        return ("ap/2010-2015/legacy-archive",)
    if publisher == "reuters":
        window = (
            "2010-2015"
            if year <= 2015
            else "2016-2020"
            if year <= 2020
            else "2021-2026"
        )
        return (f"reuters/{window}/commoncrawl-prefix",)
    if publisher == "npr":
        # NPR's public date archive is an independently enumerated, per-year
        # catalog.  The accelerator already merges it as its official-archive
        # source; expose the same shard to the watchdog so a completed catalog
        # can satisfy the 800-article capacity gate.
        shards = [
            f"npr/{year}-{year}/official-archive",
            f"npr/{year}-{year}/commoncrawl-prefix",
        ]
        # The legacy 2010--2015 catalog is a separate, now-complete
        # checkpoint. Include it for early cells so the watchdog can use its
        # capacity sidecar and the accelerator can merge its candidates.
        if year <= 2015:
            shards.append("npr/2010-2015/commoncrawl-prefix")
        # A completed broad NPR catalog covers 2012--2016 and contains
        # substantially more dated candidates than the early per-year
        # supplements. Keep both sources in the capacity union so a cell can
        # reopen when that catalog is present without discarding the existing
        # per-year checkpoint.
        if 2012 <= year <= 2016:
            shards.append("npr/2012-2016/commoncrawl-prefix")
        # A second broad checkpoint scans newer Common Crawl collections. It
        # remains separate so later collection growth can add genuinely new,
        # zero-overlap candidates without rewriting the older checkpoint.
        if 2013 <= year <= 2026:
            shards.append("npr/2013-2026/commoncrawl-prefix")
        return tuple(shards)
    if publisher == "caixin":
        return (f"caixin/{year}-{year}/commoncrawl-prefix",)
    if publisher == "ft":
        # FT's sitemap/Wayback catalog is rich in URLs but many historical
        # replays are subscription shells.  Keep a separately checkpointed
        # Common Crawl catalog so validation can try an independent captured
        # response without replacing the canonical source shard.
        window = "2010-2015" if year <= 2015 else "2016-2026"
        return (f"ft/{window}/commoncrawl-prefix",)
    if publisher == "axios":
        shards = [
            "axios/2017-2026/sitemap-wayback",
            "axios/2017-2026/commoncrawl-prefix",
            "axios/2017-2026/axios-local-sitemap",
        ]
        if year in {2017, 2018, 2026}:
            shards.insert(0, f"axios/{year}-{year}/commoncrawl-prefix")
        return tuple(shards)
    if publisher == "nikkei":
        window = "2010-2015" if year <= 2015 else "2016-2026"
        shards = []
        if year in {2010, 2011}:
            shards.append(f"nikkei/{year}-{year}/commoncrawl-prefix")
        shards.append(f"nikkei/{window}/commoncrawl-prefix")
        # asia.nikkei.com used legacy section paths that are absent from the
        # canonical www.nikkei.com prefix catalog. The isolated probe is
        # hydrated and dated independently, then merged only for years it
        # actually covers.
        if year <= 2016:
            shards.append("nikkei/2010-2016/commoncrawl-asia-probe")
        return tuple(shards)
    if publisher == "wsj":
        # The early URL-key catalog is thin for several years (notably
        # 2010, 2011, and 2013).  Keep Common Crawl as an independent
        # catalog-only supplement so those years can be reopened when the
        # primary Wayback shard cannot supply 800 distinct articles.
        window = "2010-2015" if year <= 2015 else "2016-2026"
        shards = [f"wsj/{window}/commoncrawl-prefix"]
        # Legacy online.wsj.com article keys do not encode dates and were
        # therefore absent from canonical URL-date discovery. The dedicated
        # WARC-hydrated probe covers only the sparse 2010--2013 cells.
        if year <= 2013:
            shards.append("wsj/2010-2013/commoncrawl-legacy-probe")
        return tuple(shards)
    if publisher == "aljazeera":
        window = "2010-2015" if year <= 2015 else "2016-2026"
        shards = [
            f"aljazeera/{window}/commoncrawl-prefix",
            f"aljazeera/{window}/wayback-urlkey",
        ]
        if year in {2016, 2017, 2018}:
            shards.insert(0, f"aljazeera/{year}-{year}/commoncrawl-prefix")
        return tuple(shards)
    if publisher == "scmp":
        window = "2010-2015" if year <= 2015 else "2016-2026"
        # The official monthly archive is an independent URL enumeration
        # source and is materially broader than both the URL-key and Common
        # Crawl catalogs for recent historical years. Keep both supplements;
        # the accelerator merges them by canonical URL before sampling.
        return (
            f"scmp/{window}/sitemap-wayback",
            f"scmp/{window}/commoncrawl-prefix",
        )
    return ()
