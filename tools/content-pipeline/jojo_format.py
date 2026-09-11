"""Shared JOJO Jox encoding and adaptive calendar utilities for Python publishers."""
from __future__ import annotations
import base64
import gzip
import hashlib
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

JOX_SALT = 0x4A4F5831

def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


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
