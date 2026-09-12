import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from contextlib import asynccontextmanager

from botocore.config import Config
from app.core.config import Settings
from app.speech.encoding import EncodedAudio


def setup(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[3] / "tools" / "speech"))
    import library_pool
    return library_pool


def test_outbox_survives_restart_and_reclaims_only_confirmed_audio(monkeypatch, tmp_path):
    setup(monkeypatch)
    from outbox import AudioOutbox
    audio = EncodedAudio(b"persisted-mp3", 3)
    path = tmp_path / "outbox.sqlite3"
    box = AudioOutbox(path, max_bytes=100, reserve_bytes=0)
    box.stage("a" * 64, "白桦", audio)
    assert box.snapshot()["pending"] == 1
    assert box.pending_keys() == {"a" * 64}
    assert not box.has_room(100)
    box.close()
    box = AudioOutbox(path)
    assert box.lookup("a" * 64) == ("pending", None)
    assert box.load("a" * 64) == audio
    record = {"key": "a" * 64, "sha256": hashlib.sha256(audio.data).hexdigest()}
    box.confirm("a" * 64, record)
    assert box.snapshot()["pendingBytes"] == 0
    assert not box.pending_keys()
    box.close()
    box = AudioOutbox(path)
    assert box.lookup("a" * 64) == ("uploaded", record)
    assert box.db.execute("SELECT data FROM audio").fetchone()[0] is None
    box.close()


def test_upload_outage_does_not_hold_synthesis_and_restart_never_resynthesizes(monkeypatch, tmp_path):
    pool = setup(monkeypatch)
    from outbox import AudioOutbox
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"formatVersion": "jojo-speech-plan/1", "books": [{
        "datasetId": "book", "itemKey": "full-book", "title": "Book", "chapters": [
            {"id": "chapter:1", "segments": ["a", "b", "c"]}]}]}), encoding="utf-8")
    output = tmp_path / "run"
    args = SimpleNamespace(plan=plan, output=output, rpm=80, start_concurrency=2, max_concurrency=2, accounts=1)
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1,
                        speech_storage="b2", mimo_api_key="test")
    client = Mock()
    client.meta.config = Config()
    objects, prepared, commits, manifests = {}, [], [], []
    outage = True
    publication_failures = [True]
    def put(provider, key, audio):
        if outage:
            raise OSError("simulated storage outage")
        objects[key] = {"key": key, "object": f"audio/{key}", "bytes": len(audio.data),
                        "duration": audio.duration, "sha256": hashlib.sha256(audio.data).hexdigest()}
        commits.append(key)
        # Simulate upload committed, but response lost. Retry must find it.
        raise OSError("simulated lost acknowledgment")
    def put_json(key, value, **kwargs):
        if publication_failures:
            publication_failures.pop()
            raise OSError("temporary manifest failure")
        if "segments" in value:
            assert all(e["key"] in objects for e in value["segments"])
            manifests.append(value)
    store = SimpleNamespace(client=client, get=lambda provider, key: objects.get(key), put=put, put_json=put_json)
    monkeypatch.setattr(pool.batch, "speech_store", lambda _: store)
    monkeypatch.setattr(pool.boto3, "client", lambda *a, **kw: client)
    @asynccontextmanager
    async def provider(*args, **kwargs):
        yield
    monkeypatch.setattr(pool, "offline_provider", provider)
    async def prepare(task, settings):
        prepared.append(task["key"])
        return EncodedAudio(task["text"].encode(), 1)
    monkeypatch.setattr(pool, "prepare_audio", prepare)
    async def first_run():
        task = asyncio.create_task(pool.run_pool(args, settings))
        try:
            for _ in range(500):
                if len(prepared) == 6:
                    break
                await asyncio.sleep(.02)
            # All 6 syntheses finish despite only 2 synthesis slots and a
            # permanently unavailable uploader. Old inline design cannot do so.
            assert len(prepared) == 6
        finally:
            (output / "STOP").write_text("test pause")
            await asyncio.wait_for(task, 15)
    asyncio.run(first_run())
    summary = json.loads((output / "summary.json").read_text())
    assert summary["status"] == "paused" and summary["staged"] == 6
    assert summary["generated"] == 0 and not summary["failures"]
    assert not manifests
    box = AudioOutbox(output / "outbox.sqlite3")
    assert box.snapshot()["pending"] == 6
    box.close()
    outage = False
    (output / "STOP").unlink()
    asyncio.run(pool.run_pool(args, settings))
    assert len(prepared) == 6
    assert len(commits) == len(set(commits)) == 6
    assert len(manifests) == 2
    summary = json.loads((output / "summary.json").read_text())
    assert summary["status"] == "complete" and summary["outbox"]["pending"] == 0
    assert all(r["segmentsComplete"] == 3 for r in summary["totals"].values())


def test_resume_uploads_durable_audio_before_blocked_earlier_cache_lookups(monkeypatch, tmp_path):
    pool = setup(monkeypatch)
    from outbox import AudioOutbox
    plan = {"formatVersion": "jojo-speech-plan/1", "books": [{"datasetId": "book", "itemKey": "full-book",
            "title": "Book", "chapters": [{"id": "chapter:1", "segments": ["first", "last"]}]}]}
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(plan))
    _, tasks = pool.jobs_for_plan(plan, {"complete": {}})
    target = tasks[-1]
    output = tmp_path / "run"
    box = AudioOutbox(output / "outbox.sqlite3")
    box.stage(target["key"], target["voice"], EncodedAudio(b"already synthesized", 1))
    box.close()
    objects = {}
    client = Mock()
    client.meta.config = Config()
    def get(provider, key):
        if key != target["key"]:
            raise OSError("Earlier plan cache lookup temporarily unavailable")
        return objects.get(key)
    def put(provider, key, audio):
        objects[key] = {"key": key, "bytes": len(audio.data), "duration": 1,
                        "sha256": hashlib.sha256(audio.data).hexdigest(), "object": f"audio/{key}"}
    store = SimpleNamespace(client=client, get=get, put=put, put_json=Mock())
    monkeypatch.setattr(pool.batch, "speech_store", lambda _: store)
    monkeypatch.setattr(pool.boto3, "client", lambda *a, **kw: client)
    @asynccontextmanager
    async def provider(*args, **kwargs):
        yield
    monkeypatch.setattr(pool, "offline_provider", provider)
    async def prepare(*args):
        raise AssertionError("No new synthesis during this test")
    monkeypatch.setattr(pool, "prepare_audio", prepare)
    settings = Settings(environment="test", allowed_origins=(), supabase_url=None,
                        supabase_publishable_key=None, auth_timeout_seconds=1,
                        speech_storage="b2", mimo_api_key="test")
    args = SimpleNamespace(plan=plan_path, output=output, accounts=1, rpm=80, start_concurrency=2,
                           max_concurrency=2, upload_workers=64)
    async def run():
        job = asyncio.create_task(pool.run_pool(args, settings))
        try:
            for _ in range(500):
                if target["key"] in objects:
                    break
                await asyncio.sleep(.02)
            assert target["key"] in objects
        finally:
            (output / "STOP").write_text("test pause")
            await asyncio.wait_for(job, 15)
    asyncio.run(run())
    box = AudioOutbox(output / "outbox.sqlite3")
    assert box.lookup(target["key"])[0] == "uploaded"
    assert box.snapshot()["pending"] == 0
    box.close()
