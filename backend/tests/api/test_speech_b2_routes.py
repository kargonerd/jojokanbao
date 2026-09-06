import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

from app.speech.encoding import EncodedAudio


@pytest.fixture
def routes_module(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3] / "tools" / "speech"))
    import b2_routes
    return b2_routes


def test_node_clients_use_explicit_local_connect_without_changing_global_proxy(routes_module, monkeypatch):
    module = routes_module
    monkeypatch.setenv("HTTPS_PROXY", "http://other-task.invalid:7890")
    client = Mock()
    factory = Mock(return_value=client)
    monkeypatch.setattr(module.boto3, "client", factory)
    settings = SimpleNamespace(speech_s3_endpoint="https://s3.test.backblazeb2.com",
                               speech_s3_region="test", speech_s3_key_id="test-id",
                               speech_s3_application_key="test-secret", speech_s3_bucket="test",
                               speech_cdn_base="https://cdn.example")
    store = module.make_store(settings, "http://127.0.0.1:19000")
    assert store.client is client
    kwargs = factory.call_args.kwargs
    assert kwargs["config"].proxies == {"https": "http://127.0.0.1:19000"}
    assert kwargs.get("verify", True) is True
    import os
    assert os.environ["HTTPS_PROXY"] == "http://other-task.invalid:7890"
    for invalid in ("http://proxy.example:80", "http://key:secret@127.0.0.1:80", "http://127.0.0.1:80/path"):
        with pytest.raises(ValueError):
            module.make_store(settings, invalid)


def test_failed_node_cools_down_and_lost_upload_ack_reuses_object_on_another_node(routes_module):
    module = routes_module
    objects, writes = {}, []
    audio = EncodedAudio(b"existing durable MP3", 2)
    def put(provider, key, audio):
        record = {"key": key, "bytes": len(audio.data), "sha256": hashlib.sha256(audio.data).hexdigest()}
        objects[key] = record
        writes.append(key)
        raise OSError("lost upload acknowledgment")
    broken = SimpleNamespace(get=lambda provider, key: objects.get(key), put=put)
    healthy = SimpleNamespace(get=lambda provider, key: objects.get(key), put=Mock())
    router = module.B2Routes([("node-001", broken), ("node-002", healthy)])
    with pytest.raises(OSError):
        router.upload_and_verify("a" * 64, audio)
    assert router.upload_and_verify("a" * 64, audio) == objects["a" * 64]
    assert len(writes) == 1
    healthy.put.assert_not_called()
    state = router.snapshot()
    assert state[0]["failures"] == 1 and state[0]["cooldownSeconds"] > 0
    assert state[1]["uploaded"] == 1
    assert "store" not in state[0] and "lost upload" not in json.dumps(state)


def test_uploads_run_on_multiple_nodes_concurrently_with_per_node_cap(routes_module):
    module = routes_module
    entered = threading.Barrier(3)
    release = threading.Event()
    def get(*args):
        entered.wait(timeout=5)
        assert release.wait(5)
        return None
    router = module.B2Routes([("node-001", SimpleNamespace(get=get)),
                              ("node-002", SimpleNamespace(get=get))], capacity=1)
    with ThreadPoolExecutor(2) as pool:
        first, second = pool.submit(router.get, "mimo", "a"), pool.submit(router.get, "mimo", "b")
        try:
            entered.wait(timeout=5)
            assert [r["active"] for r in router.snapshot()] == [1, 1]
            with pytest.raises(module.RoutesUnavailable):
                router.get("mimo", "c")
        finally:
            release.set()
        assert first.result() is None and second.result() is None
    assert [r["successes"] for r in router.snapshot()] == [1, 1]


def test_prepare_keeps_only_subscription_nodes_and_loopback_listeners(routes_module, tmp_path, monkeypatch):
    import b2_proxy
    # No listeners created by this unit test.
    check = Mock()
    check.__enter__ = Mock(return_value=check)
    check.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(b2_proxy.socket, "socket", lambda: check)
    profile = tmp_path / "profile.yaml"
    profile.write_text(yaml.safe_dump({"tun": {"enable": True}, "external-controller": "0.0.0.0:9090",
                                      "rules": ["MATCH,DIRECT"], "proxies": [
        {"name": "secret name", "type": "ss", "server": "node.example", "port": 443, "password": "secret"},
        {"name": "same endpoint", "type": "ss", "server": "node.example", "port": 443, "password": "secret"},
        {"name": "requires another profile", "type": "ss", "server": "other.example", "port": 443,
         "dialer-proxy": "other-user-profile"}]}))
    original = profile.read_bytes()
    output = tmp_path / "isolated"
    routes = b2_proxy.prepare(profile, output)
    config = yaml.safe_load((output / "config.yaml").read_text())
    assert profile.read_bytes() == original
    assert len(routes) == 1 and config["tun"]["enable"] is False
    assert "external-controller" not in config
    assert config["allow-lan"] is False
    assert config["listeners"][0]["listen"] == "127.0.0.1"
    assert config["listeners"][0]["proxy"] == "node-001"
    assert "secret" not in (output / "candidates.json").read_text()
    with pytest.raises(ValueError):
        b2_proxy.prepare(profile, output)


def test_probe_rejects_bucket_objects_and_credentials_before_any_request(routes_module, tmp_path):
    from b2_proxy import probe
    for endpoint in ("http://s3.test.backblazeb2.com", "https://s3.test.backblazeb2.com/bucket/file",
                     "https://secret@s3.test.backblazeb2.com", "https://other.example/"):
        with pytest.raises(ValueError):
            probe(tmp_path, endpoint)


def test_remap_changes_only_task_proxy_destinations_and_keeps_batch_ports(routes_module, tmp_path):
    from b2_proxy import remap
    source, output = tmp_path / "old", tmp_path / "replacement"
    source.mkdir()
    original = {"tun": {"enable": False}, "allow-lan": False, "rules": ["MATCH,REJECT"],
                "proxies": [{"name": "node-001", "server": "old.example", "type": "http"},
                            {"name": "node-002", "server": "new.example", "type": "vless"}]}
    (source / "config.yaml").write_text(yaml.safe_dump(original))
    routes = {"routes": [{"id": "node-001", "proxy": "http://127.0.0.1:19100"}]}
    (source / "routes.json").write_text(json.dumps(routes))
    remap(source, output, ["node-002"])
    changed = yaml.safe_load((output / "config.yaml").read_text())
    assert yaml.safe_load((source / "config.yaml").read_text()) == original
    assert json.loads((output / "routes.json").read_text()) == routes
    assert changed["listeners"][0] == {"name": "node-001", "type": "http", "listen": "127.0.0.1",
                                      "port": 19100, "proxy": "node-002", "users": []}
    assert [n["name"] for n in changed["proxies"]] == ["node-002"]
    assert changed["tun"]["enable"] is False
    with pytest.raises(ValueError):
        remap(source, output, ["node-001"])
