from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from jojo_jiuwen_api.agent import answer_question, build_briefing, build_digest  # noqa: E402
from jojo_jiuwen_api.scrapbook import generate_for_news  # noqa: E402
from jojo_jiuwen_api.settings import get_settings  # noqa: E402
from jojo_jiuwen_api.store import Store  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify JOJO Jiuwen Pi-agent AI features against fetched news.")
    parser.add_argument("--target", type=int, default=100, help="Minimum number of articles to verify.")
    parser.add_argument("--db-path", type=Path, default=None, help="SQLite DB path. Defaults to JIUWEN_DB_PATH.")
    parser.add_argument(
        "--scrapbook-limit",
        type=int,
        default=25,
        help="How many articles should generate persistent scrapbook links as a representative write-path check.",
    )
    return parser.parse_args()


def validate_briefing(index: int, article: dict, briefing: dict | None) -> list[str]:
    failures: list[str] = []
    prefix = f"article[{index}] {article['id']}"
    if briefing is None:
        return [f"{prefix}: missing briefing"]
    required_text_fields = ["tldr"]
    for field in required_text_fields:
        if not isinstance(briefing.get(field), str) or not briefing[field].strip():
            failures.append(f"{prefix}: missing {field}")
    required_list_fields = {
        "keyPoints": 1,
        "entities": 1,
        "timeline": 1,
        "readingQuestions": 3,
        "stanceChecks": 3,
        "readingActions": 3,
    }
    for field, min_count in required_list_fields.items():
        value = briefing.get(field)
        if not isinstance(value, list) or len(value) < min_count:
            failures.append(f"{prefix}: {field} expected >= {min_count}, got {len(value) if isinstance(value, list) else 'missing'}")
    agent = briefing.get("agent")
    if not isinstance(agent, dict) or len(agent.get("loop") or []) < 3:
        failures.append(f"{prefix}: missing Pi agent loop")
    return failures


def main() -> int:
    args = parse_args()
    db_path = args.db_path or get_settings().db_path
    store = Store(db_path)
    articles = store.list_news(limit=max(args.target, 500))
    failures: list[str] = []

    if len(articles) < args.target:
        failures.append(f"expected at least {args.target} articles, got {len(articles)}")

    checked_articles = articles[: args.target]
    for index, article in enumerate(checked_articles):
        failures.extend(validate_briefing(index, article, build_briefing(store, article["id"])))

    digest = build_digest(store, limit=args.target)
    if digest["articleCount"] < min(args.target, len(articles)):
        failures.append("digest did not include the expected article count")
    if len(digest.get("hotKeywords") or []) < 3:
        failures.append("digest hotKeywords expected at least 3")
    if len(digest.get("attentionLanes") or []) < 3:
        failures.append("digest attentionLanes expected at least 3")

    ask_checks = []
    for article in checked_articles[:5]:
        response = answer_question(store, article["id"], "请总结这条新闻，并指出还需要追问什么。")
        if response is None or not response.get("answer") or not response.get("citations"):
            failures.append(f"ask failed for {article['id']}")
        else:
            ask_checks.append({"articleId": article["id"], "answerLength": len(response["answer"]), "citations": len(response["citations"])})

    scrapbook_checks = []
    for article in checked_articles[: args.scrapbook_limit]:
        result = generate_for_news(store, article["id"])
        related_count = len(store.list_scrapbook(article["id"]))
        if related_count < 1:
            failures.append(f"scrapbook had no related items for {article['id']}")
        scrapbook_checks.append({"articleId": article["id"], "created": result["created"], "relatedCount": related_count})

    report = {
        "passed": len(failures) == 0,
        "target": args.target,
        "articleCount": len(articles),
        "briefingsChecked": len(checked_articles),
        "askChecks": ask_checks,
        "scrapbookChecked": min(args.scrapbook_limit, len(checked_articles)),
        "scrapbookChecks": scrapbook_checks[:20],
        "digest": {
            "articleCount": digest["articleCount"],
            "hotKeywords": digest["hotKeywords"][:8],
            "attentionLaneCount": len(digest["attentionLanes"]),
        },
        "failures": failures,
    }
    output_path = db_path.parent / "ai_verification_report.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
