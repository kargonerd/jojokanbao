"""Manually generate published book audio, resume through B2 metadata, report size.

Default is a one-chapter sample. --all is required for the entire prepared plan.
Never deletes audio, changes bucket policy, or writes to Supabase.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
import time
from pathlib import Path

from environment import load_environment

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from app.core.config import Settings
from app.speech.delivery import delivery_version, identity, resolve_speech, speech_store
from app.speech.storage import PREFIX


def component(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", value):
        return hashlib.sha256(value.encode()).hexdigest()[:24]
    return value


def save_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


async def generate(args, settings: Settings) -> dict:
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if plan.get("formatVersion") != "jojo-speech-plan/1" or not plan.get("books"):
        raise ValueError("Invalid speech plan")
    # Validate the complete plan before making any paid request/cloud write.
    for book in plan["books"]:
        for chapter in book["chapters"]:
            for text in chapter["segments"]:
                identity(args.provider, args.voice, text)
    selected = [(book, chapter) for book in plan["books"] for chapter in book["chapters"]
                if not args.chapter or chapter["id"] == args.chapter]
    if not selected:
        raise ValueError("No chapters matched")
    if not args.all:
        selected = selected[:args.limit_chapters]
    report = {"formatVersion": "jojo-speech-report/1", "provider": args.provider, "voice": args.voice,
              "version": delivery_version(args.provider), "startedAt": time.time(), "chapters": [],
              "uniqueBytes": 0, "newBytes": 0, "durationSeconds": 0, "cacheHits": 0, "generated": 0}
    if args.dry_run:
        return {**report, "plannedChapters": len(selected), "plannedSegments": sum(len(c["segments"]) for _, c in selected)}
    if settings.speech_storage != "b2":
        raise ValueError("Manual publication requires JOJO_SPEECH_STORAGE=b2 (or --use-rclone)")
    store = speech_store(settings)
    seen = set()
    for book, chapter in selected:
        chapter_report = {"datasetId": book["datasetId"], "itemKey": book["itemKey"], "chapterId": chapter["id"],
                          "status": "generating", "segments": [], "duration": 0}
        report["chapters"].append(chapter_report)
        try:
            for text in chapter["segments"]:
                # Sequential, intentionally low concurrency. A rerun reuses every completed part.
                record, status = await resolve_speech(args.provider, args.voice, text, settings)
                entry = {key: record[key] for key in ("key", "object", "duration", "bytes", "sha256")}
                entry["offset"] = chapter_report["duration"]
                chapter_report["segments"].append(entry)
                chapter_report["duration"] += record["duration"]
                report["durationSeconds"] += record["duration"]
                report["cacheHits" if status == "hit" else "generated"] += 1
                if record["object"] not in seen:
                    seen.add(record["object"])
                    report["uniqueBytes"] += record["bytes"]
                    if status == "miss":
                        report["newBytes"] += record["bytes"]
                save_report(args.report, report)
            revision = hashlib.sha256(json.dumps([entry["object"] for entry in chapter_report["segments"]]).encode()).hexdigest()
            voice_key = hashlib.sha256(f"{args.provider}:{args.voice}".encode()).hexdigest()[:16]
            manifest = {"formatVersion": "jojo-speech-chapter/1", "provider": args.provider, "voice": args.voice,
                        "version": delivery_version(args.provider), "chapterId": chapter["id"],
                        "duration": chapter_report["duration"], "segments": chapter_report["segments"]}
            prefix = f"{PREFIX}/books/{component(book['datasetId'])}/{component(book['itemKey'])}/{voice_key}/{component(chapter['id'])}"
            key = f"{prefix}/{revision}.json"
            await asyncio.to_thread(store.put_json, key, manifest, immutable=True)
            await asyncio.to_thread(store.put_json, f"{prefix}/index.json", {"manifest": key})
            chapter_report.update(status="complete", manifest=key)
            print(f"Completed {len(report['chapters'])}/{len(selected)}; {chapter_report['duration']:.1f}s", flush=True)
        except Exception as error:
            # Never write upstream text, credentials, or exception repr into a report.
            chapter_report.update(status="failed", errorType=type(error).__name__)
            save_report(args.report, report)
            raise
        save_report(args.report, report)
    report["finishedAt"] = time.time()
    save_report(args.report, report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--report", type=Path, default=ROOT / ".runtime/speech/report.json")
    parser.add_argument("--provider", choices=["mimo", "edge"], default="mimo")
    parser.add_argument("--voice", default="白桦")
    parser.add_argument("--limit-chapters", type=int, default=1)
    parser.add_argument("--chapter")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--use-rclone", action="store_true")
    args = parser.parse_args()
    if args.limit_chapters < 1:
        parser.error("--limit-chapters must be positive")
    load_environment(ROOT, use_rclone=args.use_rclone)
    try:
        result = asyncio.run(generate(args, Settings.from_env()))
        print(json.dumps({key: value for key, value in result.items() if key != "chapters"}, ensure_ascii=True))
    except Exception as error:
        print(f"Generation failed ({type(error).__name__}); see report. Rerun to resume.", file=sys.stderr)
        sys.exit(1)
