"""Public B2 delivery. Metadata is a commit marker, audio is immutable by hash.

No bucket creation, policies, ACL changes, deletions, user IDs or plaintext.
Only a real 404 is a cache miss; permission/network failures never trigger TTS.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from ..core.config import Settings
from .encoding import EncodedAudio

PREFIX = "audio/speech/v1"
IMMUTABLE = "public, max-age=31536000, immutable"


def segment_base(provider: str, key: str) -> str:
    if provider not in {"edge", "mimo"} or not re.fullmatch(r"[0-9a-f]{64}", key):
        raise ValueError("Invalid speech object identity")
    return f"{PREFIX}/segments/{provider}/{key[:2]}/{key}"


class B2SpeechStore:
    def __init__(self, settings: Settings, client=None):
        if not all((settings.speech_s3_endpoint, settings.speech_s3_bucket,
                    settings.speech_s3_key_id, settings.speech_s3_application_key)):
            raise RuntimeError("B2 speech storage is not configured")
        self.bucket = settings.speech_s3_bucket
        self.cdn = settings.speech_cdn_base.rstrip("/")
        self.client = client or boto3.client(
            "s3", endpoint_url=settings.speech_s3_endpoint,
            region_name=settings.speech_s3_region,
            aws_access_key_id=settings.speech_s3_key_id,
            aws_secret_access_key=settings.speech_s3_application_key,
            config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=10,
                          retries={"total_max_attempts": 2, "mode": "standard"},
                          s3={"addressing_style": "path"},
                          request_checksum_calculation="when_required",
                          response_checksum_validation="when_required"),
        )

    def url(self, key: str) -> str:
        return f"{self.cdn}/{quote(key, safe='/')}"

    def get(self, provider: str, key: str) -> dict | None:
        base = segment_base(provider, key)
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=f"{base}.json")
        except ClientError as error:
            if (error.response["ResponseMetadata"]["HTTPStatusCode"] == 404
                    and error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}):
                return None
            raise
        body = response["Body"]
        try:
            raw = body.read(8193)
        finally:
            body.close()
        if len(raw) > 8192:
            raise ValueError("Oversized speech descriptor")
        record = json.loads(raw)
        obj = record.get("object", "")
        duration = record.get("duration", 0)
        if (record.get("formatVersion") != "jojo-speech-segment/1" or record.get("key") != key
                or not re.fullmatch(re.escape(base) + r"/[0-9a-f]{64}\.mp3", obj)
                or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 600
                or not isinstance(record.get("bytes"), int) or record["bytes"] <= 0):
            raise ValueError("Invalid speech descriptor")
        return {**record, "url": self.url(obj)}

    def put(self, provider: str, key: str, audio: EncodedAudio) -> dict:
        base = segment_base(provider, key)
        digest = hashlib.sha256(audio.data).hexdigest()
        obj = f"{base}/{digest}.mp3"
        record = {"formatVersion": "jojo-speech-segment/1", "key": key,
                  "object": obj, "mediaType": "audio/mpeg", "duration": audio.duration,
                  "bytes": len(audio.data), "sha256": digest}
        self.client.put_object(Bucket=self.bucket, Key=obj, Body=audio.data,
                               ContentType="audio/mpeg", CacheControl=IMMUTABLE)
        # Published last. Racing first writers may duplicate synthesis, but each
        # descriptor always references its own immutable, complete MP3.
        self.put_json(f"{base}.json", record, immutable=True)
        return {**record, "url": self.url(obj)}

    def put_json(self, key: str, value: dict, *, immutable: bool = False) -> None:
        if not key.startswith(f"{PREFIX}/") or ".." in key.split("/") or "\\" in key:
            raise ValueError("Writes must remain inside the speech prefix")
        self.client.put_object(Bucket=self.bucket, Key=key,
                               Body=json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(),
                               ContentType="application/json; charset=utf-8",
                               CacheControl=IMMUTABLE if immutable else "public, max-age=60")
