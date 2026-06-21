from functools import lru_cache
from pathlib import Path
import os

from pydantic import BaseModel


class Settings(BaseModel):
    host: str = os.getenv("JIUWEN_API_HOST", "127.0.0.1")
    port: int = int(os.getenv("JIUWEN_API_PORT", "3001"))
    db_path: Path = Path(os.getenv("JIUWEN_DB_PATH", Path(__file__).resolve().parents[1] / "data" / "jiuwen.sqlite3"))
    cors_origins: list[str] = ["*"]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
