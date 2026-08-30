import io
import json
import sys
import unittest
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from search_state import CosSearchState, SearchStateUnavailable, parse_search_state  # noqa: E402


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


class FakeBody(io.BytesIO):
    def get_raw_stream(self):
        return self


class FakeCosClient:
    def __init__(self, excluded_ids=None):
        self.etag = "state-1"
        self.excluded_ids = excluded_ids or []
        self.head_calls = 0
        self.get_calls = 0
        self.error = None

    def head_object(self, **kwargs):
        self.head_calls += 1
        if self.error:
            raise self.error
        return {"ETag": f'"{self.etag}"'}

    def get_object(self, **kwargs):
        self.get_calls += 1
        if self.error:
            raise self.error
        raw = json.dumps({"excludedIds": {"news": self.excluded_ids}}).encode("utf-8")
        return {"Body": FakeBody(raw), "ETag": f'"{self.etag}"'}


class SearchStateTests(unittest.TestCase):
    def test_plain_json_contract_deduplicates_ids(self):
        self.assertEqual(
            parse_search_state('{"excludedIds":{"news":["old-2","old-1","old-1",""]}}'),
            {"news": frozenset({"old-1", "old-2"})},
        )

    def test_disabled_state_never_contacts_cos(self):
        client = FakeCosClient(["old-1"])
        state = CosSearchState(client=client)
        self.assertEqual(state.excluded_ids("news"), frozenset())
        self.assertEqual(client.head_calls, 0)

    def test_cache_uses_etag_and_downloads_only_when_changed(self):
        clock = Clock()
        client = FakeCosClient(["old-1"])
        state = CosSearchState(
            bucket="private-123",
            region="ap-beijing",
            cache_seconds=60,
            client=client,
            clock=clock,
        )

        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1"}))
        self.assertEqual((client.head_calls, client.get_calls), (1, 1))
        clock.value = 30
        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1"}))
        self.assertEqual((client.head_calls, client.get_calls), (1, 1))
        clock.value = 61
        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1"}))
        self.assertEqual((client.head_calls, client.get_calls), (2, 1))

        client.etag = "state-2"
        client.excluded_ids = ["old-1", "old-2"]
        clock.value = 122
        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1", "old-2"}))
        self.assertEqual((client.head_calls, client.get_calls), (3, 2))

    def test_refresh_failure_keeps_last_good_state(self):
        clock = Clock()
        client = FakeCosClient(["old-1"])
        state = CosSearchState(
            bucket="private-123",
            region="ap-beijing",
            cache_seconds=60,
            client=client,
            clock=clock,
        )
        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1"}))
        client.error = RuntimeError("COS unavailable")
        clock.value = 61
        self.assertEqual(state.excluded_ids("news"), frozenset({"old-1"}))

    def test_first_load_failure_is_not_silently_ignored(self):
        client = FakeCosClient()
        client.error = RuntimeError("denied")
        state = CosSearchState(
            bucket="private-123",
            region="ap-beijing",
            client=client,
        )
        with self.assertRaises(SearchStateUnavailable):
            state.excluded_ids("news")


if __name__ == "__main__":
    unittest.main()
