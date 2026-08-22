from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any


JOX_SALT = 0x4A4F5831


def _u32(value: int) -> int:
    return value & 0xFFFFFFFF


def _imul(left: int, right: int) -> int:
    return _u32(_u32(left) * _u32(right))


def _fnv1a(value: str) -> int:
    digest = 0x811C9DC5
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = _imul(digest, 0x01000193)
    return _u32(digest)


def normalize_object_key(value: str) -> str:
    return value.replace("\\", "/").lstrip("/")


def _mask_byte(position: int, object_seed: int) -> int:
    value = _u32(_u32(position) + 0x9E3779B9) ^ object_seed ^ JOX_SALT
    value = _u32(value ^ (value >> 16))
    value = _imul(value, 0x7FEB352D)
    value = _u32(value ^ (value >> 15))
    value = _imul(value, 0x846CA68B)
    value = _u32(value ^ (value >> 16))
    return value & 0xFF


def transform_jox_bytes(data: bytes, object_key: str, offset: int = 0) -> bytes:
    seed = _fnv1a(normalize_object_key(object_key))
    return bytes(byte ^ _mask_byte(offset + index, seed) for index, byte in enumerate(data))


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def encode_jox_json(value: Any, object_key: str) -> tuple[bytes, dict[str, int | str]]:
    clear = json_bytes(value)
    compressed = gzip.compress(clear, compresslevel=9, mtime=0)
    return transform_jox_bytes(compressed, object_key), {
        "size": len(clear),
        "sha256": hashlib.sha256(clear).hexdigest(),
    }


def decode_jox_json(data: bytes, object_key: str) -> Any:
    compressed = transform_jox_bytes(data, object_key)
    return json.loads(gzip.decompress(compressed))


def write_jox_json(root: Path, object_key: str, value: Any) -> dict[str, int | str]:
    encoded, descriptor = encode_jox_json(value, object_key)
    target = root.joinpath(*normalize_object_key(object_key).split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)
    return descriptor


def read_jox_json(path: Path, object_key: str) -> Any:
    return decode_jox_json(path.read_bytes(), object_key)
