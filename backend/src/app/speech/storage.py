"""Public B2 delivery. Metadata is a commit marker, audio is immutable by hash.

No bucket creation, policies, ACL changes, deletions, user IDs or plaintext.
Only a real 404 is a cache miss; permission/network failures never trigger TTS.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from ..core.config import Settings
from .encoding import EncodedAudio

PREFIX = "audio/speech/v1"
IMMUTABLE = "public, max-age=31536000, immutable"


NEWS_TTL_SECONDS = 86400


def segment_base(provider: str, key: str, scope: str = "book") -> str:
    if scope not in {"book", "news"}:
        raise ValueError("Invalid speech scope")
    if provider not in {"edge", "mimo", "auto"} or not re.fullmatch(r"[0-9a-f]{64}", key):
        raise ValueError("Invalid speech object identity")
    return f"{PREFIX}/{'news/' if scope == 'news' else ''}segments/{provider}/{key[:2]}/{key}"


class B2SpeechStore:
    def __init__(self, settings: Settings, client=None, *, scope: str = "book"):
        if scope not in {"book", "news"}:
            raise ValueError("Invalid speech scope")
        self.scope = scope
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
        base = segment_base(provider, key, self.scope)
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
        if provider == "auto":
            if record.get("provider") not in {"mimo", "edge"}:
                raise ValueError("Invalid speech source provider")
            base = segment_base(record["provider"], record.get("sourceKey", ""), self.scope)
        if (record.get("formatVersion") != "jojo-speech-segment/1" or record.get("key") != key
                or not re.fullmatch(re.escape(base) + r"/[0-9a-f]{64}\.mp3", obj)
                or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 600
                or not isinstance(record.get("bytes"), int) or record["bytes"] <= 0):
            raise ValueError("Invalid speech descriptor")
        if self.scope == "news":
            expires = record.get("expiresAt")
            if not isinstance(expires, (int, float)) or not math.isfinite(expires):
                raise ValueError("Invalid news expiration")
            if expires <= time.time():
                return None
        return {**record, "url": self.url(obj)}

    def put(self, provider: str, key: str, audio: EncodedAudio) -> dict:
        base = segment_base(provider, key, self.scope)
        digest = hashlib.sha256(audio.data).hexdigest()
        obj = f"{base}/{digest}.mp3"
        record = {"formatVersion": "jojo-speech-segment/1", "key": key,
                  "object": obj, "mediaType": "audio/mpeg", "duration": audio.duration,
                  "bytes": len(audio.data), "sha256": digest}
        if self.scope == "news":
            record["expiresAt"] = time.time() + NEWS_TTL_SECONDS
        self.client.put_object(Bucket=self.bucket, Key=obj, Body=audio.data,
                               ContentType="audio/mpeg", CacheControl="public, max-age=3600" if self.scope == "news" else IMMUTABLE)
        # Published last. Racing first writers may duplicate synthesis, but each
        # descriptor always references its own immutable, complete MP3.
        self.put_json(f"{base}.json", record, immutable=True)
        return {**record, "url": self.url(obj)}

    def alias(self, key: str, voice: str, provider: str, record: dict) -> dict:
        # Reuse the original immutable MP3. A logical choice only adds metadata;
        # existing pre-generated MiMo audio is neither copied nor synthesized again.
        value = {**record, "key": key, "sourceKey": record["key"],
                 "provider": provider, "voice": voice}
        value.pop("url", None)
        self.put_json(f"{segment_base('auto', key, self.scope)}.json", value, immutable=True)
        return {**value, "url": self.url(value["object"])}

    def put_json(self, key: str, value: dict, *, immutable: bool = False) -> None:
        if not key.startswith(f"{PREFIX}/") or ".." in key.split("/") or "\\" in key:
            raise ValueError("Writes must remain inside the speech prefix")
        self.client.put_object(Bucket=self.bucket, Key=key,
                               Body=json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(),
                               ContentType="application/json; charset=utf-8",
                               CacheControl=IMMUTABLE if immutable and self.scope != "news" else "public, max-age=60")
