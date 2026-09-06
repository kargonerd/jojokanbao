import asyncio
import importlib.util
from pathlib import Path

import pytest

from app.speech import delivery, storage
from app.speech.encoding import encode_delivery
from app.speech.providers import PROVIDERS
from app.speech.storage import B2SpeechStore, segment_base
from test_speech_delivery import MemoryS3, configured, wav_audio


def test_news_expiration_isolated_from_books_and_alias_does_not_extend_it(monkeypatch):
    now = 1000000
    monkeypatch.setattr(storage.time, "time", lambda: now)
    s3 = MemoryS3()
    book = B2SpeechStore(configured(), s3)
    news = B2SpeechStore(configured(), s3, scope="news")
    key, logical = "a" * 64, "b" * 64
    audio = encode_delivery(wav_audio())
    original = book.put("mimo", key, audio)
    record = news.put("mimo", key, audio)
    assert record["object"] != original["object"]
    assert record["expiresAt"] == now + 86400
    now += 3600
    alias = news.alias(logical, "male", "mimo", record)
    assert alias["expiresAt"] == record["expiresAt"]
    assert news.get("auto", logical) == alias
    assert s3.writes[-1]["CacheControl"] == "public, max-age=60"
    now += 82800
    assert news.get("mimo", key) is None
    assert news.get("auto", logical) is None
    assert book.get("mimo", key) == original
    assert segment_base("mimo", key) == f"audio/speech/v1/segments/mimo/aa/{key}"


def test_news_expiry_regenerates_but_book_stays_cached(monkeypatch):
    now = 1000000
    monkeypatch.setattr(storage.time, "time", lambda: now)
    s3, settings = MemoryS3(), configured()
    monkeypatch.setattr(delivery, "speech_store", lambda _: B2SpeechStore(settings, s3))
    monkeypatch.setattr(delivery, "news_speech_store", lambda _: B2SpeechStore(settings, s3, scope="news"))
    calls = 0

    async def synthesize(*args):
        nonlocal calls
        calls += 1
        await asyncio.sleep(.01)
        return wav_audio()

    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", synthesize)

    async def scenario():
        nonlocal now
        await delivery.resolve_speech("auto", "male", "相同正文", settings)
        results = await asyncio.gather(*(delivery.resolve_speech("auto", "male", "相同正文", settings, scope="news") for _ in range(2)))
        assert calls == 2
        assert results[0][0]["url"] == results[1][0]["url"]
        now += 86400
        assert (await delivery.resolve_speech("auto", "male", "相同正文", settings))[1] == "hit"
        assert (await delivery.resolve_speech("auto", "male", "相同正文", settings, scope="news"))[1] == "miss"
        assert calls == 3

    asyncio.run(scenario())


def test_news_local_cache_has_its_own_short_ttl(tmp_path, monkeypatch):
    from dataclasses import replace

    settings = replace(configured(), speech_storage="local", speech_cache_path=str(tmp_path / "audio.db"))

    async def synthesize(*args):
        return wav_audio()

    monkeypatch.setattr(PROVIDERS["mimo"], "synthesize", synthesize)
    asyncio.run(delivery.resolve_speech("mimo", "白桦", "本地新闻", settings, scope="news"))
    assert (tmp_path / "audio.db.news").exists()
    assert not (tmp_path / "audio.db").exists()
    assert delivery.speech_cache(str(tmp_path / "audio.db.news"), 86400).ttl_seconds == 86400


def test_lifecycle_preserves_global_old_version_rule_and_only_changes_news(monkeypatch):
    folder = Path(__file__).resolve().parents[3] / "tools" / "speech"
    monkeypatch.syspath_prepend(str(folder))
    spec = importlib.util.spec_from_file_location("news_lifecycle_test", folder / "news_lifecycle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original = [{"fileNamePrefix": "", "daysFromUploadingToHiding": None,
                 "daysFromHidingToDeleting": 1, "daysFromStartingToCancelingUnfinishedLargeFiles": None}]
    merged = module.merge_rules(original)
    assert merged[0] == original[0]
    assert len(original) == 1 and len(merged) == 2
    assert merged[1] == module.NEWS_RULE
    assert module.merge_rules(merged) == merged
    with pytest.raises(ValueError, match="overlaps"):
        module.merge_rules([{"fileNamePrefix": "", "daysFromUploadingToHiding": 1}])

    before = {"bucketId": "test", "revision": 3, "bucketType": "allPublic", "corsRules": [], "lifecycleRules": original}
    after = {**before, "revision": 4, "lifecycleRules": merged}
    client = module.NativeB2.__new__(module.NativeB2)
    client.account, client.capabilities = "test-account", ["writeBuckets"]
    calls = []
    client.call = lambda operation, body: calls.append((operation, body))
    client.read_bucket = lambda: after
    assert client.apply(before, merged) == after
    assert calls == [("b2_update_bucket", {"accountId": "test-account", "bucketId": "test",
                                          "ifRevisionIs": 3, "lifecycleRules": merged})]
    client.capabilities = []
    with pytest.raises(PermissionError):
        client.apply(before, merged)
    assert len(calls) == 1
