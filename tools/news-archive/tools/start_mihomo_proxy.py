"""Start a short-lived Mihomo load-balancer for archive acquisition.

The subscription is deliberately read from ``CLASH_SUBSCRIPTION_URL`` at
runtime.  For local runs, an already downloaded Clash profile can instead be
passed with ``--profile-file``.  Neither the subscription URL nor the source
profile is printed, persisted in the repository, or included in a checkpoint.
The generated config contains only on-runner node definitions and should be
removed by the caller's cleanup step.

This is a transport reliability aid, not a rate-limit bypass.  Callers still
need to keep the archive client's global request interval, retry policy, and
bounded worker count in place.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from collections.abc import Mapping
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml


DEFAULT_PORT = 7890
DEFAULT_HEALTH_CHECK_URL = "https://www.gstatic.com/generate_204"
DEFAULT_HEALTH_CHECK_EXPECTED_STATUS = 204
DEFAULT_HEALTH_CHECK_INTERVAL = 60
DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3_000
DEFAULT_HEALTH_CHECK_MAX_FAILED_TIMES = 2
MAX_SUBSCRIPTION_BYTES = 16 * 1024 * 1024
POOL_NAME = "jojo-archive-pool"
_REJECTED_PROXY_RE = re.compile(rb"(?:Parse config error: )?proxy (\d+):")


def _parse_yaml_payload(payload: bytes) -> dict[str, Any]:
    """Parse a Clash YAML response, including base64-wrapped subscriptions."""

    candidates = [payload]
    # Some subscription endpoints return a base64-encoded Clash profile even
    # when the URL advertises YAML.  Only try the decoded form after the
    # ordinary YAML parse, so normal YAML is not accidentally transformed.
    try:
        decoded = base64.b64decode(payload, validate=False)
    except (ValueError, binascii.Error):
        decoded = b""
    if decoded and decoded != payload:
        candidates.append(decoded)

    for candidate in candidates:
        try:
            parsed = yaml.safe_load(candidate.decode("utf-8-sig"))
        except (UnicodeDecodeError, yaml.YAMLError):
            continue
        if isinstance(parsed, Mapping):
            return dict(parsed)
    raise ValueError("subscription did not contain a Clash YAML mapping")


def _download_subscription(url: str) -> dict[str, Any]:
    if not url.strip():
        raise ValueError("CLASH_SUBSCRIPTION_URL is empty")
    request = Request(
        url,
        headers={"User-Agent": "JOJO-Olds/0.1 archive transport setup"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            payload = response.read(MAX_SUBSCRIPTION_BYTES + 1)
    except HTTPError as exc:
        raise RuntimeError(
            f"subscription download failed with HTTP {exc.code}"
        ) from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("subscription download failed") from None
    if len(payload) > MAX_SUBSCRIPTION_BYTES:
        raise ValueError("subscription response is larger than 16 MiB")
    return _parse_yaml_payload(payload)


def _load_profile_file(path: Path) -> dict[str, Any]:
    """Load a local Clash profile without mutating the user's active profile."""

    if not path.is_file():
        raise ValueError(f"local Clash profile does not exist: {path}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ValueError("could not inspect local Clash profile") from exc
    if size > MAX_SUBSCRIPTION_BYTES:
        raise ValueError("local Clash profile is larger than 16 MiB")
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise ValueError("could not read local Clash profile") from exc
    return _parse_yaml_payload(payload)


def _node_list(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    proxies = profile.get("proxies")
    if not isinstance(proxies, list):
        raise ValueError(
            "subscription has no materialized 'proxies' list; "
            "provider-only profiles are not supported by this runner"
        )
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in proxies:
        if not isinstance(value, Mapping):
            continue
        name = value.get("name")
        if not isinstance(name, str) or not name.strip() or name in seen:
            continue
        # Copy the mapping so the caller's parsed profile is never mutated.
        node = dict(value)
        node["name"] = name
        nodes.append(node)
        seen.add(name)
    if not nodes:
        raise ValueError("subscription contained no named proxy nodes")
    return nodes


def build_mihomo_config(
    profile: Mapping[str, Any],
    *,
    port: int,
    health_check_url: str = DEFAULT_HEALTH_CHECK_URL,
    health_check_expected_status: int = DEFAULT_HEALTH_CHECK_EXPECTED_STATUS,
    health_check_interval: int = DEFAULT_HEALTH_CHECK_INTERVAL,
    health_check_timeout_ms: int = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    health_check_max_failed_times: int = DEFAULT_HEALTH_CHECK_MAX_FAILED_TIMES,
) -> dict[str, Any]:
    """Build a minimal, deterministic config that routes all traffic to a pool."""

    if not 1 <= port <= 65535:
        raise ValueError("proxy port must be between 1 and 65535")
    if not health_check_url.startswith(("https://", "http://")):
        raise ValueError("health-check URL must use HTTP or HTTPS")
    if not 100 <= health_check_expected_status <= 599:
        raise ValueError("health-check expected status must be between 100 and 599")
    if not 10 <= health_check_interval <= 86_400:
        raise ValueError("health-check interval must be between 10 and 86400 seconds")
    if not 1_000 <= health_check_timeout_ms <= 60_000:
        raise ValueError("health-check timeout must be between 1000 and 60000 ms")
    if not 1 <= health_check_max_failed_times <= 10:
        raise ValueError("health-check max failures must be between 1 and 10")
    nodes = _node_list(profile)
    names = [str(node["name"]) for node in nodes]
    return {
        "mixed-port": port,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "error",
        "ipv6": False,
        "proxies": nodes,
        "proxy-groups": [
            {
                "name": POOL_NAME,
                "type": "load-balance",
                "strategy": "round-robin",
                "proxies": names,
                # Do not send the first batch through every dead subscription
                # node in round-robin order.  Mihomo keeps unhealthy nodes out
                # of the active pool after the bounded health check while
                # still distributing live requests across the survivors.
                "url": health_check_url,
                "interval": health_check_interval,
                "lazy": False,
                "timeout": health_check_timeout_ms,
                "max-failed-times": health_check_max_failed_times,
                "expected-status": health_check_expected_status,
            }
        ],
        # Do not inherit subscription rules: archive requests must not be
        # accidentally sent direct or through a bypass group.
        "rules": [f"MATCH,{POOL_NAME}"],
    }


def _write_mihomo_config(path: Path, config: Mapping[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as stream:
        yaml.safe_dump(dict(config), stream, allow_unicode=True, sort_keys=False)
    path.chmod(0o600)


def _drop_rejected_proxy(
    config: dict[str, Any],
    diagnostic: bytes,
) -> int:
    """Remove one node rejected by Mihomo without exposing its credentials."""

    match = _REJECTED_PROXY_RE.search(diagnostic)
    proxies = config.get("proxies")
    if match is None or not isinstance(proxies, list):
        raise RuntimeError("Mihomo rejected the generated proxy configuration")
    index = int(match.group(1))
    if not 0 <= index < len(proxies):
        raise RuntimeError("Mihomo reported an invalid proxy index")
    rejected = proxies.pop(index)
    rejected_name = rejected.get("name") if isinstance(rejected, Mapping) else None
    for group in config.get("proxy-groups", []):
        if not isinstance(group, dict) or not isinstance(group.get("proxies"), list):
            continue
        group["proxies"] = [
            name for name in group["proxies"] if name != rejected_name
        ]
    if not proxies:
        raise ValueError("Mihomo rejected every subscription proxy node")
    return index


def _preflight_mihomo_config(
    *,
    binary: Path,
    state_dir: Path,
    config_path: Path,
    config: dict[str, Any],
) -> int:
    """Drop malformed subscription nodes until Mihomo accepts the pool."""

    removed = 0
    while True:
        completed = subprocess.run(
            [
                str(binary),
                "-t",
                "-d",
                str(state_dir),
                "-f",
                str(config_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
        if completed.returncode == 0:
            return removed
        _drop_rejected_proxy(config, completed.stdout or b"")
        removed += 1
        _write_mihomo_config(config_path, config)


def _wait_for_port(host: str, port: int, *, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Mihomo exited before opening its local port")
        try:
            with socket.create_connection((host, port), timeout=1):
                return
        except OSError:
            time.sleep(0.25)
    raise TimeoutError("Mihomo did not open its local port within 30 seconds")


def _write_github_env(path: Path, values: Mapping[str, str]) -> None:
    with path.open("a", encoding="utf-8") as stream:
        for key, value in values.items():
            stream.write(f"{key}={value}\n")


def start_proxy(
    *,
    binary: Path,
    state_dir: Path,
    port: int,
    github_env: Path | None,
    profile_file: Path | None = None,
    health_check_url: str = DEFAULT_HEALTH_CHECK_URL,
    health_check_expected_status: int = DEFAULT_HEALTH_CHECK_EXPECTED_STATUS,
    health_check_interval: int = DEFAULT_HEALTH_CHECK_INTERVAL,
    health_check_timeout_ms: int = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    health_check_max_failed_times: int = DEFAULT_HEALTH_CHECK_MAX_FAILED_TIMES,
) -> int:
    subscription_url = os.environ.get("CLASH_SUBSCRIPTION_URL", "")
    if profile_file is not None:
        profile = _load_profile_file(profile_file)
    else:
        profile = _download_subscription(subscription_url)
    config = build_mihomo_config(
        profile,
        port=port,
        health_check_url=health_check_url,
        health_check_expected_status=health_check_expected_status,
        health_check_interval=health_check_interval,
        health_check_timeout_ms=health_check_timeout_ms,
        health_check_max_failed_times=health_check_max_failed_times,
    )

    state_dir.mkdir(parents=True, exist_ok=True)
    config_path = state_dir / "config.yaml"
    log_path = state_dir / "mihomo.log"
    pid_path = state_dir / "mihomo.pid"
    _write_mihomo_config(config_path, config)
    removed_nodes = _preflight_mihomo_config(
        binary=binary,
        state_dir=state_dir,
        config_path=config_path,
        config=config,
    )

    log_stream = log_path.open("ab")
    log_path.chmod(0o600)
    process = subprocess.Popen(
        [str(binary), "-d", str(state_dir), "-f", str(config_path)],
        stdin=subprocess.DEVNULL,
        stdout=log_stream,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_path.write_text(str(process.pid), encoding="ascii")
    try:
        _wait_for_port("127.0.0.1", port, process=process)
    except Exception:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log_stream.close()
        raise
    log_stream.close()

    if github_env is not None:
        _write_github_env(
            github_env,
            {
                "ARCHIVE_HTTP_PROXY": f"http://127.0.0.1:{port}",
                "MIHOMO_PID_FILE": str(pid_path),
                "MIHOMO_STATE_DIR": str(state_dir),
            },
        )
    suffix = f"; filtered {removed_nodes} invalid nodes" if removed_nodes else ""
    print(f"Started archive proxy pool with {len(config['proxies'])} nodes{suffix}.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mihomo-binary", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--github-env", type=Path)
    parser.add_argument(
        "--health-check-url",
        default=DEFAULT_HEALTH_CHECK_URL,
        help="URL used by Mihomo to keep only archive-reachable nodes active.",
    )
    parser.add_argument(
        "--health-check-expected-status",
        type=int,
        default=DEFAULT_HEALTH_CHECK_EXPECTED_STATUS,
        help="Expected HTTP status for --health-check-url (default: 204).",
    )
    parser.add_argument(
        "--health-check-interval",
        type=int,
        default=DEFAULT_HEALTH_CHECK_INTERVAL,
        help="Seconds between per-node health checks (default: 60).",
    )
    parser.add_argument(
        "--health-check-timeout-ms",
        type=int,
        default=DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
        help="Per-node health-check timeout in milliseconds (default: 3000).",
    )
    parser.add_argument(
        "--health-check-max-failed-times",
        type=int,
        default=DEFAULT_HEALTH_CHECK_MAX_FAILED_TIMES,
        help="Consecutive failures before a node is removed (default: 2).",
    )
    parser.add_argument(
        "--profile-file",
        type=Path,
        help=(
            "Use a local Clash YAML profile for an isolated local instance; "
            "when omitted, CLASH_SUBSCRIPTION_URL is downloaded."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return start_proxy(
            binary=args.mihomo_binary,
            state_dir=args.state_dir,
            port=args.port,
            github_env=args.github_env,
            profile_file=args.profile_file,
            health_check_url=args.health_check_url,
            health_check_expected_status=args.health_check_expected_status,
            health_check_interval=args.health_check_interval,
            health_check_timeout_ms=args.health_check_timeout_ms,
            health_check_max_failed_times=args.health_check_max_failed_times,
        )
    except Exception as exc:
        # A malformed URL or HTTP exception can echo the secret in its error
        # text.  Redact it defensively before sending anything to Actions.
        secret = os.environ.get("CLASH_SUBSCRIPTION_URL", "")
        message = str(exc)
        if secret:
            message = message.replace(secret, "<redacted-subscription>")
        print(
            f"::error::Could not start the archive proxy pool: {message}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
