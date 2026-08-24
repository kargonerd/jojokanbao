from __future__ import annotations

import pytest

from prepare_proxy import _mihomo_config, _subscription


def test_subscription_keeps_unique_named_nodes_without_logging_values() -> None:
    parsed = _subscription(b"""
proxies:
  - name: node-a
    type: socks5
    server: example.test
    port: 1080
  - name: node-a
    type: socks5
    server: duplicate.test
    port: 1080
""")
    assert [row["name"] for row in parsed["proxies"]] == ["node-a"]


def test_invalid_subscription_uses_a_generic_error() -> None:
    with pytest.raises(RuntimeError, match="not valid Clash YAML") as error:
        _subscription(b"secret-token: [")
    assert "secret-token" not in str(error.value)


def test_mihomo_starts_with_latency_group_and_exposes_isolated_rotation_group() -> None:
    subscription = {"proxies": [
        {"name": "node-a", "type": "socks5", "server": "a.test", "port": 1080},
        {"name": "node-b", "type": "socks5", "server": "b.test", "port": 1080},
    ]}

    config, control = _mihomo_config(subscription, "ephemeral-secret")

    assert config["rules"] == ["MATCH,JOJO-ROUTE"]
    assert config["proxy-groups"][1] == {
        "name": "JOJO-ROUTE",
        "type": "select",
        "proxies": ["JOJO-AUTO", "node-a", "node-b"],
    }
    assert control["candidates"] == ["node-a", "node-b"]
    assert control["secret"] == "ephemeral-secret"
