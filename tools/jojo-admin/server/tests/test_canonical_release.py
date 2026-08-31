import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from canonical_release import (
    CanonicalRelease,
    MirroredReleaseJournal,
    ReleaseJournal,
    RELEASE_STAGES,
    release_id,
)


class CanonicalReleaseTest(unittest.TestCase):
    def test_runs_in_fixed_order_and_resumes_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.json"
            calls = []
            fail_once = {"delivery": True}

            def handler(name):
                def run(_state):
                    calls.append(name)
                    if fail_once.get(name):
                        fail_once[name] = False
                        raise RuntimeError("temporary")
                    return {"stage": name}
                return run

            desired = {"items": {"one": "digest"}}
            identifier = release_id(desired)
            release = CanonicalRelease(
                ReleaseJournal(path),
                {name: handler(name) for name in RELEASE_STAGES},
            )
            with self.assertRaisesRegex(RuntimeError, "temporary"):
                release.run(identifier=identifier, scope="newspaper:rmrb", desired=desired)
            state = release.run(identifier=identifier, scope="newspaper:rmrb", desired=desired)

            self.assertEqual(
                calls,
                ["canonical", "delivery", "delivery", "search", "activation"],
            )
            self.assertEqual(state["status"], "succeeded")
            self.assertEqual(state["stages"]["canonical"]["attempts"], 1)
            self.assertEqual(state["stages"]["delivery"]["attempts"], 2)

    def test_release_id_is_independent_of_mapping_order(self):
        self.assertEqual(release_id({"a": 1, "b": 2}), release_id({"b": 2, "a": 1}))

    def test_remote_receipt_is_cached_locally_and_mirrored_on_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "remote.json"
            remote = {
                "formatVersion": "jojo-canonical-release/1",
                "releaseId": "release-existing",
                "status": "failed",
            }
            uploaded = []
            journal = MirroredReleaseJournal(
                path,
                remote_loader=lambda: remote,
                remote_saver=lambda value: uploaded.append(dict(value)),
            )
            self.assertEqual(journal.load(), remote)
            self.assertTrue(path.is_file())
            journal.save({**remote, "status": "running"})
            self.assertEqual(uploaded[-1]["status"], "running")


if __name__ == "__main__":
    unittest.main()
