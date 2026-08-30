from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.news_models import RawCapture
from jojo_olds_api.news_parser import parse_article


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay a stored raw capture through a versioned JOJO parser."
    )
    parser.add_argument("--capture-record", type=Path, required=True)
    parser.add_argument(
        "--archive-root",
        type=Path,
        help="Directory containing objects/ and records/ (defaults to record root).",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    capture = RawCapture.model_validate_json(
        args.capture_record.read_text(encoding="utf-8")
    )
    archive_root = args.archive_root or _infer_archive_root(args.capture_record)
    raw_path = archive_root / capture.raw_html.path
    if not raw_path.is_file():
        raise SystemExit(f"raw HTML object not found: {raw_path}")
    if capture.raw_html.content_encoding == "gzip":
        with gzip.open(raw_path, "rb") as handle:
            raw_html = handle.read()
    else:
        raw_html = raw_path.read_bytes()
    digest = hashlib.sha256(raw_html).hexdigest()
    if digest != capture.raw_html.sha256:
        raise SystemExit(
            f"raw HTML checksum mismatch: expected {capture.raw_html.sha256}, got {digest}"
        )
    article = parse_article(
        raw_html,
        publisher=capture.publisher,
        canonical_url=capture.canonical_url,
        raw_capture=capture,
        dependent_resources=_read_dependent_resources(
            capture,
            archive_root=archive_root,
        ),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(
        article.model_dump_json(
            by_alias=True,
            exclude_none=True,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    temporary.replace(args.output)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "publisher": article.publisher,
                "articleId": article.article_id,
                "status": article.quality.status,
                "bodyCharacters": article.quality.body_characters,
                "imagesSelected": article.quality.images_selected,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _read_dependent_resources(
    capture: RawCapture,
    *,
    archive_root: Path,
) -> dict[str, bytes]:
    resources: dict[str, bytes] = {}
    for resource in capture.dependent_resources:
        path = archive_root / resource.blob.path
        if resource.blob.content_encoding == "gzip":
            with gzip.open(path, "rb") as handle:
                content = handle.read()
        else:
            content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != resource.blob.sha256:
            raise SystemExit(
                "dependent resource checksum mismatch: "
                f"expected {resource.blob.sha256}, got {digest}"
            )
        resources[resource.source_url] = content
    return resources


def _infer_archive_root(record_path: Path) -> Path:
    resolved = record_path.resolve()
    for parent in resolved.parents:
        if parent.name == "records":
            return parent.parent
    raise SystemExit(
        "--archive-root is required when the capture record is not below records/"
    )


if __name__ == "__main__":
    raise SystemExit(main())
