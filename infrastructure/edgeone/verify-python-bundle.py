#!/usr/bin/env python3
"""Offline acceptance of an already-built EdgeOne Python 3.10 function.

Run with Python 3.10 and --bundle .edgeone/web-deploy/.edgeone/cloud-functions/api-python.
The verifier re-executes with -I -S: dependencies must come from the artifact,
not the checkout, PYTHONPATH, user site, or the interpreter's site-packages.
"""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import replace
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import wave


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def is_generated_stdlib(name: str, origin: str) -> bool:
    # CPython's Linux build configuration is standard library code, but is not
    # listed in stdlib_module_names. Allow only this exact name and directory,
    # not arbitrary modules under lib/python (which also contains site-packages).
    getter = getattr(sysconfig, "_get_sysconfigdata_name", None)
    return bool(getter and name == getter()
                and Path(origin).resolve().parent == Path(sysconfig.get_path("stdlib")).resolve())


def offline_environment() -> dict[str, str]:
    # Retain only OS plumbing needed by Windows/Python; no credentials/proxies.
    environment = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
    if sys.platform == "linux":
        # actions/setup-python may need libpython from its own installation.
        environment["LD_LIBRARY_PATH"] = str(Path(sys.base_prefix) / "lib")
    return {**environment, "JOJO_ENV": "test", "JOJO_TTS_ENABLED": "false", "JOJO_SPEECH_STORAGE": "local"}


def deny_external_network(event, args) -> None:
    if event == "socket.connect":
        address = args[1]
        # Windows asyncio may use a loopback socket pair for its wakeup pipe.
        if isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
            return
        raise RuntimeError("Bundle verification attempted an external connection")
    if event == "socket.getaddrinfo" and args[0] not in {"127.0.0.1", "::1", None}:
        raise RuntimeError("Bundle verification attempted external DNS")


def verify(bundle: Path) -> None:
    require(sys.version_info[:2] == (3, 10), "Run this verifier with Python 3.10, matching the deployed native wheels")
    require((bundle / "app.py").is_file(), "Missing generated bundle app.py")
    for package in ("botocore", "boto3"):
        require((bundle / package / "docs" / "__init__.py").is_file(),
                f"Missing runtime package {package}.docs: the EdgeOne cleanup removed required code")

    environment = offline_environment()
    os.environ.clear()
    os.environ.update(environment)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(bundle))
    sys.addaudithook(deny_external_network)

    # Import explicitly: deleted docs must fail even if the scanner swallows an
    # application import error and silently falls back to its Flask 404 handler.
    for name in ("botocore.docs", "boto3.docs", "lameenc", "mutagen", "uvicorn"):
        module = importlib.import_module(name)
        require(Path(module.__file__).resolve().is_relative_to(bundle), f"{name} was imported outside the bundle")

    spec = importlib.util.spec_from_file_location("_verified_edgeone_runtime", bundle / "app.py")
    require(spec is not None and spec.loader is not None, "Cannot load generated EdgeOne runtime")
    runtime = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime
    spec.loader.exec_module(runtime)
    has_asgi, _, route_types, applications = runtime._scan_for_asgi_routes()
    require(has_asgi and len(applications) == 1 and set(route_types) == {"/api"},
            "Generated runtime did not discover exactly the /api ASGI application")
    mount, application, _ = applications[0]
    wrapped = runtime.ASGIPathStripMiddleware(application, mount)

    import httpx

    async def check_routes():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wrapped), base_url="http://offline.invalid") as client:
            for path in ("/v1/health", "/v1/speech/providers"):
                response = await client.get("/api" + path)
                require(response.status_code == 200, f"{path} returned {response.status_code}, expected 200")
                require(response.headers.get("content-type", "").startswith("application/json"), f"{path} is not JSON")
                body = response.json()
                if path.endswith("health"):
                    require(body.get("status") == "ok", "Health payload is invalid")
                else:
                    require({item["id"] for item in body["providers"]} == {"edge", "mimo"}, "Provider catalog is incomplete")
                    require(all(not item["canGenerate"] for item in body["providers"]), "Offline synthesis must be disabled")
            response = await client.get("/api/v1/times")
            require(response.status_code == 404, "JOJO Times must not be exposed by the production bundle")

    asyncio.run(check_routes())

    from app.core.config import Settings
    from app.speech.encoding import encode_delivery
    from app.speech.providers import AudioResult
    from app.speech.storage import B2SpeechStore
    from botocore.stub import Stubber

    # Create a real bundled boto client/service model, but intercept every S3
    # operation before HTTP. Explicit dummy credentials never touch live B2.
    settings = replace(Settings.from_env(), speech_storage="b2", speech_s3_endpoint="https://b2.invalid",
                       speech_s3_bucket="offline-bundle-check", speech_s3_key_id="offline",
                       speech_s3_application_key="offline")
    store = B2SpeechStore(settings)
    try:
        require(store.client.meta.service_model.service_name == "s3", "S3 service model is missing")
        require(bool(str(store.client.get_object.__doc__)), "S3 runtime model documentation is unavailable")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(b"\0\0" * 24000)
        audio = encode_delivery(AudioResult(output.getvalue(), "audio/wav", "wav"))
        require(1 <= audio.duration < 1.2 and 0 < len(audio.data) < len(output.getvalue()), "WAV to MP3 encoding failed")
        with Stubber(store.client) as stub:
            stub.add_response("put_object", {})
            stub.add_response("put_object", {})
            record = store.put("mimo", "a" * 64, audio)
            require(record["mediaType"] == "audio/mpeg" and record["bytes"] == len(audio.data), "B2 audio descriptor is invalid")
            stub.assert_no_pending_responses()
    finally:
        store.client.close()

    # Guard against any late path injection by dependencies or generated code.
    for name, module in tuple(sys.modules.items()):
        if module is sys.modules["__main__"] or name.split(".")[0] in sys.stdlib_module_names:
            continue
        origin = getattr(module, "__file__", None)
        if origin:
            require(Path(origin).resolve().is_relative_to(bundle) or is_generated_stdlib(name, origin),
                    f"Runtime dependency {name} escaped the bundle")
    print(json.dumps({"status": "ok", "python": "3.10", "routes": "health/providers 200 JSON; times 404",
                      "b2": "offline client/model/docs/PUT verified", "mp3Bytes": len(audio.data)}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    if not (sys.flags.isolated and sys.flags.no_site):
        return subprocess.call([sys.executable, "-I", "-S", "-X", "utf8", str(Path(__file__).resolve()),
                                "--bundle", str(bundle)], env=offline_environment())
    try:
        verify(bundle)
    except Exception as error:
        print(f"Bundle verification failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
