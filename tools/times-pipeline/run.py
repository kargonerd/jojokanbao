from __future__ import annotations

from pathlib import Path
import sys


TOOL_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_ROOT))

from times_pipeline.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
