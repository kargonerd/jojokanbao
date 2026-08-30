from __future__ import annotations

import argparse
import base64
import json
import os
import time
from http.client import RemoteDisconnected
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


AUTHORIZE_URL = (
    "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fail unless a Backblaze B2 bucket is private."
    )
    parser.add_argument(
        "--bucket",
        default=os.environ.get("B2_ARCHIVE_BUCKET"),
    )
    return parser.parse_args()


_TRANSIENT_HTTP_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def request_json(request: Request, *, attempts: int = 4) -> dict:
    """Read a B2 API response, retrying only transient network failures."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as exc:
            # Bad credentials and missing permissions are deterministic; do
            # not hide them behind retries. B2 gateway/rate-limit responses
            # can be transient and are safe to retry.
            if exc.code not in _TRANSIENT_HTTP_STATUS:
                raise
            last_error = exc
        except (RemoteDisconnected, ConnectionResetError, TimeoutError, URLError) as exc:
            last_error = exc
        if attempt + 1 < attempts:
            time.sleep(min(8.0, 2.0**attempt))
    assert last_error is not None
    raise last_error


def bucket_type(
    *,
    application_key_id: str,
    application_key: str,
    bucket_name: str,
) -> str:
    basic = base64.b64encode(
        f"{application_key_id}:{application_key}".encode("utf-8")
    ).decode("ascii")
    authorization = request_json(
        Request(
            AUTHORIZE_URL,
            headers={"Authorization": f"Basic {basic}"},
        )
    )
    storage_api = authorization["apiInfo"]["storageApi"]
    body = json.dumps(
        {
            "accountId": authorization["accountId"],
            "bucketName": bucket_name,
        }
    ).encode("utf-8")
    listing = request_json(
        Request(
            f"{storage_api['apiUrl']}/b2api/v4/b2_list_buckets",
            data=body,
            headers={
                "Authorization": authorization["authorizationToken"],
                "Content-Type": "application/json",
            },
            method="POST",
        )
    )
    buckets = listing.get("buckets", [])
    if len(buckets) != 1 or buckets[0].get("bucketName") != bucket_name:
        raise RuntimeError(f"B2 bucket was not found: {bucket_name}")
    return str(buckets[0].get("bucketType") or "")


def main() -> int:
    args = parse_args()
    application_key_id = os.environ.get("B2_ARCHIVE_KEY_ID", "")
    application_key = os.environ.get("B2_ARCHIVE_APPLICATION_KEY", "")
    if not application_key_id or not application_key or not args.bucket:
        raise SystemExit(
            "B2_ARCHIVE_KEY_ID, B2_ARCHIVE_APPLICATION_KEY, and "
            "B2_ARCHIVE_BUCKET are required"
        )
    actual_type = bucket_type(
        application_key_id=application_key_id,
        application_key=application_key,
        bucket_name=args.bucket,
    )
    print(
        json.dumps(
            {"bucket": args.bucket, "bucketType": actual_type},
            ensure_ascii=False,
        )
    )
    if actual_type != "allPrivate":
        raise SystemExit(
            f"Refusing to upload a private research archive to a {actual_type!r} bucket"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
