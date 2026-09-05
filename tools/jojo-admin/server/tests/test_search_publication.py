import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from search_publication import (
    AppendOnlySearchPublisher,
    DesiredSearchDocument,
    activate_search_publication,
)


def document(content="new"):
    return {
        "@timestamp": "2026-01-01T00:00:00Z",
        "type": "newspaper",
        "datasetId": "rmrb",
        "itemId": "rmrb:1950-01-01",
        "title": "标题",
        "content": content,
        "date": "1950-01-01",
        "source": "人民日报",
        "metadata": {"page": 1, "ordinal": 2},
    }


class FakeClient:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def request(self, method, path, body=None):
        if path.endswith("/_search"):
            ids = body["query"]["ids"]["values"]
            return 200, {"hits": {"hits": [
                {"_id": value, "_source": self.values[value]}
                for value in ids if value in self.values
            ]}}
        marker = "/_create/"
        if marker in path:
            identifier = path.split(marker, 1)[1]
            if identifier in self.values:
                return 409, {"error": "exists"}
            self.values[identifier] = body
            return 201, {"result": "created"}
        raise AssertionError((method, path, body))


class SearchPublicationTest(unittest.TestCase):
    def test_changed_document_creates_revision_then_activates_it(self):
        client = FakeClient({"base": document("old")})
        state = {"excludedIds": {"search": []}}
        publication = AppendOnlySearchPublisher(client, "search", state).publish(
            [DesiredSearchDocument("base", document("new"))],
            scope="newspaper:rmrb",
            canonical_revision="hf-2",
        )
        replacement = publication["activation"]["heads"]["base"]
        self.assertTrue(replacement.startswith("repair-"))
        self.assertIn(replacement, client.values)

        activated = activate_search_publication(state, publication)
        self.assertEqual(activated["heads"]["search"]["base"], replacement)
        self.assertEqual(activated["excludedIds"]["search"], ["base"])
        self.assertEqual(
            activated["canonicalRevisions"]["search"]["newspaper:rmrb"],
            "hf-2",
        )

    def test_new_document_uses_base_id_and_retry_is_unchanged(self):
        client = FakeClient()
        state = {"excludedIds": {"search": []}}
        desired = [DesiredSearchDocument("base", document())]
        first = AppendOnlySearchPublisher(client, "search", state).publish(
            desired, scope="newspaper:rmrb", canonical_revision="hf-1"
        )
        second = AppendOnlySearchPublisher(client, "search", state).publish(
            desired, scope="newspaper:rmrb", canonical_revision="hf-1"
        )
        self.assertEqual(first["created"], 1)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["unchanged"], 1)

    def test_delete_never_removes_es_and_only_excludes_active_head(self):
        client = FakeClient({"revision": document()})
        state = {
            "excludedIds": {"search": ["base"]},
            "heads": {"search": {"base": "revision"}},
        }
        publication = AppendOnlySearchPublisher(client, "search", state).publish(
            [DesiredSearchDocument("base", None)],
            scope="newspaper:rmrb",
            canonical_revision="hf-3",
        )
        activated = activate_search_publication(state, publication)
        self.assertIsNone(activated["heads"]["search"]["base"])
        self.assertEqual(activated["excludedIds"]["search"], ["base", "revision"])

    def test_v1_remote_state_can_bootstrap_an_audited_local_head(self):
        publication = {
            "index": "search",
            "scope": "newspaper:rmrb",
            "canonicalRevision": "hf-4",
            "activation": {
                "expectedHeads": {"base": "repair-old"},
                "heads": {"base": "repair-new"},
                "excludedIds": ["repair-old"],
            },
        }
        activated = activate_search_publication(
            {"excludedIds": {"search": ["base"]}},
            publication,
        )
        self.assertEqual(activated["heads"]["search"]["base"], "repair-new")
        self.assertEqual(
            activated["excludedIds"]["search"],
            ["base", "repair-old"],
        )


if __name__ == "__main__":
    unittest.main()
