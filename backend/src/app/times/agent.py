from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import html
import re

from .store import Store


TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}|[\u4e00-\u9fff]{2,8}")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？.!?])\s+|\n+")
TAG_RE = re.compile(r"<[^>]+>")
DATE_RE = re.compile(r"((?:19|20)\d{2}[年/-]\d{1,2}(?:[月/-]\d{1,2}日?)?|\d{1,2}月\d{1,2}日|(?:19|20)\d{2})")

STOP_WORDS = {
    "about",
    "after",
    "all",
    "also",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "being",
    "but",
    "by",
    "can",
    "do",
    "for",
    "from",
    "get",
    "has",
    "have",
    "he",
    "her",
    "his",
    "how",
    "in",
    "is",
    "it",
    "its",
    "into",
    "just",
    "like",
    "may",
    "more",
    "new",
    "news",
    "no",
    "not",
    "now",
    "of",
    "off",
    "on",
    "one",
    "or",
    "our",
    "out",
    "over",
    "said",
    "says",
    "she",
    "so",
    "that",
    "than",
    "the",
    "them",
    "then",
    "there",
    "they",
    "their",
    "this",
    "to",
    "up",
    "was",
    "we",
    "what",
    "when",
    "who",
    "will",
    "with",
    "would",
    "you",
    "your",
    "一个",
    "一些",
    "不是",
    "以及",
    "他们",
    "但是",
    "关于",
    "其中",
    "可以",
    "已经",
    "我们",
    "报道",
    "新闻",
    "正在",
    "没有",
    "这个",
    "这些",
    "通过",
}


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    text = TAG_RE.sub(" ", value)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def shorten(value: str, max_length: int = 180) -> str:
    text = clean_text(value)
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def split_sentences(value: str | None) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    pieces = [piece.strip() for piece in SENTENCE_SPLIT_RE.split(text) if piece.strip()]
    if len(pieces) == 1 and len(pieces[0]) > 220:
        return [pieces[0][index : index + 160].strip() for index in range(0, len(pieces[0]), 160)]
    return pieces


def normalize_token(token: str) -> str:
    normalized = token.strip("._-:/,;!?()[]{}\"'").lower()
    if normalized.isdigit() or normalized in STOP_WORDS:
        return ""
    if len(normalized) < 2:
        return ""
    if len(normalized) == 2 and normalized not in {"ai", "us", "uk", "eu"}:
        return ""
    return normalized


def tokenize(value: str | None) -> list[str]:
    tokens: list[str] = []
    for raw in TOKEN_RE.findall(clean_text(value)):
        token = normalize_token(raw)
        if token:
            tokens.append(token)
    return tokens


def article_text(news: dict) -> str:
    return " ".join(
        clean_text(part)
        for part in [news.get("title"), news.get("summary"), news.get("content")]
        if part
    )


def top_terms(items: list[dict] | dict, limit: int = 12) -> list[dict]:
    counter: Counter[str] = Counter()
    articles = items if isinstance(items, list) else [items]
    for item in articles:
        title_tokens = tokenize(item.get("title"))
        body_tokens = tokenize(f"{item.get('summary') or ''} {item.get('content') or ''}")
        counter.update(body_tokens)
        counter.update({token: 2 for token in title_tokens})
    return [{"name": token, "weight": count} for token, count in counter.most_common(limit)]


def score_related(base: dict, candidate: dict) -> tuple[float, list[str]]:
    base_tokens = set(tokenize(article_text(base)))
    candidate_tokens = set(tokenize(article_text(candidate)))
    if not base_tokens or not candidate_tokens:
        return 0.0, []
    overlap = sorted(base_tokens & candidate_tokens)
    score = len(overlap) / max(len(base_tokens | candidate_tokens), 1)
    return min(score * 4, 1.0), overlap[:8]


def related_context(store: Store, news: dict, limit: int = 5) -> list[dict]:
    ranked: list[tuple[float, list[str], dict]] = []
    for candidate in store.list_news(limit=240):
        if candidate["id"] == news["id"]:
            continue
        score, overlap = score_related(news, candidate)
        if score <= 0:
            continue
        ranked.append((score, overlap, candidate))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "id": candidate["id"],
            "title": candidate["title"],
            "source": candidate.get("source"),
            "publishedAt": candidate.get("publishedAt"),
            "url": candidate.get("url"),
            "score": round(score, 3),
            "reason": "共同线索：" + "、".join(overlap[:5]),
        }
        for score, overlap, candidate in ranked[:limit]
    ]


def classify_entity(term: str) -> str:
    lower = term.lower()
    if lower in {"ai", "openai", "google", "microsoft", "apple", "nvidia", "tesla"}:
        return "organization"
    if lower in {"china", "us", "usa", "europe", "russia", "ukraine", "中国", "美国", "欧洲"}:
        return "place"
    if any(keyword in lower for keyword in ["ai", "tech", "data", "market", "policy", "climate", "health"]):
        return "topic"
    return "topic"


def extract_entities_from_text(text: str, limit: int = 16) -> list[dict]:
    counter = Counter(tokenize(text))
    entities: list[dict] = []
    for name, count in counter.most_common(limit):
        confidence = min(0.48 + count * 0.08, 0.92)
        entities.append({"name": name, "type": classify_entity(name), "confidence": round(confidence, 2)})
    return entities


def build_timeline(news: dict, entity: str | None = None) -> list[dict]:
    text = article_text(news)
    sentences = split_sentences(text)
    timeline: list[dict] = [
        {
            "date": news.get("publishedAt"),
            "label": "发布",
            "detail": shorten(news.get("title") or "", 96),
            "articleId": news.get("id"),
        }
    ]
    seen = {str(news.get("publishedAt"))}
    for sentence in sentences:
        if entity and entity.lower() not in sentence.lower():
            continue
        for match in DATE_RE.findall(sentence):
            if match in seen:
                continue
            seen.add(match)
            timeline.append(
                {
                    "date": match,
                    "label": "文内时间",
                    "detail": shorten(sentence, 120),
                    "articleId": news.get("id"),
                }
            )
            if len(timeline) >= 6:
                return timeline
    return timeline


def make_tldr(news: dict) -> str:
    title = clean_text(news.get("title"))
    sentences = split_sentences(news.get("summary") or news.get("content"))
    lead = next((sentence for sentence in sentences if sentence and sentence != title), "")
    if lead:
        return shorten(f"{title}。{lead}", 240)
    return shorten(title, 240)


def make_key_points(news: dict, terms: list[dict]) -> list[str]:
    sentences = split_sentences(news.get("summary") or news.get("content"))
    points: list[str] = []
    for sentence in sentences:
        point = shorten(sentence, 128)
        if point and point not in points:
            points.append(point)
        if len(points) >= 4:
            break
    for term in terms:
        if len(points) >= 4:
            break
        points.append(f"继续留意“{term['name']}”相关事实是否有后续来源补充。")
    return points[:4]


def make_questions(news: dict, terms: list[dict]) -> list[str]:
    source_name = (news.get("source") or {}).get("name") or "原文来源"
    names = [term["name"] for term in terms[:3]]
    while len(names) < 3:
        names.append("核心议题")
    return [
        f"{source_name} 的报道中，哪些信息是事实，哪些仍是判断？",
        f"如果把“{names[0]}”作为主线，后续最该跟踪的变量是什么？",
        f"这条新闻与“{names[1]}”或“{names[2]}”相关历史报道之间，是延续还是反转？",
    ]


def make_stance_checks(news: dict) -> list[str]:
    source_name = (news.get("source") or {}).get("name") or "原文来源"
    return [
        f"来源检查：先确认 {source_name} 是否给出一手材料、采访对象或公开文件。",
        "证据检查：把数字、引语和结论拆开看，避免把评论当成事实。",
        "缺口检查：注意文中没有出现的相关方、时间范围和反面证据。",
    ]


def build_briefing(store: Store, news_id: str) -> dict | None:
    detail = store.get_news_detail(news_id)
    if not detail:
        return None
    news = detail["news"]
    terms = top_terms(news, limit=12)
    related = related_context(store, news)
    return {
        "articleId": news_id,
        "agent": {
            "name": "Pi Agent",
            "loop": [
                {"step": "Perceive", "description": "抓取标题、来源、发布时间、重复词和段落线索。"},
                {"step": "Interpret", "description": "把事实、判断、历史关联和证据缺口拆开。"},
                {"step": "Inquire", "description": "给出下一轮追问，让读者继续验证而不是被动接受摘要。"},
            ],
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tldr": make_tldr(news),
        "keyPoints": make_key_points(news, terms),
        "entities": extract_entities_from_text(article_text(news)),
        "timeline": build_timeline(news),
        "readingQuestions": make_questions(news, terms),
        "stanceChecks": make_stance_checks(news),
        "readingActions": [
            {"label": "先读事实", "prompt": "用一遍阅读只标记谁、何时、何地、做了什么。"},
            {"label": "再查背景", "prompt": "打开历史对照，确认这是不是同一议题的延续、转向或反驳。"},
            {"label": "最后追问", "prompt": "把最不确定的一点交给问答框，让 agent 只基于当前资料回答。"},
        ],
        "historicalContext": related,
    }


def build_digest(store: Store, limit: int = 100) -> dict:
    news = store.list_news(limit=limit)
    terms = top_terms(news, limit=16)
    source_counts: Counter[str] = Counter()
    for item in news:
        source = item.get("source") or {}
        source_counts[source.get("name") or "未知来源"] += 1
    lanes = []
    for term in terms[:6]:
        matches = [
            item
            for item in news
            if term["name"] in {token.lower() for token in tokenize(article_text(item))}
        ][:5]
        lanes.append(
            {
                "label": term["name"],
                "why": f"在 {term['weight']} 个信号中反复出现，适合作为今日追踪线索。",
                "articleIds": [item["id"] for item in matches],
                "titles": [item["title"] for item in matches[:3]],
            }
        )
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "articleCount": len(news),
        "sourceCounts": [{"name": name, "count": count} for name, count in source_counts.most_common()],
        "hotKeywords": terms,
        "attentionLanes": lanes,
        "starterQuestions": [
            "今天哪些新闻只是更新进展，哪些真正改变了判断？",
            "同一议题在不同来源里是否出现明显视角差异？",
            "哪些报道需要等原始文件、数据或当事方回应后再下结论？",
        ],
    }


def answer_question(store: Store, news_id: str, question: str) -> dict | None:
    briefing = build_briefing(store, news_id)
    if not briefing:
        return None
    detail = store.get_news_detail(news_id)
    if not detail:
        return None
    news = detail["news"]
    normalized = question.lower()
    if any(word in normalized for word in ["summary", "summarize", "总结", "摘要", "概括"]):
        answer = briefing["tldr"]
    elif any(word in normalized for word in ["related", "history", "历史", "背景", "对照"]):
        contexts = briefing["historicalContext"]
        if contexts:
            lines = [f"{item['title']}：{item['reason']}" for item in contexts[:3]]
            answer = "可对照这些历史线索：" + "；".join(lines)
        else:
            answer = "当前资料里还没有找到足够强的历史对照，建议先补充更多同主题来源。"
    else:
        points = "；".join(briefing["keyPoints"][:3])
        answer = f"基于当前文章，最稳妥的回答是：{points}"
    citations = [
        {
            "articleId": news["id"],
            "title": news["title"],
            "url": news.get("url"),
            "source": news.get("source"),
        }
    ]
    for context in briefing["historicalContext"][:2]:
        citations.append(
            {
                "articleId": context["id"],
                "title": context["title"],
                "url": context.get("url"),
                "source": context.get("source"),
            }
        )
    return {
        "articleId": news_id,
        "question": question,
        "answer": answer,
        "citations": citations,
        "followUps": briefing["readingQuestions"],
    }


def generate_entity_timeline(entity: str, articles: list[dict]) -> dict:
    timeline: list[dict] = []
    for article in articles:
        timeline.extend(build_timeline(article, entity=entity))
    return {"entity": entity, "timeline": timeline[:12]}
