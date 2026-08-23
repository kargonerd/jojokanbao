from __future__ import annotations

import pytest

from prepare_proxy import _subscription


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
