#!/usr/bin/env python3
"""Finalize classified RMRB JSONL rows and human reconciliation decisions.

The output is a complete, one-to-one source-to-target audit plus the minimal
migration from a previously published conservative omission snapshot.
Nothing is uploaded by this command.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


ArticleKey = tuple[str, int, int]


def source_key(row: dict[str, Any]) -> ArticleKey:
    return (
        str(row.get("date") or "")[:10],
        int(row.get("page") or 0),
        int(row.get("preservedOrdinal", row.get("ordinal", -1))),
    )


def target_key(row: dict[str, Any]) -> ArticleKey:
    return (
        str(row.get("date") or "")[:10],
        int(row.get("page") or 0),
        int(row.get("ordinal", -1)),
    )


def source_fingerprint(row: dict[str, Any]) -> str:
    key = source_key(row)
    payload = {
        "date": key[0],
        "page": key[1],
        "ordinal": key[2],
        "title": str(row.get("title") or ""),
        "content": str(row.get("content") or ""),
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8-sig") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def index_unique(
    rows: Iterable[dict[str, Any]],
    key_function,
    label: str,
) -> dict[ArticleKey, dict[str, Any]]:
    result: dict[ArticleKey, dict[str, Any]] = {}
    for row in rows:
        key = key_function(row)
        if not key[0] or key[1] <= 0 or key[2] < 0:
            raise ValueError(f"{label} contains an invalid key: {key}")
        if key in result:
            raise ValueError(f"{label} contains a duplicate key: {key}")
        result[key] = row
    return result


def canonical_omission(source: dict[str, Any]) -> dict[str, Any]:
    key = source_key(source)
    return {
        "date": key[0],
        "page": key[1],
        "ordinal": key[2],
        "title": str(source.get("title") or "").strip(),
        "href": None,
        "content": str(source.get("content") or "").strip(),
        "contentSource": "jsonl",
        "matchMethod": "jsonl_directory_omission",
        "sourceDate": key[0],
        "sourcePage": key[1],
        "sourceOrdinal": key[2],
        "sourceTitle": str(source.get("title") or "").strip(),
    }


def candidate_keys(review_row: dict[str, Any]) -> dict[ArticleKey, dict[str, Any]]:
    result: dict[ArticleKey, dict[str, Any]] = {}
    for field in ("suspectedTypoCandidates", "nearbyExactMatches"):
        for candidate in review_row.get(field) or []:
            key = target_key(candidate)
            result[key] = candidate
    return result


def finalize(
    original_rows: list[dict[str, Any]],
    accepted_rows: list[dict[str, Any]],
    review_rows: list[dict[str, Any]],
    decision_rows: list[dict[str, Any]],
    previous_rows: list[dict[str, Any]],
) -> tuple[
    dict[ArticleKey, dict[str, Any]],
    dict[ArticleKey, dict[str, Any]],
    dict[ArticleKey, dict[str, Any]],
    dict[str, Any],
]:
    originals = index_unique(original_rows, source_key, "original source")
    originals_by_day_ordinal: dict[tuple[str, int], dict[str, Any]] = {}
    for key, row in originals.items():
        compact = (key[0], key[2])
        if compact in originals_by_day_ordinal:
            raise ValueError(f"Original source has a duplicate day ordinal: {compact}")
        originals_by_day_ordinal[compact] = row
    reviews = index_unique(review_rows, source_key, "review queue")
    decisions = {source_key(row): row for row in decision_rows}
    previous = index_unique(previous_rows, target_key, "previous publication")

    final_by_source: dict[ArticleKey, dict[str, Any]] = {}
    automatic_methods: Counter[str] = Counter()
    for accepted in accepted_rows:
        method = str(accepted.get("matchMethod") or "")
        if method == "jsonl_directory_omission":
            key = target_key(accepted)
        else:
            source_ordinal = int(accepted.get("sourceOrdinal", -1))
            source_date = str(accepted.get("sourceDate") or accepted.get("date") or "")[:10]
            source = originals_by_day_ordinal.get((source_date, source_ordinal))
            if source is None:
                raise ValueError(
                    f"Cannot recover automatic match source: {source_date} #{source_ordinal}"
                )
            key = source_key(source)
        source = originals.get(key)
        if source is None:
            raise ValueError(f"Accepted row does not map to an original source: {key}")
        if str(accepted.get("content") or "").strip() != str(source.get("content") or "").strip():
            raise ValueError(f"Accepted content differs from original source: {key}")
        final = {
            **accepted,
            "sourceDate": key[0],
            "sourcePage": key[1],
            "sourceOrdinal": key[2],
            "sourceTitle": str(source.get("title") or "").strip(),
        }
        if key in final_by_source:
            raise ValueError(f"Original source resolved more than once: {key}")
        final_by_source[key] = final
        automatic_methods[method] += 1

    human = Counter()
    for key, review in reviews.items():
        decision = decisions.get(key)
        if decision is None:
            raise ValueError(f"Review row has no final decision: {key}")
        if decision.get("sourceFingerprint") != source_fingerprint(review):
            raise ValueError(f"Review decision fingerprint is stale: {key}")
        resolution = str(decision.get("resolution") or "")
        source = originals.get(key)
        if source is None:
            raise ValueError(f"Review row does not map to an original source: {key}")
        if resolution == "jsonl_correct":
            final = canonical_omission(source)
        elif resolution == "merge_candidate":
            candidate = decision.get("candidate") or {}
            candidate_key = target_key(candidate)
            valid = candidate_keys(review).get(candidate_key)
            if valid is None:
                raise ValueError(f"Review decision selected an invalid candidate: {key} -> {candidate_key}")
            if str(valid.get("title") or "").strip() != str(candidate.get("title") or "").strip():
                raise ValueError(f"Review candidate title changed: {key} -> {candidate_key}")
            final = {
                "date": candidate_key[0],
                "page": candidate_key[1],
                "ordinal": candidate_key[2],
                "title": str(candidate.get("title") or "").strip(),
                "href": candidate.get("peopleDataHref") or valid.get("href"),
                "content": str(source.get("content") or "").strip(),
                "contentSource": "jsonl",
                "matchMethod": "human_review_merge_candidate",
                "sourceDate": key[0],
                "sourcePage": key[1],
                "sourceOrdinal": key[2],
                "sourceTitle": str(source.get("title") or "").strip(),
                "reviewedAt": decision.get("reviewedAt"),
                "reviewNote": str(decision.get("note") or "").strip(),
            }
        else:
            raise ValueError(f"Review row does not have a publishable decision: {key} ({resolution})")
        if key in final_by_source:
            raise ValueError(f"Reviewed source was already resolved automatically: {key}")
        final_by_source[key] = final
        human[resolution] += 1

    if set(final_by_source) != set(originals):
        missing = sorted(set(originals) - set(final_by_source))[:5]
        extra = sorted(set(final_by_source) - set(originals))[:5]
        raise ValueError(f"Final source accounting differs; missing={missing}, extra={extra}")

    final: dict[ArticleKey, dict[str, Any]] = {}
    for source, row in final_by_source.items():
        key = target_key(row)
        if key in final:
            raise ValueError(f"Two source rows resolve to the same final target: {key}")
        final[key] = row

    source_targets = {source: target_key(row) for source, row in final_by_source.items()}
    removals = {
        key: row for key, row in previous.items() if source_targets.get(key) != key
    }
    upserts = {
        key: row
        for key, row in final.items()
        if str(row.get("matchMethod") or "") != "jsonl_directory_omission"
        or key not in previous
    }
    omissions = sum(
        str(row.get("matchMethod") or "") == "jsonl_directory_omission"
        for row in final.values()
    )
    aligned = len(final) - omissions
    report = {
        "formatVersion": "jojo-rmrb-jsonl-reconciliation-final/1",
        "safe": True,
        "originalSourceRows": len(originals),
        "automaticRows": len(accepted_rows),
        "reviewRows": len(reviews),
        "humanJsonlCorrectRows": human["jsonl_correct"],
        "humanMergeCandidateRows": human["merge_candidate"],
        "finalRows": len(final),
        "finalDirectoryOmissionRows": omissions,
        "finalPeopleDataAlignedRows": aligned,
        "previouslyPublishedRows": len(previous),
        "retainedPreviousRows": len(previous) - len(removals),
        "removeObsoleteRows": len(removals),
        "upsertRows": len(upserts),
        "newDirectoryOmissionRows": sum(
            str(row.get("matchMethod") or "") == "jsonl_directory_omission"
            for row in upserts.values()
        ),
        "peopleDataBodyUpserts": sum(
            str(row.get("matchMethod") or "") != "jsonl_directory_omission"
            for row in upserts.values()
        ),
        "automaticMethods": dict(sorted(automatic_methods.items())),
    }
    return final, upserts, removals, report


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", required=True, type=Path)
    parser.add_argument("--accepted", required=True, type=Path)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--decisions", required=True, type=Path)
    parser.add_argument("--previous-published", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    final, upserts, removals, report = finalize(
        load_jsonl(args.original),
        load_jsonl(args.accepted),
        load_jsonl(args.review),
        load_jsonl(args.decisions),
        load_jsonl(args.previous_published),
    )
    args.output.mkdir(parents=True, exist_ok=True)
    paths = {
        "final": args.output / "final-rows.jsonl",
        "upserts": args.output / "upserts.jsonl",
        "removals": args.output / "removals.jsonl",
    }
    write_jsonl(paths["final"], (final[key] for key in sorted(final)))
    write_jsonl(paths["upserts"], (upserts[key] for key in sorted(upserts)))
    write_jsonl(paths["removals"], (removals[key] for key in sorted(removals)))
    for name, path in paths.items():
        report[f"{name}Path"] = str(path.resolve())
        report[f"{name}Sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    report_path = args.output / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
