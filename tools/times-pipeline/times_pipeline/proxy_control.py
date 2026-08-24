from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener


CONTROL_VERSION = "jojo-times-proxy-control/1"


def _request_json(
    url: str,
    *,
    secret: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
    )
    # The controller is localhost-only; bypass process HTTP(S)_PROXY variables
    # so its ephemeral Bearer secret can never be forwarded to another proxy.
    with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
        value = json.loads(response.read(5_000_000))
    if not isinstance(value, dict):
        raise ValueError("Invalid proxy controller response")
    return value


def _load_control(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("formatVersion") != CONTROL_VERSION:
        raise ValueError("Invalid proxy control file")
    controller = value.get("controller")
    parsed = urlsplit(controller) if isinstance(controller, str) else None
    if (
        parsed is None
        or parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
    ):
        raise ValueError("Proxy controller must be local")
    if not isinstance(value.get("secret"), str) or not value["secret"]:
        raise ValueError("Proxy controller secret is missing")
    if not all(isinstance(value.get(key), str) and value[key] for key in ("routeGroup", "latencyGroup")):
        raise ValueError("Proxy controller groups are missing")
    if not isinstance(value.get("candidates"), list) or not all(
        isinstance(name, str) and name for name in value["candidates"]
    ):
        raise ValueError("Proxy candidates are missing")
    return value


def rotate_proxy(path: Path) -> bool:
    """Switch the isolated Mihomo route group without exposing node names."""
    try:
        control = _load_control(path)
        controller = control["controller"].rstrip("/")
        secret = control["secret"]
        route_group = control["routeGroup"]
        latency_group = control["latencyGroup"]
        proxies = _request_json(f"{controller}/proxies", secret=secret).get("proxies", {})
        if not isinstance(proxies, dict):
            return False
        route = proxies.get(route_group, {})
        latency = proxies.get(latency_group, {})
        used = {
            name for name in control.get("usedCandidates", [])
            if isinstance(name, str) and name in control["candidates"]
        }
        excluded = used | {
            route.get("now") if isinstance(route, dict) else None,
            latency.get("now") if isinstance(latency, dict) else None,
        }
        ranked: list[tuple[int, int, str]] = []
        for position, name in enumerate(control["candidates"]):
            if name in excluded:
                continue
            row = proxies.get(name, {})
            if not isinstance(row, dict) or row.get("alive") is False:
                continue
            history = row.get("history")
            delays = [
                entry.get("delay")
                for entry in history
                if isinstance(entry, dict) and isinstance(entry.get("delay"), int) and entry["delay"] > 0
            ] if isinstance(history, list) else []
            ranked.append((delays[-1] if delays else 1_000_000, position, name))
        if not ranked and used:
            # Start a fresh pass only after every currently healthy candidate
            # has been tried once. This prevents bouncing between the same two
            # low-latency nodes during one browser repair run.
            used.clear()
            excluded = {
                route.get("now") if isinstance(route, dict) else None,
                latency.get("now") if isinstance(latency, dict) else None,
            }
            for position, name in enumerate(control["candidates"]):
                if name in excluded:
                    continue
                row = proxies.get(name, {})
                if not isinstance(row, dict) or row.get("alive") is False:
                    continue
                history = row.get("history")
                delays = [
                    entry.get("delay")
                    for entry in history
                    if isinstance(entry, dict) and isinstance(entry.get("delay"), int) and entry["delay"] > 0
                ] if isinstance(history, list) else []
                ranked.append((delays[-1] if delays else 1_000_000, position, name))
        if not ranked:
            return False
        _delay, _position, selected = min(ranked)
        _request_json(
            f"{controller}/proxies/{quote(route_group, safe='')}",
            secret=secret,
            method="PUT",
            payload={"name": selected},
        )
        control["usedCandidates"] = [
            name for name in control["candidates"]
            if name in used or name == selected
        ]
        path.write_text(json.dumps(control, ensure_ascii=False), encoding="utf-8")
        return True
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        return False
