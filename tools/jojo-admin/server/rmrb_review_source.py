"""Rebuildable RMRB review queue sourced from a Hugging Face Canonical index."""

from __future__ import annotations

import gzip
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import urllib.parse
import urllib.request
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable


ARTICLE_PREFIX = "newspapers/rmrb/data/articles/"
MISSING_INDEX = "newspapers/rmrb/indexes/missing-articles.jsonl.gz"


@dataclass(frozen=True)
class HfSnapshot:
    revision: str
    files: tuple[str, ...]


def fetch_hf_snapshot(repo_id: str, token: str) -> HfSnapshot:
    from huggingface_hub import HfApi

    info = HfApi(token=token or None).dataset_info(repo_id, files_metadata=False)
    article_files = tuple(sorted(
        sibling.rfilename
        for sibling in info.siblings
        if sibling.rfilename.startswith(ARTICLE_PREFIX)
        and sibling.rfilename.endswith(".jsonl.gz")
    ))
    names = {sibling.rfilename for sibling in info.siblings}
    files = (MISSING_INDEX,) if MISSING_INDEX in names else article_files
    if not files:
        raise RuntimeError(f"HF 数据集 {repo_id} 中没有人民日报年度文章分片")
    return HfSnapshot(revision=str(info.sha), files=files)


def download_hf_shard(repo_id: str, token: str, revision: str, filename: str) -> Path:
    """Download without invoking the Xet client inside the Flask process."""
    cache = Path(tempfile.gettempdir()) / "jojo-rmrb-hf" / revision / Path(filename).name
    if cache.is_file():
        return cache
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix(
        cache.suffix + f".{os.getpid()}.{threading.get_ident()}.downloading"
    )
    url = (
        "https://huggingface.co/datasets/"
        f"{urllib.parse.quote(repo_id, safe='/')}/resolve/{urllib.parse.quote(revision, safe='')}/"
        f"{urllib.parse.quote(filename, safe='/')}"
    )
    headers = {"User-Agent": "jojo-rmrb-review/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            expected_size = int(response.headers.get("Content-Length") or 0)
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if expected_size and temporary.stat().st_size != expected_size:
            raise IOError(
                f"HF 下载不完整：期望 {expected_size} 字节，实际 {temporary.stat().st_size} 字节"
            )
        os.replace(temporary, cache)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return cache


def cache_revision(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        with closing(sqlite3.connect(path)) as connection:
            row = connection.execute(
                "SELECT value FROM cache_metadata WHERE key = 'sourceRevision'"
            ).fetchone()
        return str(row[0]) if row else None
    except sqlite3.Error:
        return None


def build_review_cache(
    shards: Iterable[Path],
    target: Path,
    repo_id: str,
    revision: str,
    progress: Callable[[int, int, str], None] | None = None,
) -> int:
    """Atomically build a disposable SQLite queue from an HF missing index or annual shards."""
    shard_paths = list(shards)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(
        target.name + f".{os.getpid()}.{threading.get_ident()}.building"
    )
    connection = sqlite3.connect(temporary)
    missing_count = 0
    try:
        connection.executescript(
            """
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = MEMORY;
            CREATE TABLE missing_articles (
                issue_date TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                ordinal INTEGER NOT NULL,
                title TEXT NOT NULL,
                href TEXT,
                match_method TEXT,
                content_source TEXT,
                PRIMARY KEY (issue_date, page_number, ordinal)
            ) WITHOUT ROWID;
            CREATE TABLE cache_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;
            """
        )
        allowed = {
            "available", "missing", "rejected",
            # Read-only compatibility for the first HF publication. New data
            # is emitted with the three canonical states above.
            "image", "image-placeholder", "repaired",
        }
        for index, shard in enumerate(shard_paths, start=1):
            batch: list[tuple[object, ...]] = []
            with gzip.open(shard, "rt", encoding="utf-8") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    status = str(row.get("status") or "missing")
                    if status not in allowed:
                        raise ValueError(f"未知文章状态 {status!r}：{shard.name}")
                    if status != "missing":
                        continue
                    batch.append((
                        str(row["date"]),
                        int(row["page"]),
                        int(row["ordinal"]),
                        str(row.get("title") or ""),
                        None,
                        "hf-canonical",
                        None,
                    ))
            connection.executemany(
                "INSERT INTO missing_articles VALUES (?, ?, ?, ?, ?, ?, ?)", batch
            )
            missing_count += len(batch)
            if progress:
                progress(index, len(shard_paths), shard.name)
        connection.executescript(
            """
            CREATE INDEX missing_articles_date_order
                ON missing_articles(issue_date, page_number, ordinal);
            CREATE INDEX missing_articles_title ON missing_articles(title);
            """
        )
        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        connection.executemany(
            "INSERT INTO cache_metadata VALUES (?, ?)",
            (
                ("formatVersion", "jojo-rmrb-hf-review-cache/1"),
                ("repoId", repo_id),
                ("sourceRevision", revision),
                ("generatedAt", generated_at),
                ("shardCount", str(len(shard_paths))),
                ("missingCount", str(missing_count)),
            ),
        )
        connection.commit()
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    connection.close()
    os.replace(temporary, target)
    return missing_count


def remove_from_review_cache(path: Path, keys: set[tuple[str, int, int]], revision: str) -> None:
    """Apply a just-published HF commit to the local disposable cache."""
    if not path.is_file() or not keys:
        return
    with closing(sqlite3.connect(path)) as connection:
        connection.executemany(
            "DELETE FROM missing_articles WHERE issue_date = ? AND page_number = ? AND ordinal = ?",
            sorted(keys),
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cache_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID
            """
        )
        connection.execute(
            "INSERT OR REPLACE INTO cache_metadata VALUES ('sourceRevision', ?)",
            (revision,),
        )
        connection.commit()


class ReviewSourceManager:
    def __init__(
        self,
        snapshot_loader: Callable[[str, str], HfSnapshot] = fetch_hf_snapshot,
        shard_downloader: Callable[[str, str, str, str], Path] = download_hf_shard,
    ) -> None:
        self._snapshot_loader = snapshot_loader
        self._shard_downloader = shard_downloader
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state: dict[str, object] = {
            "status": "idle",
            "source": "huggingface",
            "message": "等待检查 HF Canonical",
            "completed": 0,
            "total": 0,
            "revision": None,
            "error": None,
        }

    def _update(self, **changes: object) -> None:
        with self._lock:
            self._state.update(changes)

    def snapshot(self, target: Path) -> dict[str, object]:
        with self._lock:
            state = dict(self._state)
        state["cached"] = target.is_file()
        return state

    def mark_published(self, revision: str) -> None:
        self._update(
            status="ready",
            revision=revision,
            message="本机缓存已跟随刚发布的 HF Canonical 更新",
            error=None,
        )

    def wait(self, timeout: float | None = None) -> None:
        with self._lock:
            thread = self._thread
        if thread:
            thread.join(timeout)

    def ensure_started(self, target: Path, repo_id: str, token: str, force: bool = False) -> None:
        local_revision = cache_revision(target)
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            if self._state.get("status") == "ready" and not force:
                return
            self._state.update({
                "status": "ready" if local_revision and not force else "checking",
                "message": (
                    "正在使用本机缓存，后台检查 HF Canonical 版本"
                    if local_revision and not force
                    else "正在检查 HF Canonical 版本"
                ),
                "completed": 0,
                "total": 0,
                "revision": local_revision,
                "error": None,
            })
            self._thread = threading.Thread(
                target=self._refresh,
                args=(target, repo_id, token),
                name="rmrb-hf-review-cache",
                daemon=True,
            )
            self._thread.start()

    def _refresh(self, target: Path, repo_id: str, token: str) -> None:
        try:
            snapshot = self._snapshot_loader(repo_id, token)
            self._update(revision=snapshot.revision, total=len(snapshot.files))
            if cache_revision(target) == snapshot.revision:
                self._update(
                    status="ready",
                    message="HF Canonical 缺失索引已是最新版本",
                    completed=len(snapshot.files),
                )
                return
            self._update(status="downloading", message="正在下载 HF 缺失正文索引")
            workers = max(1, int(os.environ.get("HF_REVIEW_DOWNLOAD_WORKERS", "8")))
            downloaded: dict[str, Path] = {}
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {
                    pool.submit(
                        self._shard_downloader,
                        repo_id,
                        token,
                        snapshot.revision,
                        filename,
                    ): filename
                    for filename in snapshot.files
                }
                for completed, future in enumerate(as_completed(futures), start=1):
                    filename = futures[future]
                    downloaded[filename] = future.result()
                    self._update(
                        completed=completed,
                        message=f"正在下载 HF 缺失索引（{completed}/{len(snapshot.files)}）",
                    )
            self._update(status="building", completed=0, message="正在生成待复核缓存")

            def report(completed: int, total: int, name: str) -> None:
                self._update(
                    completed=completed,
                    total=total,
                    message=f"正在生成待复核缓存（{completed}/{total}）：{name}",
                )

            count = build_review_cache(
                (downloaded[name] for name in snapshot.files),
                target,
                repo_id,
                snapshot.revision,
                report,
            )
            self._update(
                status="ready",
                completed=len(snapshot.files),
                total=len(snapshot.files),
                message=f"HF 待复核队列已就绪，共 {count:,} 条 missing",
            )
        except Exception as error:
            if target.is_file():
                self._update(
                    status="ready",
                    message=f"HF 暂时不可达，正在使用上次缓存：{error}",
                    error=str(error),
                )
            else:
                self._update(status="failed", message=f"HF 队列初始化失败：{error}", error=str(error))


review_source_manager = ReviewSourceManager()
