from functools import lru_cache
from pathlib import Path
import os

from pydantic import BaseModel


class Settings(BaseModel):
    db_path: Path = Path(
        os.getenv(
            "TIMES_DB_PATH",
            Path(__file__).resolve().parents[3] / ".runtime" / "times" / "times.sqlite3",
        )
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
