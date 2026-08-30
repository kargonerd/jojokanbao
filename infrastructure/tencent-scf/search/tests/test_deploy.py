import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

import deploy  # noqa: E402


class DeployPackageTests(unittest.TestCase):
    def test_build_contains_only_runtime_files_at_zip_root(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            source.mkdir()
            for name in deploy.RUNTIME_FILES:
                content = "#!/bin/bash\r\nrun\r\n" if name == "scf_bootstrap" else name
                (source / name).write_text(content, encoding="utf-8")
            output = Path(temp) / "search.zip"
            result = deploy.build_package(output, source=source, install_dependencies=False)

            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                bootstrap = archive.read("scf_bootstrap")
                build = json.loads(archive.read("build_info.json"))

            self.assertEqual(names, {*deploy.RUNTIME_FILES, "build_info.json"})
            self.assertNotIn(b"\r", bootstrap)
            self.assertEqual(build["sourceFingerprint"], result["sourceFingerprint"])
            self.assertEqual(result["sha256"], deploy.hashlib.sha256(output.read_bytes()).hexdigest())

    def test_source_fingerprint_changes_with_runtime_source(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            for name in deploy.RUNTIME_FILES:
                (source / name).write_text(name, encoding="utf-8")
            before = deploy.source_fingerprint(source)
            (source / "app.py").write_text("changed", encoding="utf-8")
            self.assertNotEqual(before, deploy.source_fingerprint(source))

    def test_python39_check_rejects_eager_union_annotations(self):
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp)
            (package / "bad.py").write_text(
                'def convert(value: str | bytes) -> str:\n    return str(value)\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "X \\| Y"):
                deploy._verify_python39(package)

            (package / "bad.py").write_text(
                'from __future__ import annotations\n'
                'def convert(value: str | bytes) -> str:\n    return str(value)\n',
                encoding="utf-8",
            )
            deploy._verify_python39(package)

    def test_json_command_forces_machine_readable_tccli_output(self):
        with patch.object(deploy, "_run", return_value='{"Response":{"Status":"Active"}}') as run:
            result = deploy._json_command(["tccli", "scf", "GetFunction"])

        self.assertEqual(result, {"Status": "Active"})
        self.assertEqual(
            run.call_args.args[0],
            ["tccli", "scf", "GetFunction", "--output", "json"],
        )


if __name__ == "__main__":
    unittest.main()
