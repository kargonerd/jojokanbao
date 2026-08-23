"""Incrementally publish accepted RMRB review decisions.

Hugging Face is the canonical source of truth.  This module patches only the
affected issue Items and annual Dataset Viewer shards.  It can then derive the
matching Jox fragments and issue manifests used by the B2 Delivery tree.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import html
import io
import json
import shutil
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable


JOX_SALT = 0x4A4F5831
MISSING_INDEX = "newspapers/rmrb/indexes/missing-articles.jsonl.gz"
SourceFile = Callable[[str], Path]
DeliveryFile = Callable[[str], Path]


@dataclass
class CanonicalPatch:
    root: Path
    accepted_count: int = 0
    changed_article_count: int = 0
    files: dict[str, Path] = field(default_factory=dict)
    issue_files: dict[str, Path] = field(default_factory=dict)
    dataset: dict[str, Any] = field(default_factory=dict)
    dataset_changed: bool = False
    changed_keys: set[tuple[str, int, int]] = field(default_factory=set)


@dataclass
class DeliveryPatch:
    root: Path
    changed_article_count: int = 0
    files: dict[str, Path] = field(default_factory=dict)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_json_gz(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
            stream.write(_json_bytes(value))


def _write_jsonl_gz(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
            for row in rows:
                stream.write(_json_bytes(row))


def _read_json_gz(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _read_jsonl_gz(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _stable_suffix(*parts: object, length: int = 16) -> str:
    payload = "\0".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def _article_id(day: str, page: int, ordinal: int) -> str:
    return f"article:{_stable_suffix('rmrb', day, page, ordinal)}"


def _accepted(decisions: dict[tuple[str, int, int], dict[str, object]]) -> dict[tuple[str, int, int], str]:
    result: dict[tuple[str, int, int], str] = {}
    for key, row in decisions.items():
        content = str(row.get("content") or "").strip()
        if str(row.get("decision") or "").lower() == "accept" and content:
            result[key] = content
    return result


def _reviewed(
    decisions: dict[tuple[str, int, int], dict[str, object]],
) -> dict[tuple[str, int, int], tuple[str, str]]:
    result: dict[tuple[str, int, int], tuple[str, str]] = {}
    for key, row in decisions.items():
        decision = str(row.get("decision") or "").lower()
        content = str(row.get("content") or "").strip()
        if decision == "accept" and content:
            result[key] = ("available", content)
        elif decision == "reject":
            result[key] = ("rejected", "")
        elif decision == "missing":
            # Maintenance transition used to undo a historical false reject.
            result[key] = ("missing", "")
    return result


def accepted_hashes(
    decisions: dict[tuple[str, int, int], dict[str, object]],
) -> dict[str, str]:
    """Return compact desired-state hashes suitable for a local publish journal."""
    return {
        "|".join((key[0], str(key[1]), str(key[2]))): hashlib.sha256(
            _json_bytes({
                "content": content,
                "images": [
                    str(image.get("sha256") or "")
                    for image in (decisions[key].get("images") or [])
                    if isinstance(image, dict)
                ],
            })
        ).hexdigest()
        for key, content in _accepted(decisions).items()
    }


def _decision_images(row: dict[str, object]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw in row.get("images") or []:
        if not isinstance(raw, dict):
            continue
        source = Path(str(raw.get("path") or ""))
        digest = str(raw.get("sha256") or "").lower()
        media_type = str(raw.get("mediaType") or "")
        if not source.is_file() or len(digest) != 64 or not media_type.startswith("image/"):
            raise ValueError(f"复核图片附件无效：{source}")
        value = source.read_bytes()
        if hashlib.sha256(value).hexdigest() != digest:
            raise ValueError(f"复核图片校验失败：{source}")
        result.append({
            "source": source,
            "sha256": digest,
            "mediaType": media_type,
            "size": len(value),
        })
    return result


def _article_body(content: str, asset_ids: list[str]) -> dict[str, str]:
    if not asset_ids:
        return {"format": "text", "value": content}
    paragraphs = "".join(
        f"<p>{html.escape(paragraph).replace(chr(10), '<br>')}</p>"
        for paragraph in content.split("\n\n")
        if paragraph
    )
    figures = "".join(
        f'<figure data-asset-id="{html.escape(asset_id)}" data-role="article-image"></figure>'
        for asset_id in asset_ids
    )
    return {
        "format": "html",
        "profile": "jojo-semantic-html/1",
        "value": paragraphs + figures,
    }


def _copy_image_assets(
    decision: dict[str, object],
    output: Path,
    patch: CanonicalPatch,
) -> tuple[list[dict[str, Any]], list[str]]:
    descriptors: list[dict[str, Any]] = []
    asset_ids: list[str] = []
    for image in _decision_images(decision):
        source = image["source"]
        digest = image["sha256"]
        suffix = source.suffix.lower() or ".bin"
        relative_path = f"assets/images/{digest}{suffix}"
        repo_path = f"newspapers/rmrb/{relative_path}"
        target = output / repo_path
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file():
            shutil.copy2(source, target)
        patch.files[repo_path] = target
        asset_id = f"asset:image-{digest[:16]}"
        descriptors.append({
            "id": asset_id,
            "type": "image",
            "role": "article-image",
            "mediaType": image["mediaType"],
            "title": None,
            "alt": None,
            "caption": None,
            "size": image["size"],
            "sha256": digest,
            "path": relative_path,
        })
        asset_ids.append(asset_id)
    return descriptors, asset_ids


def parse_key(value: str) -> tuple[str, int, int]:
    day, page, ordinal = value.split("|", 2)
    return day, int(page), int(ordinal)


def _calendar_dates(start: str, end: str) -> list[str]:
    current = date.fromisoformat(start)
    final = date.fromisoformat(end)
    values: list[str] = []
    while current <= final:
        values.append(current.isoformat())
        current += timedelta(days=1)
    return values


def _expand_members(year: str, members: dict[str, Any], scope: set[str]) -> set[str]:
    result: set[str] = set()
    for month in members.get("months") or []:
        result.update(day for day in scope if day.startswith(f"{year}-{month}-"))
    for start, end in members.get("ranges") or []:
        first = date.fromisoformat(f"{year}-{start}")
        last = date.fromisoformat(f"{year}-{end}")
        current = first
        while current <= last:
            result.add(current.isoformat())
            current += timedelta(days=1)
    result.update(f"{year}-{value}" for value in members.get("dates") or [])
    return result & scope


def _available_dates(calendar: dict[str, Any]) -> set[str]:
    scope = set(_calendar_dates(str(calendar["startDate"]), str(calendar["endDate"])))
    available = set(scope) if calendar.get("default", "available") == "available" else set()
    for year, rule in (calendar.get("years") or {}).items():
        year_scope = {day for day in scope if day.startswith(f"{year}-")}
        if "include" in rule:
            available -= year_scope
            available |= _expand_members(year, rule["include"], year_scope)
        elif "exclude" in rule:
            available |= year_scope
            available -= _expand_members(year, rule["exclude"], year_scope)
    return available


def _compact_members(year: str, members: set[str], scope: set[str]) -> dict[str, Any]:
    remaining = set(members)
    months: list[str] = []
    for month_number in range(1, 13):
        month = f"{month_number:02d}"
        month_scope = {day for day in scope if day.startswith(f"{year}-{month}-")}
        if month_scope and month_scope <= remaining:
            months.append(month)
            remaining -= month_scope
    ordered = sorted(remaining)
    ranges: list[list[str]] = []
    dates: list[str] = []
    index = 0
    while index < len(ordered):
        start = index
        while index + 1 < len(ordered) and date.fromisoformat(ordered[index + 1]) == date.fromisoformat(ordered[index]) + timedelta(days=1):
            index += 1
        run = ordered[start:index + 1]
        if len(run) >= 3:
            ranges.append([run[0][5:], run[-1][5:]])
        else:
            dates.extend(value[5:] for value in run)
        index += 1
    result: dict[str, Any] = {}
    if months:
        result["months"] = months
    if ranges:
        result["ranges"] = ranges
    if dates:
        result["dates"] = dates
    return result


def _adaptive_calendar(calendar: dict[str, Any], available: set[str]) -> dict[str, Any]:
    start = str(calendar["startDate"])
    end = str(calendar["endDate"])
    scope = set(_calendar_dates(start, end))
    available &= scope
    years: dict[str, Any] = {}
    for year in sorted({day[:4] for day in scope}):
        year_scope = {day for day in scope if day.startswith(f"{year}-")}
        year_available = available & year_scope
        if year_available == year_scope:
            continue
        if len(year_available) <= len(year_scope - year_available):
            years[year] = {"include": _compact_members(year, year_available, year_scope)}
        else:
            years[year] = {"exclude": _compact_members(year, year_scope - year_available, year_scope)}
    return {
        "format": "adaptive-calendar/1",
        "startDate": start,
        "endDate": end,
        "default": "available",
        "years": years,
    }


def prepare_canonical_patch(
    decisions: dict[tuple[str, int, int], dict[str, object]],
    source_file: SourceFile,
    output: Path,
    candidate_keys: set[tuple[str, int, int]] | None = None,
    issue_keys: set[tuple[str, int, int]] | None = None,
) -> CanonicalPatch:
    """Patch HF canonical files in a local staging directory."""
    reviewed = _reviewed(decisions)
    patch = CanonicalPatch(
        root=output,
        accepted_count=sum(state == "available" for state, _ in reviewed.values()),
    )
    dataset_path = source_file("newspapers/rmrb/dataset.json")
    patch.dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    candidates = set(reviewed) if candidate_keys is None else set(reviewed) & candidate_keys
    materialize = candidates if issue_keys is None else candidates & issue_keys
    if not candidates:
        return patch

    by_year: dict[str, list[tuple[tuple[str, int, int], str, str]]] = {}
    for key in candidates:
        state, content = reviewed[key]
        by_year.setdefault(key[0][:4], []).append((key, state, content))

    changed_days: set[str] = set()
    day_text_before: dict[str, bool] = {}
    day_text_after: dict[str, bool] = {}
    for year, entries in sorted(by_year.items()):
        shard_name = f"newspapers/rmrb/data/articles/{year}.jsonl.gz"
        viewer_rows = _read_jsonl_gz(source_file(shard_name))
        viewer_index = {
            (str(row["date"]), int(row["page"]), int(row["ordinal"])): row
            for row in viewer_rows
        }
        pending: list[tuple[tuple[str, int, int], str, str]] = []
        for key, state, content in entries:
            viewer = viewer_index.get(key)
            if viewer is None:
                raise ValueError(f"正式年度分片中找不到复核条目：{key[0]} 第{key[1]}版 #{key[2]}")
            if str(viewer.get("status")) != state or str(viewer.get("content") or "") != content:
                pending.append((key, state, content))
                patch.changed_keys.add(key)
        days = sorted({key[0] for key, _, _ in entries})
        for day in days:
            day_text_before[day] = any(
                str(row.get("date")) == day and str(row.get("status")) == "available"
                for row in viewer_rows
            )
            pending_keys = {entry[0] for entry in pending}
            item_entries = [
                entry for entry in entries
                if entry[0][0] == day and (entry[0] in pending_keys or entry[0] in materialize)
            ]
            if not item_entries:
                day_text_after[day] = day_text_before[day]
                continue
            item_name = f"newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}.json.gz"
            item_source = source_file(item_name)
            item = _read_json_gz(item_source)
            articles = {str(row["id"]): row for row in item["content"]["articles"]}
            item_assets = {str(row["id"]): row for row in item.get("assets") or []}
            item_changed = False
            for key, state, content in item_entries:
                article = articles.get(_article_id(*key))
                viewer = viewer_index.get(key)
                if article is None or viewer is None:
                    raise ValueError(f"正式数据中找不到复核条目：{key[0]} 第{key[1]}版 #{key[2]}")
                expected_title = str(decisions[key].get("title") or "").strip()
                if expected_title and expected_title != str(article.get("title") or "").strip():
                    raise ValueError(f"正式数据标题不一致，拒绝覆盖：{key[0]} 第{key[1]}版 #{key[2]}")
                image_assets, image_refs = _copy_image_assets(decisions[key], output, patch)
                for asset in image_assets:
                    if item_assets.get(asset["id"]) != asset:
                        item_assets[asset["id"]] = asset
                        item_changed = True
                existing_refs = [
                    str(value) for value in article.get("assetRefs") or []
                    if str(value) not in image_refs
                ]
                desired_refs = existing_refs + image_refs
                desired_body = _article_body(content, image_refs)
                if (
                    article.get("contentState") != state
                    or article.get("body") != desired_body
                    or article.get("assetRefs") != desired_refs
                ):
                    article["contentState"] = state
                    article["body"] = desired_body
                    article["assetRefs"] = desired_refs
                    item_changed = True
                    patch.changed_article_count += 1
                viewer["content"] = content
                viewer["status"] = state
            if item_changed:
                item["assets"] = sorted(item_assets.values(), key=lambda value: str(value["id"]))
                item["revision"] = int(item.get("revision") or 0) + 1
                relative = Path(item_name)
                target = output / relative
                _write_json_gz(target, item)
                patch.files[item_name] = target
                patch.issue_files[day] = target
                changed_days.add(day)
            else:
                # B2 may still lag an already-correct HF canonical Item.
                patch.issue_files[day] = item_source
            day_text_after[day] = any(
                str(row.get("date")) == day and str(row.get("status")) == "available"
                for row in viewer_rows
            )
        if pending:
            shard_target = output / shard_name
            _write_jsonl_gz(shard_target, viewer_rows)
            patch.files[shard_name] = shard_target

    if patch.changed_keys:
        missing_rows = _read_jsonl_gz(source_file(MISSING_INDEX))
        missing_by_key = {
            (str(row["date"]), int(row["page"]), int(row["ordinal"])): row
            for row in missing_rows
        }
        for key in patch.changed_keys:
            state, _ = reviewed[key]
            if state == "missing":
                missing_by_key[key] = {
                    "date": key[0],
                    "page": key[1],
                    "ordinal": key[2],
                    "title": str(decisions[key].get("title") or ""),
                    "status": "missing",
                }
            elif missing_by_key.pop(key, None) is None:
                raise ValueError(f"HF 缺失正文索引中找不到待发布记录：{key}")
        remaining = [missing_by_key[key] for key in sorted(missing_by_key)]
        missing_target = output / MISSING_INDEX
        _write_jsonl_gz(missing_target, remaining)
        patch.files[MISSING_INDEX] = missing_target

    text_calendar = patch.dataset["availability"]["text"]
    available = _available_dates(text_calendar)
    for day, is_available in day_text_after.items():
        if is_available:
            available.add(day)
        else:
            available.discard(day)
    new_calendar = _adaptive_calendar(text_calendar, available)
    if new_calendar != text_calendar:
        patch.dataset["availability"]["text"] = new_calendar
        target = output / "newspapers/rmrb/dataset.json"
        _write_json(target, patch.dataset)
        patch.files["newspapers/rmrb/dataset.json"] = target
        patch.dataset_changed = True
    return patch


def _fnv1a(value: str) -> int:
    result = 0x811C9DC5
    for byte in value.replace("\\", "/").lstrip("/").encode("utf-8"):
        result ^= byte
        result = (result * 0x01000193) & 0xFFFFFFFF
    return result


def _jox_mask_byte(position: int, seed: int) -> int:
    value = (((position & 0xFFFFFFFF) + 0x9E3779B9) & 0xFFFFFFFF) ^ seed ^ JOX_SALT
    value ^= value >> 16
    value = (value * 0x7FEB352D) & 0xFFFFFFFF
    value ^= value >> 15
    value = (value * 0x846CA68B) & 0xFFFFFFFF
    value ^= value >> 16
    return value & 0xFF


def _transform_jox(value: bytes, object_key: str) -> bytes:
    seed = _fnv1a(object_key)
    return bytes(byte ^ _jox_mask_byte(index, seed) for index, byte in enumerate(value))


def _decode_jox(path: Path, object_key: str) -> dict[str, Any]:
    return json.loads(gzip.decompress(_transform_jox(path.read_bytes(), object_key)))


def _write_jox(path: Path, object_key: str, value: Any) -> tuple[int, str]:
    clear = _json_bytes(value)
    protected = _transform_jox(gzip.compress(clear, compresslevel=9, mtime=0), object_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(protected)
    return len(clear), hashlib.sha256(clear).hexdigest()


def _write_jox_file(path: Path, object_key: str, source: Path) -> tuple[int, str]:
    clear = source.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_transform_jox(clear, object_key))
    return len(clear), hashlib.sha256(clear).hexdigest()


def _opaque_name(value: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value).digest()).decode("ascii").rstrip("=")[:18]


def _opaque_name_from_sha256(digest: str) -> str:
    return base64.urlsafe_b64encode(bytes.fromhex(digest)).decode("ascii").rstrip("=")[:18]


def prepare_delivery_patch(
    decisions: dict[tuple[str, int, int], dict[str, object]],
    canonical: CanonicalPatch,
    delivery_file: DeliveryFile,
    output: Path,
    candidate_keys: set[tuple[str, int, int]] | None = None,
) -> DeliveryPatch:
    """Build B2 Delivery fragments/manifests from the canonical patch."""
    reviewed = _reviewed(decisions)
    patch = DeliveryPatch(root=output)
    candidates = set(reviewed) if candidate_keys is None else set(reviewed) & candidate_keys
    if not candidates:
        return patch
    by_day: dict[str, list[tuple[tuple[str, int, int], str, str]]] = {}
    for key in candidates:
        state, content = reviewed[key]
        by_day.setdefault(key[0], []).append((key, state, content))
    for day, entries in sorted(by_day.items()):
        item = _read_json_gz(canonical.issue_files[day])
        articles = {str(row["id"]): row for row in item["content"]["articles"]}
        prefix = f"content/newspapers/rmrb/items/{day[:4]}/{day[5:7]}/{day}"
        manifest_key = f"{prefix}/manifest.jox"
        manifest = _decode_jox(delivery_file(manifest_key), manifest_key)
        descriptors = {str(row["id"]): row for row in manifest["content"]["articles"]}
        manifest_assets = {str(row["id"]): row for row in manifest.get("assets") or []}
        canonical_assets = {str(row["id"]): row for row in item.get("assets") or []}
        manifest_changed = False
        for key, state, content in entries:
            article_id = _article_id(*key)
            article = articles.get(article_id)
            descriptor = descriptors.get(article_id)
            if article is None or descriptor is None:
                raise ValueError(f"Delivery 中找不到复核条目：{key[0]} 第{key[1]}版 #{key[2]}")
            fragment_file: tuple[str, Path] | None = None
            if state == "available":
                for asset_id in article.get("assetRefs") or []:
                    asset = canonical_assets.get(str(asset_id))
                    if asset is None or str(asset.get("type")) != "image":
                        continue
                    source = canonical.root / "newspapers/rmrb" / str(asset["path"])
                    digest = str(asset["sha256"])
                    relative_asset = f"assets/{_opaque_name_from_sha256(digest)}.jox"
                    asset_key = f"{prefix}/{relative_asset}"
                    asset_target = output / asset_key
                    asset_size, asset_digest = _write_jox_file(asset_target, asset_key, source)
                    patch.files[asset_key] = asset_target
                    desired_asset = {
                        name: value for name, value in asset.items()
                        if name not in {"path", "sourceUrl", "sha256", "size"}
                    }
                    desired_asset.update({
                        "object": relative_asset,
                        "size": asset_size,
                        "sha256": asset_digest,
                    })
                    if manifest_assets.get(str(asset_id)) != desired_asset:
                        manifest_assets[str(asset_id)] = desired_asset
                        manifest_changed = True
                fragment = {
                    "formatVersion": "jojo-fragment/1",
                    "itemId": item["itemId"],
                    "fragmentId": article_id,
                    "type": "article",
                    "order": article["order"],
                    "title": article["title"],
                    "status": state,
                    "body": article["body"],
                    "assetRefs": article.get("assetRefs") or [],
                    "annotations": [],
                }
                clear = _json_bytes(fragment)
                relative_object = f"articles/{_opaque_name(clear)}.jox"
                object_key = f"{prefix}/{relative_object}"
                target = output / object_key
                size, digest = _write_jox(target, object_key, fragment)
                fragment_file = (object_key, target)
                desired = {
                    "id": article_id,
                    "order": article["order"],
                    "title": article["title"],
                    "characterCount": len(content),
                    "status": state,
                    "object": relative_object,
                    "size": size,
                    "sha256": digest,
                }
            else:
                desired = {
                    "id": article_id,
                    "order": article["order"],
                    "title": article["title"],
                    "characterCount": 0,
                    "status": state,
                    "object": None,
                }
            if descriptor != desired:
                descriptor.clear()
                descriptor.update(desired)
                if fragment_file:
                    patch.files[fragment_file[0]] = fragment_file[1]
                patch.changed_article_count += 1
                manifest_changed = True
        if manifest_changed:
            rows = manifest["content"]["articles"]
            manifest["assets"] = sorted(manifest_assets.values(), key=lambda value: str(value["id"]))
            manifest["revision"] = int(manifest.get("revision") or 0) + 1
            manifest["availability"]["text"] = "available" if any(row["status"] == "available" for row in rows) else "missing"
            manifest["contentStats"] = {
                "articleCount": len(rows),
                "availableArticleCount": sum(row["status"] == "available" for row in rows),
                "missingArticleCount": sum(row["status"] == "missing" for row in rows),
                "rejectedArticleCount": sum(row["status"] == "rejected" for row in rows),
                "characterCount": sum(int(row.get("characterCount") or 0) for row in rows),
            }
            target = output / manifest_key
            _write_jox(target, manifest_key, manifest)
            patch.files[manifest_key] = target
    if canonical.dataset_changed:
        index_key = "content/newspapers/rmrb/index.jox"
        index = _decode_jox(delivery_file(index_key), index_key)
        index["availability"] = canonical.dataset["availability"]
        index["revision"] = int(index.get("revision") or 0) + 1
        target = output / index_key
        _write_jox(target, index_key, index)
        patch.files[index_key] = target
    return patch
