from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.start_mihomo_proxy import (
    POOL_NAME,
    _drop_rejected_proxy,
    _load_profile_file,
    _parse_yaml_payload,
    _preflight_mihomo_config,
    build_mihomo_config,
)


def test_build_mihomo_config_routes_all_traffic_to_round_robin_pool():
    config = build_mihomo_config(
        {
            "proxies": [
                {"name": "node-a", "type": "http", "server": "a.example"},
                {"name": "node-b", "type": "socks5", "server": "b.example"},
            ],
            "rules": ["DOMAIN-SUFFIX,example.com,DIRECT"],
        },
        port=7890,
    )

    assert config["mixed-port"] == 7890
    assert config["rules"] == [f"MATCH,{POOL_NAME}"]
    assert config["proxy-groups"] == [
        {
            "name": POOL_NAME,
            "type": "load-balance",
            "strategy": "round-robin",
            "proxies": ["node-a", "node-b"],
            "url": "https://www.gstatic.com/generate_204",
            "interval": 60,
            "lazy": False,
            "timeout": 3000,
            "max-failed-times": 2,
            "expected-status": 204,
        }
    ]
    assert [node["name"] for node in config["proxies"]] == ["node-a", "node-b"]


def test_build_mihomo_config_accepts_archive_specific_health_check():
    replay_url = (
        "https://web.archive.org/web/20241216181701id_/"
        "https://www.nytimes.com/2011/05/01/movies/summer-movies-june.html"
    )

    config = build_mihomo_config(
        {"proxies": [{"name": "node-a", "type": "http", "server": "a.example"}]},
        port=18791,
        health_check_url=replay_url,
        health_check_expected_status=200,
        health_check_interval=600,
        health_check_timeout_ms=10_000,
        health_check_max_failed_times=1,
    )

    pool = config["proxy-groups"][0]
    assert pool["url"] == replay_url
    assert pool["expected-status"] == 200
    assert pool["interval"] == 600
    assert pool["timeout"] == 10_000
    assert pool["max-failed-times"] == 1


def test_build_mihomo_config_rejects_provider_only_profiles():
    try:
        build_mihomo_config(
            {"proxy-providers": {"remote": {"url": "https://example.test"}}},
            port=7890,
        )
    except ValueError as exc:
        assert "materialized 'proxies' list" in str(exc)
    else:
        raise AssertionError("provider-only profiles should fail closed")


def test_parse_yaml_payload_accepts_base64_wrapped_profiles():
    import base64

    payload = base64.b64encode(
        b"proxies:\n  - name: node-a\n    type: http\n"
    )
    parsed = _parse_yaml_payload(payload)
    assert parsed["proxies"][0]["name"] == "node-a"


def test_load_profile_file_reads_local_profile_without_subscription(tmp_path: Path):
    profile = tmp_path / "profile.yaml"
    profile.write_text(
        "proxies:\n  - name: local-node\n    type: http\n",
        encoding="utf-8",
    )

    parsed = _load_profile_file(profile)

    assert parsed["proxies"][0]["name"] == "local-node"


def test_drop_rejected_proxy_updates_the_pool_without_exposing_node_data():
    config = build_mihomo_config(
        {
            "proxies": [
                {"name": "node-a", "type": "http", "password": "secret-a"},
                {"name": "node-b", "type": "http", "password": "secret-b"},
            ]
        },
        port=7890,
    )

    removed_index = _drop_rejected_proxy(
        config,
        b"configuration failed: proxy 0: invalid REALITY short ID",
    )

    assert removed_index == 0
    assert [node["name"] for node in config["proxies"]] == ["node-b"]
    assert config["proxy-groups"][0]["proxies"] == ["node-b"]


def test_drop_rejected_proxy_fails_closed_for_unscoped_config_errors():
    config = build_mihomo_config(
        {"proxies": [{"name": "node-a", "type": "http"}]},
        port=7890,
    )

    with pytest.raises(RuntimeError, match="rejected the generated"):
        _drop_rejected_proxy(config, b"configuration failed")


def test_preflight_rewrites_config_after_one_bad_subscription_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    config = build_mihomo_config(
        {
            "proxies": [
                {"name": "bad", "type": "vless"},
                {"name": "good", "type": "http"},
            ]
        },
        port=17890,
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text("initial", encoding="utf-8")
    results = iter(
        [
            SimpleNamespace(
                returncode=1,
                stdout=b"proxy 0: invalid REALITY short ID",
            ),
            SimpleNamespace(returncode=0, stdout=b"configuration test is successful"),
        ]
    )
    monkeypatch.setattr(
        "tools.start_mihomo_proxy.subprocess.run",
        lambda *args, **kwargs: next(results),
    )

    removed = _preflight_mihomo_config(
        binary=Path("mihomo"),
        state_dir=tmp_path,
        config_path=config_path,
        config=config,
    )

    assert removed == 1
    assert [node["name"] for node in config["proxies"]] == ["good"]
    assert "good" in config_path.read_text(encoding="utf-8")
    assert "bad" not in config_path.read_text(encoding="utf-8")
