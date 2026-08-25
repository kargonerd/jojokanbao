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


def test_mihomo_config_can_rotate_from_auto_to_individual_nodes() -> None:
    config = _mihomo_config({"proxies": [
        {"name": "node-a", "type": "socks5", "server": "one.test", "port": 1080},
        {"name": "node-b", "type": "socks5", "server": "two.test", "port": 1080},
    ]})

    assert config["external-controller"] == "127.0.0.1:9090"
    assert config["secret"] == ""
    assert config["proxy-groups"] == [
        {
            "name": "JOJO-TIMES-AUTO",
            "type": "url-test",
            "proxies": ["node-a", "node-b"],
            "url": "https://www.gstatic.com/generate_204",
            "interval": 300,
            "tolerance": 100,
        },
        {
            "name": "JOJO-TIMES-ROUTE",
            "type": "select",
            "proxies": ["JOJO-TIMES-AUTO", "node-a", "node-b"],
        },
    ]
    assert config["rules"] == ["MATCH,JOJO-TIMES-ROUTE"]
