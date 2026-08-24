from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
from typing import Any
from urllib.request import Request, urlopen

import yaml


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a temporary, non-logged Mihomo config from a subscription")
    parser.add_argument("--subscription-env", default="JOJO_TIMES_PROXY_SUBSCRIPTION")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--control-output", type=Path)
    return parser.parse_args()


def _download(url: str) -> bytes:
    try:
        request = Request(url, headers={"User-Agent": "JOJO-Times-Offline/2.0"})
        with urlopen(request, timeout=45) as response:
            return response.read(20_000_000)
    except Exception:
        raise RuntimeError("Unable to download the configured proxy subscription") from None


def _subscription(value: bytes) -> dict[str, Any]:
    try:
        parsed = yaml.safe_load(value)
    except Exception:
        raise RuntimeError("The configured proxy subscription is not valid Clash YAML") from None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("proxies"), list):
        raise RuntimeError("The configured proxy subscription does not contain a proxies list")
    proxies = []
    seen = set()
    for row in parsed["proxies"]:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str) or row["name"] in seen:
            continue
        seen.add(row["name"])
        proxies.append(row)
    if not proxies:
        raise RuntimeError("The configured proxy subscription contains no usable nodes")
    return {"proxies": proxies}


def _mihomo_config(subscription: dict[str, Any], secret: str) -> tuple[dict[str, Any], dict[str, Any]]:
    names = list(dict.fromkeys(row["name"] for row in subscription["proxies"]))
    config = {
        "mixed-port": 7890,
        "allow-lan": False,
        "bind-address": "127.0.0.1",
        "mode": "rule",
        "log-level": "warning",
        "external-controller": "127.0.0.1:9090",
        "secret": secret,
        "unified-delay": True,
        "tcp-concurrent": True,
        "proxies": subscription["proxies"],
        "proxy-groups": [
            {
                "name": "JOJO-AUTO",
                "type": "url-test",
                "proxies": names,
                "url": "https://www.gstatic.com/generate_204",
                "interval": 300,
                "tolerance": 100,
            },
            {
                "name": "JOJO-ROUTE",
                "type": "select",
                "proxies": ["JOJO-AUTO", *names],
            },
        ],
        "rules": ["MATCH,JOJO-ROUTE"],
    }
    control = {
        "formatVersion": "jojo-times-proxy-control/1",
        "controller": "http://127.0.0.1:9090",
        "secret": secret,
        "routeGroup": "JOJO-ROUTE",
        "latencyGroup": "JOJO-AUTO",
        "candidates": names,
    }
    return config, control


def main() -> None:
    args = _arguments()
    subscription_url = os.environ.get(args.subscription_env, "").strip()
    if not subscription_url:
        raise RuntimeError(f"{args.subscription_env} is not configured")
    subscription = _subscription(_download(subscription_url))
    names = list(dict.fromkeys(row["name"] for row in subscription["proxies"]))
    config, control = _mihomo_config(subscription, secrets.token_urlsafe(24))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    if args.control_output is not None:
        args.control_output.parent.mkdir(parents=True, exist_ok=True)
        args.control_output.write_text(json.dumps(control, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared a temporary Mihomo configuration with {len(names)} nodes")


if __name__ == "__main__":
    main()
