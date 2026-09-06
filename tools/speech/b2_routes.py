"""Offline-only B2 clients, one verified HTTPS tunnel per local proxy listener."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from urllib.parse import urlsplit

import boto3
from botocore.config import Config

from app.speech.storage import B2SpeechStore


def make_store(settings, proxy):
    address = urlsplit(proxy)
    if (address.scheme != "http" or address.hostname != "127.0.0.1"
            or address.username or address.password or not address.port
            or address.path or address.query or address.fragment):
        raise ValueError("Only explicit loopback HTTP CONNECT proxies are supported")
    if not settings.speech_s3_endpoint.startswith("https://"):
        raise ValueError("B2 must use HTTPS with certificate verification")
    client = boto3.client("s3", endpoint_url=settings.speech_s3_endpoint, region_name=settings.speech_s3_region,
                          aws_access_key_id=settings.speech_s3_key_id,
                          aws_secret_access_key=settings.speech_s3_application_key,
                          config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=30,
                                        max_pool_connections=16, proxies={"https": proxy},
                                        retries={"total_max_attempts": 2, "mode": "standard"},
                                        s3={"addressing_style": "path"},
                                        request_checksum_calculation="when_required",
                                        response_checksum_validation="when_required"))
    return B2SpeechStore(settings, client=client)


class RoutesUnavailable(OSError):
    pass


class B2Routes:
    """Least-busy routing; failed endpoints cool down, retries can use another.

    An upload attempt (lookup/MP3/descriptor/verify) stays on one client. Retried
    attempts use the durable local MP3; this class never invokes a TTS provider.
    """
    def __init__(self, routes, *, capacity=16):
        if not routes or capacity < 1:
            raise ValueError("At least one B2 route is required")
        self.routes = [{"id": name, "store": store, "active": 0, "successes": 0, "failures": 0,
                        "consecutiveFailures": 0, "cooldownUntil": 0, "uploadBytes": 0,
                        "uploaded": 0, "lastUsed": 0} for name, store in routes]
        self.lock = threading.Lock()
        self.capacity, self.sequence = capacity, 0

    @classmethod
    def load(cls, path, settings):
        rows = json.loads(path.read_text(encoding="utf-8"))["routes"]
        if not 2 <= len(rows) <= 16:
            raise ValueError("Select between 2 and 16 verified B2 routes")
        if (len({r["proxy"] for r in rows}) != len(rows) or len({r["id"] for r in rows}) != len(rows)
                or any(not re.fullmatch(r"node-\d{3}", r["id"]) for r in rows)):
            raise ValueError("B2 routes must be distinct and use opaque node IDs")
        stores = []
        try:
            for row in rows:
                stores.append((row["id"], make_store(settings, row["proxy"])))
            return cls(stores)
        except BaseException:
            for _, store in stores:
                store.client.close()
            raise

    def call(self, operation, *args, **kwargs):
        with self.lock:
            now = time.monotonic()
            available = [r for r in self.routes if r["active"] < self.capacity and r["cooldownUntil"] <= now]
            if not available:
                raise RoutesUnavailable("All B2 routes are busy or cooling down; staged audio retained")
            route = min(available, key=lambda r: (r["active"], r["lastUsed"]))
            self.sequence += 1
            route["lastUsed"], route["active"] = self.sequence, route["active"] + 1
        try:
            store = route["store"]
            if operation == "upload":
                key, audio = args
                record = store.get("mimo", key)
                if record is None:
                    store.put("mimo", key, audio)
                    record = store.get("mimo", key)
                    if (not record or record.get("sha256") != hashlib.sha256(audio.data).hexdigest()
                            or record.get("bytes") != len(audio.data)):
                        raise ValueError("B2 commit verification failed; staged audio retained")
                result = record
            else:
                result = getattr(store, operation)(*args, **kwargs)
        except BaseException as error:
            with self.lock:
                route["failures"] += 1
                route["consecutiveFailures"] += 1
                route["cooldownUntil"] = time.monotonic() + min(60, 2 ** min(route["consecutiveFailures"] + 1, 6))
                route["lastError"] = type(error).__name__
                route["lastErrorAt"] = time.time()
            raise
        else:
            with self.lock:
                route["successes"] += 1
                route["consecutiveFailures"] = 0
                route["lastSuccessAt"] = time.time()
                if operation == "upload":
                    route["uploaded"] += 1
                    route["uploadBytes"] += result["bytes"]
            return result
        finally:
            with self.lock:
                route["active"] -= 1

    def get(self, *args, **kwargs):
        return self.call("get", *args, **kwargs)

    def put_json(self, *args, **kwargs):
        return self.call("put_json", *args, **kwargs)

    def upload_and_verify(self, key, audio):
        return self.call("upload", key, audio)

    def snapshot(self):
        with self.lock:
            return [{**{k: v for k, v in r.items() if k not in {"store", "lastUsed", "cooldownUntil"}},
                     "cooldownSeconds": max(0, round(r["cooldownUntil"] - time.monotonic()))} for r in self.routes]

    def close(self):
        for route in self.routes:
            route["store"].client.close()
