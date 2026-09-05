"""Deployment repair is narrow, version-preserving, and never writes outside the bundle."""
import importlib.util
from pathlib import Path
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("python_bundle_repair", ROOT / "infrastructure/edgeone/repair-python-bundle.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def test_version_is_read_from_built_distribution_not_current_environment(tmp_path):
    metadata = tmp_path / "botocore-1.43.89.dist-info/METADATA"
    metadata.parent.mkdir()
    metadata.write_text("Name: botocore\nVersion: 1.43.89\n", encoding="utf-8")
    assert repair.installed_version(tmp_path, "botocore") == "1.43.89"
    metadata.write_text("Name: wrong-package\nVersion: 1.43.89\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Invalid bundled"):
        repair.installed_version(tmp_path, "botocore")


def test_missing_or_ambiguous_distribution_fails_before_download(tmp_path):
    with pytest.raises(ValueError, match="Expected one"):
        repair.installed_version(tmp_path, "boto3")
    for version in ("1.0.0", "2.0.0"):
        metadata = tmp_path / f"boto3-{version}.dist-info/METADATA"
        metadata.parent.mkdir()
        metadata.write_text(f"Name: boto3\nVersion: {version}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Expected one"):
        repair.installed_version(tmp_path, "boto3")


def test_only_runtime_docs_are_restored(tmp_path):
    bundle = tmp_path / "bundle"
    wheel = tmp_path / "fixture.whl"
    with ZipFile(wheel, "w") as archive:
        archive.writestr("botocore/docs/__init__.py", '"""Runtime documentation helpers."""')
        archive.writestr("botocore/docs/docstring.py", "restored = True")
        archive.writestr("botocore/client.py", "must_not_replace_client = True")
        archive.writestr("unrelated.py", "must_not_copy = True")
    assert repair.restore_runtime_docs(bundle, wheel, "botocore") == 2
    assert (bundle / "botocore/docs/docstring.py").read_text() == "restored = True"
    assert not (bundle / "botocore/client.py").exists()
    assert not (bundle / "unrelated.py").exists()


def test_traversal_and_unapproved_packages_are_rejected(tmp_path):
    wheel = tmp_path / "fixture.whl"
    with ZipFile(wheel, "w") as archive:
        archive.writestr("botocore/docs/../../outside.py", "unexpected = True")
    with pytest.raises(ValueError, match="Invalid wheel"):
        repair.restore_runtime_docs(tmp_path / "bundle", wheel, "botocore")
    assert not (tmp_path / "bundle/outside.py").exists()
    with pytest.raises(ValueError, match="Only the two"):
        repair.restore_runtime_docs(tmp_path / "bundle", wheel, "unrelated")


def test_incomplete_wheel_is_rejected(tmp_path):
    wheel = tmp_path / "fixture.whl"
    with ZipFile(wheel, "w") as archive:
        archive.writestr("boto3/docs/__init__.py", "")
    with pytest.raises(ValueError, match="does not contain"):
        repair.restore_runtime_docs(tmp_path / "bundle", wheel, "boto3")


def test_generated_stdlib_exception_does_not_allow_site_packages(tmp_path, monkeypatch):
    verifier_spec = importlib.util.spec_from_file_location("python_bundle_verifier", ROOT / "infrastructure/edgeone/verify-python-bundle.py")
    verifier = importlib.util.module_from_spec(verifier_spec)
    verifier_spec.loader.exec_module(verifier)
    name = "_sysconfigdata__linux_x86_64-linux-gnu"
    monkeypatch.setattr(verifier.sysconfig, "_get_sysconfigdata_name", lambda: name, raising=False)
    monkeypatch.setattr(verifier.sysconfig, "get_path", lambda _: str(tmp_path))
    assert verifier.is_generated_stdlib(name, str(tmp_path / f"{name}.py"))
    assert not verifier.is_generated_stdlib("unrelated", str(tmp_path / "unrelated.py"))
    assert not verifier.is_generated_stdlib(name, str(tmp_path / "site-packages" / f"{name}.py"))
    assert not verifier.is_generated_stdlib(name, str(tmp_path.parent / f"{name}.py"))
