from __future__ import annotations

from times_pipeline.jox import decode_jox_json, encode_jox_json, transform_jox_bytes


def test_jox_transform_matches_frontend_known_vector() -> None:
    encoded = transform_jox_bytes(b"JOJO Times", "content/newspapers/times/latest.jox")

    assert encoded.hex() == "ea59c9352b962599ac24"
    assert transform_jox_bytes(encoded, "content/newspapers/times/latest.jox") == b"JOJO Times"


def test_jox_json_round_trip_is_compatible_with_gzip_transport() -> None:
    payload = {"formatVersion": "jojo-times-latest/1", "title": "今日时事"}
    encoded, descriptor = encode_jox_json(payload, "content/newspapers/times/latest.jox")

    assert decode_jox_json(encoded, "content/newspapers/times/latest.jox") == payload
    assert descriptor["size"] > 0
    assert len(str(descriptor["sha256"])) == 64
