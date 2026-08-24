from __future__ import annotations

import json

from times_pipeline import proxy_control


def test_rotation_selects_another_healthy_low_latency_node(tmp_path, monkeypatch) -> None:
    control = tmp_path / "control.json"
    control.write_text(json.dumps({
        "formatVersion": proxy_control.CONTROL_VERSION,
        "controller": "http://127.0.0.1:9090",
        "secret": "ephemeral-secret",
        "routeGroup": "JOJO-ROUTE",
        "latencyGroup": "JOJO-AUTO",
        "candidates": ["node-a", "node-b", "node-c"],
    }), encoding="utf-8")
    calls = []

    def request(url, *, secret, method="GET", payload=None):
        calls.append((url, secret, method, payload))
        if method == "PUT":
            return {}
        return {"proxies": {
            "JOJO-ROUTE": {"now": "JOJO-AUTO"},
            "JOJO-AUTO": {"now": "node-a"},
            "node-a": {"alive": True, "history": [{"delay": 20}]},
            "node-b": {"alive": True, "history": [{"delay": 45}]},
            "node-c": {"alive": False, "history": [{"delay": 10}]},
        }}

    monkeypatch.setattr(proxy_control, "_request_json", request)

    assert proxy_control.rotate_proxy(control) is True
    assert calls[-1][2:] == ("PUT", {"name": "node-b"})
    assert all(call[1] == "ephemeral-secret" for call in calls)


def test_rotation_rejects_non_local_controller(tmp_path) -> None:
    control = tmp_path / "control.json"
    control.write_text(json.dumps({
        "formatVersion": proxy_control.CONTROL_VERSION,
        "controller": "https://external.example.test",
        "secret": "secret",
        "routeGroup": "JOJO-ROUTE",
        "latencyGroup": "JOJO-AUTO",
        "candidates": ["node-a"],
    }), encoding="utf-8")

    assert proxy_control.rotate_proxy(control) is False
