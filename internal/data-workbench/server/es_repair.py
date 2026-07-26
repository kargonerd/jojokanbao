"""Append-only Elasticsearch repair helpers for Tencent ES Serverless."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parents[3]


def _load_root_env() -> None:
    """Load missing values from the repo .env without adding a dependency."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value[:1] == value[-1:] and value[:1] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def repair_config() -> dict[str, Any]:
    _load_root_env()
    url = os.getenv("KIBANA_URL", "").rstrip("/")
    return {
        "kibana_url": url,
        "username": os.getenv("ELASTICSEARCH_USERNAME", ""),
        "password": os.getenv("ELASTICSEARCH_PASSWORD", ""),
        "index": os.getenv("ES_REPAIR_INDEX", "aitest-1tk2lxru"),
        "space_id": os.getenv("KIBANA_SPACE_ID") or _space_id_from_url(url),
        # Tencent's public Kibana :5601 endpoint currently closes some verified
        # TLS handshakes. This is a localhost-only operator tool; opt back in
        # with ES_VERIFY_TLS=true when the endpoint supports it.
        "verify_tls": os.getenv("ES_VERIFY_TLS", "false").lower() not in {"0", "false", "no"},
    }


def _space_id_from_url(url: str) -> str:
    host = url.split("://", 1)[-1].split(".", 1)[0]
    return host if host.startswith("space-") else ""


def revision_id(replaced_document_id: str, document: dict[str, Any], deleted: bool) -> str:
    # Keep the legacy canonical key so existing append-only IDs remain stable.
    canonical = json.dumps(
        {
            "supersedesId": replaced_document_id,
            "deleted": deleted,
            "document": document,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "repair-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:40]


def active_query(query: dict[str, Any], excluded_ids: set[str]) -> dict[str, Any]:
    """Wrap a query with the exclusions recorded by applied migrations."""
    wrapped: dict[str, Any] = {"must": [query]}
    if excluded_ids:
        wrapped["must_not"] = [{"ids": {"values": sorted(excluded_ids)}}]
    return {"bool": wrapped}


class KibanaConsoleClient:
    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or repair_config()
        missing = [
            key for key in ("kibana_url", "username", "password", "index", "space_id")
            if not self.config.get(key)
        ]
        if missing:
            raise ValueError("缺少 ES 配置：" + ", ".join(missing))
        self.session = requests.Session()
        self.session.verify = bool(self.config["verify_tls"])
        if not self.session.verify:
            requests.packages.urllib3.disable_warnings(
                requests.packages.urllib3.exceptions.InsecureRequestWarning
            )
        self._logged_in = False

    def login(self) -> None:
        response = self.session.post(
            f"{self.config['kibana_url']}/internal/security/login",
            headers={"kbn-xsrf": "true", "Content-Type": "application/json"},
            json={
                "providerType": "basic",
                "providerName": "basic",
                "currentURL": "/login",
                "params": {
                    "username": self.config["username"],
                    "password": self.config["password"],
                },
            },
            timeout=20,
        )
        response.raise_for_status()
        self._logged_in = True

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
        if not self._logged_in:
            self.login()
        proxy = (
            f"{self.config['kibana_url']}/s/{self.config['space_id']}/api/console/proxy"
            f"?path={quote(path, safe='')}&method={quote(method.upper())}"
        )
        response = self.session.post(
            proxy,
            headers={"kbn-xsrf": "true", "Content-Type": "application/json"},
            data=json.dumps(body, ensure_ascii=False) if body is not None else None,
            timeout=30,
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {"message": response.text}
        return response.status_code, payload

    def search(self, body: dict[str, Any]) -> dict[str, Any]:
        status, payload = self.request("POST", f"{self.config['index']}/_search", body)
        if status >= 400:
            raise RuntimeError(_error_message(payload))
        return payload

    def search_active(self, text: str, size: int = 20) -> dict[str, Any]:
        from es_migrations import excluded_document_ids

        query = (
            {"multi_match": {
                "query": text,
                "fields": ["title^3", "content", "source"],
                "operator": "and",
            }}
            if text.strip() else {"match_all": {}}
        )
        payload = self.search({
            "size": max(1, min(size, 100)),
            "query": active_query(
                query,
                excluded_document_ids(self.config["index"]),
            ),
            "sort": [{"date": {"order": "desc", "unmapped_type": "date"}}],
        })
        hits = payload.get("hits", {})
        return {
            "total": hits.get("total", {}).get("value", 0),
            "items": [
                {**hit.get("_source", {}), "documentId": hit["_id"], "score": hit.get("_score")}
                for hit in hits.get("hits", [])
            ],
        }

    def create_revision(
        self,
        replaced_document_id: str,
        document: dict[str, Any],
        *,
        deleted: bool = False,
    ) -> dict[str, Any]:
        clean = {
            key: document.get(key)
            for key in ("title", "content", "date", "page", "source")
            if document.get(key) not in (None, "")
        }
        now = datetime.now(timezone.utc).isoformat()
        revision = {
            **clean,
            "@timestamp": now,
            "replacedDocumentId": replaced_document_id,
        }
        # Exclude timestamps so retrying the same migration is idempotent.
        doc_id = revision_id(replaced_document_id, clean, deleted)
        status, payload = self.request(
            "POST", f"{self.config['index']}/_create/{quote(doc_id, safe='')}", revision
        )
        if status == 409:
            return {"created": False, "alreadyExists": True, "documentId": doc_id}
        if status >= 400:
            raise RuntimeError(_error_message(payload))
        return {"created": True, "alreadyExists": False, "documentId": doc_id}


def _error_message(payload: Any) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return error.get("reason") or error.get("type") or json.dumps(error, ensure_ascii=False)
        return str(error or payload.get("message") or payload)
    return str(payload)
