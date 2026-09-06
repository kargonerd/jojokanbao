import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from botocore.config import Config

from app.core.config import Settings
from app.speech.encoding import EncodedAudio


@pytest.fixture
def publication(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3] / "tools" / "speech"))
    import library_pool as pool
    plan = {"formatVersion": "jojo-speech-plan/1", "books": [{
        "datasetId": "book", "itemKey": "full-book", "title": "Book", "chapters": [
            {"id": f"chapter:{i}", "segments": [f"text-{i}", "shared"]} for i in range(12)
        ]}]}
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    args = SimpleNamespace(plan=plan_path, output=tmp_path / "run", rpm=80,
                           start_concurrency=4, max_concurrency=4, accounts=1,
                           publish_workers=8, publish_only=True)
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1,
                        speech_storage="b2", mimo_api_key="test", tts_enabled=True)
    client = Mock()
    client.meta.config = Config()
    store = SimpleNamespace(client=client, put=Mock(side_effect=AssertionError("No MP3 upload")),
                            put_json=Mock(), get=lambda provider, key: {
                                "key": key, "object": f"audio/{key}.mp3", "duration": 2,
                                "bytes": 100, "sha256": "a" * 64})
    monkeypatch.setattr(pool.batch, "speech_store", lambda _: store)
    monkeypatch.setattr(pool.boto3, "client", lambda *a, **kw: client)
    monkeypatch.setattr(pool, "offline_provider", Mock(side_effect=AssertionError("No TTS transport")))
    monkeypatch.setattr(pool, "prepare_audio", Mock(side_effect=AssertionError("No synthesis")))
    return pool, args, settings, store


def test_parallel_publication_orders_remote_writes_and_serializes_checkpoint(publication, monkeypatch):
    pool, args, settings, store = publication
    lock, overlap = threading.Lock(), threading.Event()
    active = peak = writers = 0
    manifests, saved_sizes = set(), []
    original_save = pool.batch.save_report

    def put_json(key, value, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active >= 3:
                overlap.set()
        try:
            assert overlap.wait(3), "Publication must not be serial"
            time.sleep(.01)
            with lock:
                if "segments" in value:
                    assert [e["offset"] for e in value["segments"]] == [0, 2]
                    manifests.add(key)
                else:
                    assert value["manifest"] in manifests
        finally:
            with lock:
                active -= 1

    def save(path, value):
        nonlocal writers
        if path.name != "checkpoint.json":
            return original_save(path, value)
        with lock:
            writers += 1
            assert writers == 1
        try:
            time.sleep(.005)
            original_save(path, value)
            saved_sizes.append(len(value["complete"]))
        finally:
            with lock:
                writers -= 1

    store.put_json = put_json
    monkeypatch.setattr(pool.batch, "save_report", save)
    asyncio.run(pool.run_pool(args, settings))
    checkpoint = json.loads((args.output / "checkpoint.json").read_text())
    summary = json.loads((args.output / "summary.json").read_text())
    assert 3 <= peak <= args.publish_workers
    assert len(checkpoint["complete"]) == len(manifests) == 24
    assert saved_sizes == list(range(1, 25))
    assert summary["status"] == "complete" and summary["requestsSent"] == 0
    assert summary["publishOnly"] and summary["activePublications"] == 0
    assert all(row["segmentsComplete"] == 24 for row in summary["totals"].values())
    # A resumed run must skip every completed chapter, including its JSON writes.
    store.put_json = Mock(side_effect=AssertionError("Already published"))
    asyncio.run(pool.run_pool(args, settings))


def test_missing_cache_in_publish_only_never_synthesizes(publication):
    pool, args, settings, store = publication
    store.get = lambda *args: None
    with pytest.raises(ValueError, match="synthesis is disabled"):
        asyncio.run(pool.run_pool(args, settings))
    summary = json.loads((args.output / "summary.json").read_text())
    assert summary["status"] == "failed" and summary["requestsSent"] == 0
    assert not list((args.output / "reports").glob("*.json"))


def test_publish_only_rejects_pending_mp3_without_deleting_it(publication):
    pool, args, settings, store = publication
    from outbox import AudioOutbox
    box = AudioOutbox(args.output / "outbox.sqlite3")
    box.stage("b" * 64, "白桦", EncodedAudio(b"keep-me", 2))
    box.close()
    with pytest.raises(ValueError, match="confirmed first"):
        asyncio.run(pool.run_pool(args, settings))
    box = AudioOutbox(args.output / "outbox.sqlite3")
    assert box.snapshot()["pending"] == 1
    assert box.load("b" * 64).data == b"keep-me"
    box.close()
    store.put.assert_not_called()


def test_failed_index_does_not_block_other_chapters_or_commit_failed_chapter(publication):
    pool, args, settings, store = publication
    failed_prefix = None
    manifests = set()
    guard = threading.Lock()

    def put_json(key, value, **kwargs):
        nonlocal failed_prefix
        with guard:
            if "segments" in value:
                manifests.add(key)
                if failed_prefix is None:
                    failed_prefix = key.rsplit("/", 1)[0]
            elif key == f"{failed_prefix}/index.json":
                raise OSError("One chapter index temporarily unavailable")
            else:
                assert value["manifest"] in manifests

    store.put_json = put_json

    async def scenario():
        run = asyncio.create_task(pool.run_pool(args, settings))
        try:
            for _ in range(400):
                checkpoint_path = args.output / "checkpoint.json"
                if checkpoint_path.exists():
                    checkpoint = json.loads(checkpoint_path.read_text())
                    if len(checkpoint["complete"]) == 23:
                        break
                await asyncio.sleep(.02)
            else:
                pytest.fail("One failed index blocked unrelated chapters")
            (args.output / "STOP").write_text("test pause")
            await asyncio.wait_for(run, 12)
        finally:
            if not run.done():
                (args.output / "STOP").write_text("test pause")
                await asyncio.wait_for(run, 12)

    asyncio.run(scenario())
    checkpoint = json.loads((args.output / "checkpoint.json").read_text())
    assert len(checkpoint["complete"]) == 23
    (args.output / "STOP").unlink()
    store.put_json = Mock()
    asyncio.run(pool.run_pool(args, settings))
    assert store.put_json.call_count == 2
    assert len(json.loads((args.output / "checkpoint.json").read_text())["complete"]) == 24


@pytest.mark.parametrize("value", [0, 65, True, "64"])
def test_publication_concurrency_validation(publication, value):
    pool, args, settings, store = publication
    args.publish_workers = value
    with pytest.raises(ValueError, match="publish_workers"):
        asyncio.run(pool.run_pool(args, settings))
