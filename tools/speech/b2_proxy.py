"""Task-local Mihomo listeners from an already imported Clash subscription.

Never edits Clash Verge, system proxy, TUN, or MiMo configuration. Generated
configs contain subscription credentials and must stay in an ignored directory.
Probe uses credential-free, TLS-verified HEADs of the public B2 service root.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time

import yaml


def prepare(profile, output, first_port=19000):
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a fresh task directory; do not overwrite a running core")
    raw = yaml.safe_load(profile.read_text(encoding="utf-8"))
    nodes, routes, seen = [], [], set()
    for source in raw.get("proxies", []):
        identity = (source.get("type"), source.get("server"), source.get("port"))
        if identity in seen or not identity[1] or source.get("dialer-proxy"):
            continue
        seen.add(identity)
        node = deepcopy(source)
        name = f"node-{len(nodes) + 1:03d}"
        node["name"] = name
        port = first_port + len(nodes)
        if not 1024 <= port <= 65535:
            raise ValueError("Invalid listener port")
        with socket.socket() as check:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                check.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            check.bind(("127.0.0.1", port))
        nodes.append(node)
        routes.append({"id": name, "proxy": f"http://127.0.0.1:{port}",
                       "endpointGroup": hashlib.sha256(str(identity[1]).encode()).hexdigest()[:16]})
    if not nodes:
        raise ValueError("No self-contained subscription nodes")
    config = {"allow-lan": False, "bind-address": "127.0.0.1", "mode": "rule",
              "log-level": "silent", "ipv6": False, "tun": {"enable": False},
              "dns": {"enable": False}, "profile": {"store-selected": False},
              "proxies": nodes, "rules": ["MATCH,REJECT"],
              "listeners": [{"name": r["id"], "type": "http", "listen": "127.0.0.1",
                             "port": first_port + i, "proxy": r["id"], "users": []}
                            for i, r in enumerate(routes)]}
    output.mkdir(parents=True)
    (output / "config.yaml").write_text(yaml.safe_dump(config, allow_unicode=True), encoding="utf-8")
    (output / "candidates.json").write_text(json.dumps({"routes": routes}, indent=2), encoding="utf-8")
    return routes


def remap(source, output, node_ids):
    """Generate replacement routes on the same local ports; batch can retry in place.

    Does not stop/reload any core. The operator verifies the old task-local core,
    validates this config, then replaces only that core (never Clash Verge).
    """
    from urllib.parse import urlsplit
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a fresh replacement directory")
    config = yaml.safe_load((source / "config.yaml").read_text(encoding="utf-8"))
    routes = json.loads((source / "routes.json").read_text())["routes"]
    nodes = {n["name"]: n for n in config["proxies"]}
    if len(node_ids) != len(routes) or len(set(node_ids)) != len(node_ids) or any(n not in nodes for n in node_ids):
        raise ValueError("Select one distinct existing candidate per listener")
    listeners = []
    for route, target in zip(routes, node_ids):
        proxy = urlsplit(route["proxy"])
        if proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port:
            raise ValueError("Only existing loopback listeners may be remapped")
        listeners.append({"name": route["id"], "type": "http", "listen": "127.0.0.1",
                          "port": proxy.port, "proxy": target, "users": []})
    config.update(proxies=[nodes[n] for n in node_ids], listeners=listeners)
    output.mkdir(parents=True)
    (output / "config.yaml").write_text(yaml.safe_dump(config, allow_unicode=True), encoding="utf-8")
    (output / "routes.json").write_text(json.dumps({"routes": routes}, indent=2))
    (output / "mapping.json").write_text(json.dumps(dict(zip((r["id"] for r in routes), node_ids)), indent=2))
    return routes


def probe(directory, endpoint, take=8):
    import httpx
    from urllib.parse import urlsplit
    address = urlsplit(endpoint)
    if (address.scheme != "https" or not address.hostname
            or not address.hostname.endswith(".backblazeb2.com")
            or address.username or address.password or address.query or address.fragment
            or address.path not in ("", "/") or address.port not in (None, 443)):
        raise ValueError("Probe only permits the public HTTPS B2 service root")
    candidates = json.loads((directory / "candidates.json").read_text())["routes"]

    def test(route):
        started = time.monotonic()
        try:
            with httpx.Client(proxy=route["proxy"], trust_env=False, timeout=10) as client:
                response = client.head(endpoint)
            if response.status_code not in (200, 400, 403, 404, 405):
                raise ValueError("B2 service probe failed")
            return {**route, "ok": True, "seconds": round(time.monotonic() - started, 3),
                    "status": response.status_code}
        except Exception as error:
            # Exception strings may contain credentials/URLs. Persist type only.
            return {**route, "ok": False, "error": type(error).__name__}

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(test, candidates))
    passing = sorted((r for r in results if r["ok"]), key=lambda r: r["seconds"])
    selected, groups = [], set()
    for route in passing:
        if route["endpointGroup"] not in groups:
            selected.append({"id": route["id"], "proxy": route["proxy"]})
            groups.add(route["endpointGroup"])
        if len(selected) == take:
            break
    (directory / "probe.json").write_text(json.dumps({"testedAt": time.time(), "results": results}, indent=2))
    if len(selected) < 2:
        raise RuntimeError("Fewer than two distinct endpoints passed B2 connectivity probing")
    (directory / "routes.json").write_text(json.dumps({"routes": selected}, indent=2))
    return {"tested": len(results), "passing": len(passing), "selected": selected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("prepare")
    create.add_argument("--profile", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--first-port", type=int, default=19000)
    create.add_argument("--core", type=Path, required=True)
    replace = commands.add_parser("remap")
    replace.add_argument("--source", type=Path, required=True)
    replace.add_argument("--output", type=Path, required=True)
    replace.add_argument("--nodes", nargs="+", required=True)
    replace.add_argument("--core", type=Path, required=True)
    check = commands.add_parser("probe")
    check.add_argument("--directory", type=Path, required=True)
    check.add_argument("--endpoint", required=True)
    check.add_argument("--take", type=int, default=8, choices=range(2, 17))
    args = parser.parse_args()
    try:
        if args.command in ("prepare", "remap"):
            routes = (prepare(args.profile, args.output, args.first_port) if args.command == "prepare"
                      else remap(args.source, args.output, args.nodes))
            result = subprocess.run([str(args.core), "-t", "-d", str(args.output.resolve()),
                                     "-f", str((args.output / "config.yaml").resolve())],
                                    capture_output=True, timeout=30,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode:
                raise ValueError("Mihomo rejected the isolated configuration; raw output withheld")
            print(json.dumps({"prepared": len(routes), "valid": True}))
        else:
            print(json.dumps(probe(args.directory, args.endpoint, args.take)))
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
