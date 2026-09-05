"""Local API launcher; resolve .env from this checkout or its primary Git checkout."""
from pathlib import Path
import subprocess

from dotenv import load_dotenv
import uvicorn


def environment_directory(root: Path) -> Path:
    if any((root / name).is_file() for name in (".env", ".env.local")):
        return root
    try:
        common = subprocess.check_output(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=root, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).strip()
        return Path(common).parent
    except (OSError, subprocess.CalledProcessError):
        return root


if __name__ == "__main__":
    import sys

    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "tools" / "speech"))
    from environment import load_environment
    load_environment(root, use_rclone="--b2" in sys.argv)
    sys.path.insert(0, str(root / "backend" / "src"))
    uvicorn.run("app.main:app", host="127.0.0.1", port=8088, reload=True,
                reload_dirs=[str(root / "backend" / "src")])
