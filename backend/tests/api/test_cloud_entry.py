from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import shutil
import subprocess

from fastapi.testclient import TestClient
import pytest

from app.application import create_app
from app.main import app as local_app


ROOT = Path(__file__).resolve().parents[3]
ENTRY = ROOT / "infrastructure/edgeone/functions/api/index.py"
# EdgeOne CLI 1.6.14 hasFunctionEntryPoint/detectPythonHttpMethods use this pattern.
FRAMEWORK_ENTRY = re.compile(r"^(?:app|application)\s*(?::\s*\S+\s*)?=\s*", re.MULTILINE)


def load_cloud_app():
    spec = importlib.util.spec_from_file_location("jojo_cloud_api_entry", ENTRY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.app


def test_cloud_entry_is_discoverable_and_uses_the_same_api():
    assert FRAMEWORK_ENTRY.search(ENTRY.read_text(encoding="utf-8"))
    cloud_app = load_cloud_app()
    assert cloud_app is not local_app
    assert {route.path for route in cloud_app.routes} == {route.path for route in local_app.routes}
    assert [middleware.cls for middleware in cloud_app.user_middleware] == [middleware.cls for middleware in local_app.user_middleware]
    assert cloud_app.exception_handlers.keys() == local_app.exception_handlers.keys()
    with TestClient(cloud_app) as client:
        for endpoint in ("/v1/health", "/v1/speech/providers"):
            response = client.get(endpoint)
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("application/json")
        assert client.get("/v1/times").status_code == 404


def test_shared_factory_has_no_extra_platform_entry():
    first, second = create_app(), create_app()
    assert first is not second
    candidates = [
        file.relative_to(ROOT / "backend/src/app").as_posix()
        for file in (ROOT / "backend/src/app").rglob("*.py")
        if FRAMEWORK_ENTRY.search(file.read_text(encoding="utf-8"))
    ]
    assert candidates == ["main.py"]


def test_assembly_excludes_local_entry_and_keeps_cloud_factory(tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the deployment assembly test")
    # Exercise the actual assembler against a minimal local fixture, without a
    # Web build, cloud access, credentials, or any optional business modules.
    files = [
        "infrastructure/edgeone/prepare-web-deploy.mjs",
        "infrastructure/edgeone/edgeone.json",
        "infrastructure/edgeone/functions/api/index.py",
        "infrastructure/edgeone/functions/reader-gateway/[[default]].ts",
        "infrastructure/edgeone/web-middleware.ts",
        "backend/src/app/main.py",
        "backend/src/app/application.py",
        "backend/requirements.txt",
    ]
    for relative in files:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    web_index = tmp_path / "frontend/web/dist/index.html"
    web_index.parent.mkdir(parents=True)
    web_index.write_text("<!doctype html><title>test</title>", encoding="utf-8")
    subprocess.run([node, str(tmp_path / files[0])], check=True, capture_output=True, text=True)
    output = tmp_path / ".edgeone/web-deploy/cloud-functions"
    assert not (output / "app/main.py").exists()
    assert (output / "app/application.py").is_file()
    entries = [file.relative_to(output).as_posix() for file in output.rglob("*.py")
               if FRAMEWORK_ENTRY.search(file.read_text(encoding="utf-8"))]
    assert entries == ["api/index.py"]
