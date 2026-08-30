import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile
import subprocess


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
        self.assertEqual(run.call_args.kwargs["timeout"], 60)

    def test_run_reports_command_timeout(self):
        with patch.object(
            deploy.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["tccli"], 5),
        ):
            with self.assertRaisesRegex(RuntimeError, "命令超时.*tccli"):
                deploy._run(["tccli"], timeout=5)

    def test_verify_function_access_reads_target_before_upload(self):
        with patch.object(
            deploy,
            "_json_command",
            return_value={"Status": "Active"},
        ) as command:
            deploy._verify_function_access(
                "flask_jojo_search_staging",
                region="ap-beijing",
                namespace="default",
                profile="",
            )

        self.assertIn("GetFunction", command.call_args.args[0])
        self.assertIn("flask_jojo_search_staging", command.call_args.args[0])

    def test_verify_function_access_rejects_failed_target(self):
        with patch.object(
            deploy,
            "_json_command",
            return_value={"Status": "Failed", "StatusDesc": "denied"},
        ):
            with self.assertRaisesRegex(RuntimeError, "denied"):
                deploy._verify_function_access(
                    "flask_jojo_search_staging",
                    region="ap-beijing",
                    namespace="default",
                    profile="",
                )

    def test_upload_uses_cos_sdk_with_environment_credentials(self):
        client = MagicMock()
        with patch.object(deploy, "_cos_client", return_value=client):
            deploy._upload(
                Path("search.zip"),
                bucket="jojo-search-1314955862",
                region="ap-beijing",
                key="runtime/scf-builds/search.zip",
                profile="",
            )

        client.upload_file.assert_called_once_with(
            Bucket="jojo-search-1314955862",
            Key="runtime/scf-builds/search.zip",
            LocalFilePath="search.zip",
            PartSize=1,
            MAXThread=5,
        )

    def test_delete_uses_cos_sdk_with_environment_credentials(self):
        client = MagicMock()
        with patch.object(deploy, "_cos_client", return_value=client):
            deploy._delete_upload(
                bucket="jojo-search-1314955862",
                region="ap-beijing",
                key="runtime/scf-builds/search.zip",
                profile="",
            )

        client.delete_object.assert_called_once_with(
            Bucket="jojo-search-1314955862",
            Key="runtime/scf-builds/search.zip",
        )

    def test_update_function_submits_inline_zip_with_environment_credentials(self):
        client = MagicMock()
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "search.zip"
            package.write_bytes(b"zip-content")
            with (
                patch.object(deploy, "_scf_client", return_value=client),
                patch.object(deploy, "_wait_for_function") as wait,
            ):
                deploy._update_function(
                    "flask_jojo_search_staging",
                    package=package,
                    bucket="jojo-search-1314955862",
                    region="ap-beijing",
                    namespace="default",
                    key="unused.zip",
                    profile="",
                )

        request = client.UpdateFunctionCode.call_args.args[0]
        payload = json.loads(request.to_json_string())
        self.assertEqual(payload["CodeSource"], "ZipFile")
        self.assertEqual(payload["FunctionName"], "flask_jojo_search_staging")
        self.assertEqual(
            deploy.base64.b64decode(payload["ZipFile"]),
            b"zip-content",
        )
        wait.assert_called_once()


if __name__ == "__main__":
    unittest.main()
