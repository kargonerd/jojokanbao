from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str = 'jojo-press-engine'
    export_root: Path = Path(__file__).resolve().parents[1] / 'exports'
