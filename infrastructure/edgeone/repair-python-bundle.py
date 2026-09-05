"""Restore runtime modules incorrectly pruned as documentation by CLI 1.6.14.

Run after `makers build`, before verifying/uploading the prebuilt .edgeone.
Only boto3/docs and botocore/docs are copied from their exact installed wheels.
No dependency upgrades, runtime import hooks, or application-code changes.
"""
from __future__ import annotations

import argparse
from email.parser import Parser
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

PACKAGES = ("boto3", "botocore")


def installed_version(bundle: Path, name: str) -> str:
    metadata = list(bundle.glob(f"{name}-*.dist-info/METADATA"))
    if len(metadata) != 1:
        raise ValueError(f"Expected one installed {name} distribution in the bundle")
    values = Parser().parsestr(metadata[0].read_text(encoding="utf-8"))
    version = values.get("Version", "")
    if values.get("Name") != name or not re.fullmatch(r"\d+(?:\.\d+){1,3}", version):
        raise ValueError(f"Invalid bundled {name} metadata")
    return version


def restore_runtime_docs(bundle: Path, wheel: Path, name: str) -> int:
    if name not in PACKAGES:
        raise ValueError("Only the two affected SDK runtime packages may be restored")
    count = 0
    with ZipFile(wheel) as archive:
        for member in archive.infolist():
            if not member.filename.startswith(f"{name}/docs/") or member.is_dir():
                continue
            relative = PurePosixPath(member.filename)
            if relative.is_absolute() or ".." in relative.parts or "\\" in member.filename:
                raise ValueError("Invalid wheel member path")
            target = bundle.joinpath(*relative.parts)
            if (not target.resolve().is_relative_to(bundle.resolve())
                    or not target.resolve().is_relative_to((bundle / name / "docs").resolve())):
                raise ValueError("Wheel member leaves runtime docs directory")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            count += 1
    if not count or not (bundle / name / "docs" / "docstring.py").is_file():
        raise ValueError(f"Wheel does not contain {name}.docs runtime modules")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    bundle = parser.parse_args().bundle.resolve()
    if bundle.name != "api-python" or bundle.parent.name != "cloud-functions" or not (bundle / "app.py").is_file():
        raise ValueError("Expected a generated cloud-functions/api-python bundle")
    versions = {name: installed_version(bundle, name) for name in PACKAGES}
    with TemporaryDirectory(prefix="jojo-python-wheels-") as temporary:
        wheels = Path(temporary)
        subprocess.run([sys.executable, "-m", "pip", "--isolated", "download", "--disable-pip-version-check",
                        "--index-url", "https://pypi.org/simple",
                        "--only-binary=:all:", "--no-deps", "--dest", str(wheels),
                        *(f"{name}=={version}" for name, version in versions.items())], check=True)
        for name, version in versions.items():
            candidates = list(wheels.glob(f"{name}-{version}-*.whl"))
            if len(candidates) != 1:
                raise ValueError(f"Expected exactly one {name} wheel")
            count = restore_runtime_docs(bundle, candidates[0], name)
            print(f"Restored {name}.docs ({version}, {count} runtime files)")


if __name__ == "__main__":
    main()
