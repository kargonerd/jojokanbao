from __future__ import annotations

import re

from .store import Store


TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]{2,}")


def tokens(text: str) -> set[str]:
    return set(TOKEN_RE.findall(text.lower()))


def generate_for_news(store: Store, news_id: str) -> dict:
    detail = store.get_news_detail(news_id)
    if not detail:
        return {"created": 0}

    base = detail["news"]
    base_tokens = tokens(f"{base['title']} {base.get('content') or ''}")
    created = 0
    for candidate in store.list_news(limit=200):
        if candidate["id"] == news_id:
            continue
        candidate_tokens = tokens(f"{candidate['title']} {candidate.get('content') or ''}")
        overlap = base_tokens & candidate_tokens
        if not overlap:
            continue
        score = min(len(overlap) / 10, 1.0)
        reason = "共同线索：" + "、".join(sorted(overlap)[:6])
        if store.create_scrapbook_item(news_id, candidate["id"], reason, score):
            created += 1
    return {"created": created}
