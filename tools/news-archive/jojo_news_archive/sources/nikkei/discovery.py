from __future__ import annotations

import re


def _nikkei_article_year_hint(value: str) -> int | None:
    article_key = value.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    encoded_years = re.findall(r"C(\d{2})A", article_key)
    if encoded_years:
        return 2000 + int(encoded_years[-1])
    # Some keys use the shorter ``_<letter><year digit>A`` form without a
    # two-digit C-year segment.  That family was introduced in the 2010s.
    short_match = re.search(r"_[A-Z](\d)A", article_key)
    if short_match is not None:
        return 2010 + int(short_match.group(1))
    return None
