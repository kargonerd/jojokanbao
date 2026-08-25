from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import yaml


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a temporary, non-logged Mihomo config from a subscription")
    parser.add_argument("--subscription-env", default="JOJO_TIMES_PROXY_SUBSCRIPTION")
    parser.add_argument("--output", type=Path, required=True)
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


def _mihomo_config(subscription: dict[str, Any]) -> dict[str, Any]:
    names = list(dict.fromkeys(row["name"] for row in subscription["proxies"]))
    auto_group = "JOJO-TIMES-AUTO"
    route_group = "JOJO-TIMES-ROUTE"
    if auto_group in names or route_group in names:
        raise RuntimeError("The proxy subscription contains a reserved JOJO group name")
    return {
        "mixed-port": 7890,
        "allow-lan": False,
        "bind-address": "127.0.0.1",
        "mode": "rule",
        "log-level": "warning",
        "external-controller": "127.0.0.1:9090",
        "secret": "",
        "unified-delay": True,
        "tcp-concurrent": True,
        "proxies": subscription["proxies"],
        "proxy-groups": [{
            "name": auto_group,
            "type": "url-test",
            "proxies": names,
            "url": "https://www.gstatic.com/generate_204",
            "interval": 300,
            "tolerance": 100,
        }, {
            "name": route_group,
            "type": "select",
            "proxies": [auto_group, *names],
        }],
        "rules": [f"MATCH,{route_group}"],
    }


def main() -> None:
    args = _arguments()
    subscription_url = os.environ.get(args.subscription_env, "").strip()
    if not subscription_url:
        raise RuntimeError(f"{args.subscription_env} is not configured")
    subscription = _subscription(_download(subscription_url))
    config = _mihomo_config(subscription)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    print(f"Prepared a temporary Mihomo configuration with {len(subscription['proxies'])} nodes")


if __name__ == "__main__":
    main()
