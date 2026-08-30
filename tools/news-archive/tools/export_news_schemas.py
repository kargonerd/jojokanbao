from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from jojo_olds_api.news_models import JojoArticle, RawCapture


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export stable JSON Schemas for JOJO news archive records."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=SERVICE_ROOT / "schemas",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    models = {
        "jojo-raw-capture-v1.schema.json": RawCapture,
        "jojo-article-v1.schema.json": JojoArticle,
    }
    for filename, model in models.items():
        destination = args.output_dir / filename
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(
            json.dumps(
                model.model_json_schema(by_alias=True),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary.replace(destination)
        print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
