"""Inspect/apply one-day retention ONLY to the isolated news speech prefix.

Defaults to dry-run. Native API supports the existing global old-version rule.
Manage lifecycle through this native tool, not S3, to avoid rule-ID churn.
B2 hides after one day, then deletes hidden versions after another day.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "src"))

import httpx
from app.core.config import Settings
from environment import load_environment

NEWS_PREFIX = "audio/speech/v1/news/"
NEWS_RULE = {"fileNamePrefix": NEWS_PREFIX, "daysFromUploadingToHiding": 1,
             "daysFromHidingToDeleting": 1}


def merge_rules(existing: list[dict]) -> list[dict]:
    retained, matched = [], False
    for rule in existing:
        prefix = rule.get("fileNamePrefix")
        if not isinstance(prefix, str):
            raise ValueError("Unrecognized native lifecycle rule")
        if prefix == NEWS_PREFIX:
            if matched:
                raise ValueError("Duplicate news rules; manual review required")
            matched = True
            retained.append({**copy.deepcopy(rule), **NEWS_RULE})
            continue
        if NEWS_PREFIX.startswith(prefix) or prefix.startswith(NEWS_PREFIX):
            # Native B2 merges matching rules by the minimum non-null value.
            # Only inherit old-version cleanup, never a broader upload expiration.
            if rule.get("daysFromUploadingToHiding") is not None:
                raise ValueError("Existing upload expiration overlaps news; manual review required")
        retained.append(copy.deepcopy(rule))
    return retained if matched else retained + [copy.deepcopy(NEWS_RULE)]


class NativeB2:
    def __init__(self, settings: Settings):
        self.client = httpx.Client(timeout=30, follow_redirects=False)
        response = self.client.get("https://api.backblazeb2.com/b2api/v4/b2_authorize_account",
                                   auth=(settings.speech_s3_key_id, settings.speech_s3_application_key))
        response.raise_for_status()
        auth = response.json()
        storage = auth["apiInfo"]["storageApi"]
        self.api = storage["apiUrl"]
        if not self.api.startswith("https://") or not httpx.URL(self.api).host.endswith(".backblazeb2.com"):
            raise ValueError("Unexpected B2 API endpoint")
        self.account = auth["accountId"]
        self.token = auth["authorizationToken"]
        self.capabilities = storage["allowed"]["capabilities"]
        self.bucket_name = settings.speech_s3_bucket

    def call(self, operation: str, body: dict) -> dict:
        response = self.client.post(f"{self.api}/b2api/v4/{operation}",
                                    headers={"Authorization": self.token}, json=body)
        response.raise_for_status()
        return response.json()

    def read_bucket(self) -> dict:
        buckets = self.call("b2_list_buckets", {"accountId": self.account,
                                                "bucketName": self.bucket_name})["buckets"]
        if len(buckets) != 1 or buckets[0]["bucketName"] != self.bucket_name:
            raise ValueError("Configured bucket could not be uniquely resolved")
        return buckets[0]

    def apply(self, before: dict, proposed: list[dict]) -> dict:
        if "writeBuckets" not in self.capabilities:
            raise PermissionError("Configured key lacks writeBuckets; no settings changed")
        self.call("b2_update_bucket", {"accountId": self.account, "bucketId": before["bucketId"],
                                      "ifRevisionIs": before["revision"], "lifecycleRules": proposed})
        after = self.read_bucket()
        # No public policy, CORS, encryption, replication or other fields are sent.
        for key in before.keys() - {"revision", "lifecycleRules"}:
            if before[key] != after.get(key):
                raise RuntimeError(f"Unrelated bucket property changed: {key}; inspect before retrying")
        if merge_rules(after["lifecycleRules"]) != after["lifecycleRules"]:
            raise RuntimeError("News retention verification failed; inspect before retrying")
        unrelated = lambda rules: [r for r in rules if r["fileNamePrefix"] != NEWS_PREFIX]
        if unrelated(before["lifecycleRules"]) != unrelated(after["lifecycleRules"]):
            raise RuntimeError("Unrelated lifecycle rule changed; inspect before retrying")
        return after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--use-rclone", action="store_true")
    args = parser.parse_args()
    load_environment(ROOT, use_rclone=args.use_rclone)
    store = NativeB2(Settings.from_env())
    before = store.read_bucket()
    proposed = merge_rules(before["lifecycleRules"])
    print(json.dumps({"bucket": store.bucket_name, "prefix": NEWS_PREFIX, "revision": before["revision"],
                      "existing": before["lifecycleRules"], "proposed": proposed, "apply": args.apply,
                      "canWriteBuckets": "writeBuckets" in store.capabilities}, ensure_ascii=False))
    if not args.apply:
        return
    if proposed == before["lifecycleRules"]:
        print("Already configured; no changes")
        return
    after = store.apply(before, proposed)
    print(json.dumps({"verifiedRules": after["lifecycleRules"], "revision": after["revision"],
                      "unrelatedSettingsUnchanged": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
