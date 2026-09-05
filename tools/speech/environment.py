"""Local tools only: reuse checkout env and existing rclone S3 configuration.

Cloud functions use explicit environment variables and never invoke rclone.
Credentials are loaded in memory, never printed or written to another .env.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from dotenv import load_dotenv


def load_environment(root: Path, *, use_rclone: bool = False) -> None:
    try:
        common = subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                         cwd=root, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).strip()
        primary = Path(common).parent
    except (OSError, subprocess.CalledProcessError):
        primary = root
    for directory in dict.fromkeys((root, primary)):
        for filename in (".env.local", ".env"):
            load_dotenv(directory / filename, override=False)
    if not use_rclone:
        return
    os.environ["JOJO_SPEECH_STORAGE"] = "b2"
    if os.getenv("JOJO_SPEECH_S3_KEY_ID"):
        return
    remote, separator, bucket = os.getenv("JOJO_DELIVERY_REMOTE", "jojo-b2-s3:jojo-newspaper").partition(":")
    if not separator or not bucket or "/" in bucket:
        raise RuntimeError("Delivery remote must identify one bucket")
    try:
        result = subprocess.run(["rclone", "config", "dump"], capture_output=True, text=True,
                                encoding="utf-8", timeout=15, check=True,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        config = json.loads(result.stdout)[remote]
    except (OSError, subprocess.SubprocessError, KeyError, ValueError) as error:
        raise RuntimeError("Cannot load the configured rclone delivery remote") from error
    if config.get("type") != "s3" or not all(config.get(key) for key in ("endpoint", "access_key_id", "secret_access_key")):
        raise RuntimeError("Delivery remote must have explicit S3 credentials")
    endpoint = config["endpoint"]
    if not endpoint.startswith("https://"):
        endpoint = f"https://{endpoint}"
    for key, value in {
        "JOJO_SPEECH_STORAGE": "b2", "JOJO_SPEECH_S3_ENDPOINT": endpoint,
        "JOJO_SPEECH_S3_REGION": config.get("region") or endpoint.split("s3.")[-1].split(".")[0],
        "JOJO_SPEECH_S3_BUCKET": bucket,
        "JOJO_SPEECH_S3_KEY_ID": config["access_key_id"],
        "JOJO_SPEECH_S3_APPLICATION_KEY": config["secret_access_key"],
    }.items():
        if not os.getenv(key):
            os.environ[key] = value
