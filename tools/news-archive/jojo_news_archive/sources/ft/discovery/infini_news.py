from __future__ import annotations

import re


_SIGNIFICANT_TOKEN_RE = re.compile(r"[a-z0-9]+")


def is_ft_subscription_headline(value: str | None) -> bool:
    """Return whether an Infini-News title is a recurring FT access shell."""
    normalized = " ".join(str(value or "").casefold().split())
    # Older Infini-News rows often use the subscription landing-page copy as
    # the title rather than an article headline.  These variants do not
    # contain ``subscribe``/``subscription`` tokens, so handle them before
    # the token-based checks below.  Keeping this predicate title-only avoids
    # rejecting legitimate articles that merely discuss subscriptions.
    if (
        "all the benefits of premium digital" in normalized
        or "all the benefits of standard digital" in normalized
        or normalized.startswith("register to read")
        or normalized.startswith("you must be a premium subscriber to read")
    ):
        return True
    tokens = set(_SIGNIFICANT_TOKEN_RE.findall(normalized))
    if not (
        {"subscribe", "subscriber", "subscription"} & tokens
    ):
        return False
    return (
        "subscribe to read" in normalized
        or "become an ft subscriber" in normalized
        or "subscribe to ft" in normalized
        or "purchase a digital trial" in normalized
        or (
            "subscription" in tokens
            and {"purchase", "digital"}.issubset(tokens)
        )
        or {"ft", "com"}.issubset(tokens)
    )
