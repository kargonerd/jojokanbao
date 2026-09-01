import pytest

from jojo_news_archive.parsing.shards import (
    parser_source_manifest_shard,
    parser_supplemental_manifest_shards,
)


@pytest.mark.parametrize(
    ("publisher", "year", "expected"),
    [
        ("ap", 2010, "ap/2010-2015/sitemap-wayback"),
        ("bloomberg", 2015, "bloomberg/2010-2015/sitemap-wayback"),
        ("ft", 2016, "ft/2016-2026/sitemap-wayback"),
        ("nyt", 2026, "nyt/2016-2026/sitemap-wayback"),
        ("wsj", 2014, "wsj/2010-2015/wayback-urlkey"),
        ("wsj", 2016, "wsj/2016-2026/wayback"),
        ("wsj", 2020, "wsj/2016-2026/wayback"),
        ("reuters", 2015, "reuters/2010-2015/wayback-urlkey"),
        ("reuters", 2016, "reuters/2016-2020/wayback-urlkey"),
        (
            "reuters",
            2021,
            "reuters/2021-2026/reuters-sitemap-wayback",
        ),
        ("axios", 2017, "axios/2017-2026/wayback-urlkey"),
        ("npr", 2020, "npr/2016-2026/wayback-urlkey"),
        ("nikkei", 2011, "nikkei/2010-2015/wayback-urlkey"),
        ("zaobao", 2024, "zaobao/2016-2026/sitemap-wayback"),
        ("aljazeera", 2018, "aljazeera/2016-2026/sitemap-wayback"),
        ("scmp", 2015, "scmp/2010-2015/wayback-urlkey"),
    ],
)
def test_parser_source_manifest_shard(publisher, year, expected):
    assert parser_source_manifest_shard(publisher, year) == expected


@pytest.mark.parametrize(
    ("publisher", "year"),
    [
        ("unknown", 2020),
        ("nyt", 2009),
        ("nyt", 2027),
        ("axios", 2010),
        ("zaobao", 2015),
        ("nikkei", 2012),
        ("nikkei", 2015),
    ],
)
def test_parser_source_manifest_shard_rejects_unsupported_cells(
    publisher,
    year,
):
    with pytest.raises(ValueError):
        parser_source_manifest_shard(publisher, year)


@pytest.mark.parametrize(
    ("publisher", "year", "expected"),
    [
        ("ap", 2012, ("ap/2010-2015/legacy-archive",)),
        (
            "npr",
            2010,
            (
                "npr/2010-2010/official-archive",
                "npr/2010-2010/commoncrawl-prefix",
                "npr/2010-2015/commoncrawl-prefix",
            ),
        ),
        (
            "axios",
            2017,
            (
                "axios/2017-2017/commoncrawl-prefix",
                "axios/2017-2026/sitemap-wayback",
                "axios/2017-2026/commoncrawl-prefix",
                "axios/2017-2026/axios-local-sitemap",
            ),
        ),
        (
            "axios",
            2025,
            (
                "axios/2017-2026/sitemap-wayback",
                "axios/2017-2026/commoncrawl-prefix",
                "axios/2017-2026/axios-local-sitemap",
            ),
        ),
        (
            "npr",
            2012,
            (
                "npr/2012-2012/official-archive",
                "npr/2012-2012/commoncrawl-prefix",
                "npr/2010-2015/commoncrawl-prefix",
                "npr/2012-2016/commoncrawl-prefix",
            ),
        ),
        (
            "npr",
            2016,
            (
                "npr/2016-2016/official-archive",
                "npr/2016-2016/commoncrawl-prefix",
                "npr/2012-2016/commoncrawl-prefix",
                "npr/2013-2026/commoncrawl-prefix",
            ),
        ),
        (
            "npr",
            2013,
            (
                "npr/2013-2013/official-archive",
                "npr/2013-2013/commoncrawl-prefix",
                "npr/2010-2015/commoncrawl-prefix",
                "npr/2012-2016/commoncrawl-prefix",
                "npr/2013-2026/commoncrawl-prefix",
            ),
        ),
        (
            "npr",
            2020,
            (
                "npr/2020-2020/official-archive",
                "npr/2020-2020/commoncrawl-prefix",
                "npr/2013-2026/commoncrawl-prefix",
            ),
        ),
        (
            "nikkei",
            2010,
            (
                "nikkei/2010-2010/commoncrawl-prefix",
                "nikkei/2010-2015/commoncrawl-prefix",
                "nikkei/2010-2016/commoncrawl-asia-probe",
            ),
        ),
        (
            "nikkei",
            2011,
            (
                "nikkei/2011-2011/commoncrawl-prefix",
                "nikkei/2010-2015/commoncrawl-prefix",
                "nikkei/2010-2016/commoncrawl-asia-probe",
            ),
        ),
        ("nikkei", 2024, ("nikkei/2016-2026/commoncrawl-prefix",)),
        (
            "wsj",
            2011,
            (
                "wsj/2010-2015/commoncrawl-prefix",
                "wsj/2010-2013/commoncrawl-legacy-probe",
            ),
        ),
        ("wsj", 2020, ("wsj/2016-2026/commoncrawl-prefix",)),
        (
            "aljazeera",
            2012,
            (
                "aljazeera/2010-2015/commoncrawl-prefix",
                "aljazeera/2010-2015/wayback-urlkey",
            ),
        ),
        (
            "aljazeera",
            2017,
            (
                "aljazeera/2017-2017/commoncrawl-prefix",
                "aljazeera/2016-2026/commoncrawl-prefix",
                "aljazeera/2016-2026/wayback-urlkey",
            ),
        ),
        (
            "aljazeera",
            2024,
            (
                "aljazeera/2016-2026/commoncrawl-prefix",
                "aljazeera/2016-2026/wayback-urlkey",
            ),
        ),
        (
            "scmp",
            2017,
            (
                "scmp/2016-2026/sitemap-wayback",
                "scmp/2016-2026/commoncrawl-prefix",
            ),
        ),
        ("reuters", 2016, ("reuters/2016-2020/commoncrawl-prefix",)),
        ("ft", 2014, ("ft/2010-2015/commoncrawl-prefix",)),
        ("ft", 2020, ("ft/2016-2026/commoncrawl-prefix",)),
    ],
)
def test_parser_supplemental_manifest_shards(publisher, year, expected):
    assert parser_supplemental_manifest_shards(publisher, year) == expected
