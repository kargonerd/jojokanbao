#!/usr/bin/env python3
"""Resumable publisher for the five JOJO periodical collections.

The publisher intentionally works in bounded batches.  Hugging Face is the
Canonical dataset and readable PDF store; public B2 contains only Delivery
objects used by the applications.  Generated batches are removed only after
both destinations succeed; source PDFs are never modified.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import prepare_pdf_periodicals as pdfs
import prepare_rmrb_publication as rmrb


WORKSPACE = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = Path(r"C:\Users\luoxixi\GAI\jojo-platform\tmp\rmrb-peopledata-full-directory\merged-peopledata-canonical.jsonl")
DEFAULT_REVIEW = DEFAULT_SOURCE.parent
DEFAULT_WORK = Path(r"C:\Users\luoxixi\GAI\jojo-platform\tmp\periodical-publish")
HF_REPO = "luoxiaozhuang/marxism-dataset"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Publisher:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.work = args.work.resolve()
        self.work.mkdir(parents=True, exist_ok=True)
        self.log_path = self.work / "publish-all.log"
        self.state_path = self.work / "publish-state.json"
        self.log_lock = threading.Lock()
        self.state = self.load_state()

    def log(self, message: str) -> None:
        line = f"[{now()}] {message}"
        with self.log_lock:
            print(line, flush=True)
            with self.log_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(line + "\n")

    def load_state(self) -> dict[str, Any]:
        if self.state_path.is_file():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {"formatVersion": "jojo-periodical-publish-state/1", "completed": [], "rmrbYears": {}}

    def save_state(self) -> None:
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.state_path)

    def run(
        self,
        command: list[str],
        *,
        attempts: int = 1,
        env: dict[str, str] | None = None,
    ) -> None:
        for attempt in range(1, attempts + 1):
            self.log(f"RUN {attempt}/{attempts}: {' '.join(command)}")
            result = subprocess.run(command, cwd=WORKSPACE, check=False, env=env)
            if result.returncode == 0:
                return
            if attempt == attempts:
                raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")
            delay = min(300, 30 * attempt)
            self.log(f"retrying in {delay}s after exit {result.returncode}")
            time.sleep(delay)

    def wait_for_pids(self, pids: Iterable[int]) -> None:
        pending = {int(pid) for pid in pids}
        while pending:
            alive: set[int] = set()
            for pid in pending:
                check = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", f"if(Get-Process -Id {pid} -ErrorAction SilentlyContinue){{exit 0}}else{{exit 1}}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if check.returncode == 0:
                    alive.add(pid)
            pending = alive
            if pending:
                self.log(f"waiting for existing publishers: {sorted(pending)}")
                time.sleep(60)

    def safe_remove_batch(self, batch: Path) -> None:
        resolved = batch.resolve()
        if resolved.parent != self.work:
            raise RuntimeError(f"Unsafe batch cleanup target: {resolved}")
        if resolved.is_dir():
            shutil.rmtree(resolved)
            self.log(f"removed reproducible staging batch: {resolved}")

    def rclone_copy(self, source: Path | str, destination: str, includes: list[str] | None = None) -> None:
        command = [
            "rclone", "copy", str(source), destination,
            "--transfers", "16", "--checkers", "32",
            "--retries", "10", "--low-level-retries", "20",
        ]
        if includes:
            for pattern in includes:
                command.extend(["--include", pattern])
            command.extend(["--exclude", "*"])
        self.run(command, attempts=3)

    def hf_upload(self, folder: Path, includes: list[str] | None = None) -> None:
        workers = max(1, int(os.getenv("HF_UPLOAD_WORKERS", "4")))
        env = os.environ.copy()
        # On the current proxied Windows link, Xet payloads reach CAS but the
        # final metadata shard does not return, so no resumable upload state or
        # Hub commit is produced. The LFS bridge has lower peak throughput but
        # reliably advances both metadata and commits. Xet remains opt-in.
        env.setdefault("HF_HUB_DISABLE_XET", "1")
        # Xet high-performance mode is intended for hosts with at least 64 GB
        # of RAM.  Keep the resumable Xet transport enabled, but require an
        # explicit opt-in for its much larger buffers/concurrency settings.
        env.setdefault("HF_XET_HIGH_PERFORMANCE", "0")
        # The current proxy path has modest aggregate bandwidth. Two long-lived
        # streams complete Xet's ~61 MB transfer units reliably; more streams
        # divide the same bandwidth and can hit the default retry deadline.
        env.setdefault("HF_XET_FIXED_UPLOAD_CONCURRENCY", "2")
        env.setdefault("HF_XET_CLIENT_RETRY_MAX_DURATION", "1200s")
        env.setdefault("HF_XET_CLIENT_READ_TIMEOUT", "600s")
        command = [
            "hf", "upload-large-folder", HF_REPO, str(folder),
            "--repo-type", "dataset", "--num-workers", str(workers), "--no-bars",
        ]
        if includes:
            command.append("--include")
            command.extend(includes)
        self.log(
            f"Hugging Face upload: workers={workers}, "
            f"xetDisabled={env['HF_HUB_DISABLE_XET']}, "
            f"xetHighPerformance={env['HF_XET_HIGH_PERFORMANCE']}"
        )
        self.run(command, attempts=20, env=env)

    def run_parallel_uploads(self, tasks: dict[str, Callable[[], None]]) -> None:
        self.log(f"starting parallel uploads: {', '.join(tasks)}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as executor:
            futures = {executor.submit(task): name for name, task in tasks.items()}
            for future in concurrent.futures.as_completed(futures):
                name = futures[future]
                future.result()
                self.log(f"parallel upload completed: {name}")

    def publish_pdf_collection(self, slug: str) -> None:
        marker = f"pdf:{slug}"
        if marker in self.state["completed"]:
            self.log(f"skip completed {marker}")
            batch = self.work / slug
            if (batch / "pdf-periodicals-report.json").is_file():
                self.safe_remove_batch(batch)
            return
        batch = self.work / slug
        if not (batch / "pdf-periodicals-report.json").is_file():
            if batch.exists():
                raise RuntimeError(f"Incomplete existing batch needs inspection: {batch}")
            self.run([
                sys.executable, str(WORKSPACE / "tools/rmrb-repair/prepare_pdf_periodicals.py"),
                "--output", str(batch), "--publication", slug,
            ])
        self.run_parallel_uploads({
            "delivery-b2": lambda: self.rclone_copy(
                batch / f"delivery/content/newspapers/{slug}",
                f"jojo-b2-s3:jojo-newspaper/content/newspapers/{slug}",
            ),
            "huggingface": lambda: self.hf_upload(batch / "huggingface"),
        })
        self.state["completed"].append(marker)
        self.save_state()
        self.safe_remove_batch(batch)

    def split_rmrb_source(self) -> list[str]:
        shard_root = self.work / "rmrb-source-years"
        marker = shard_root / "_SUCCESS.json"
        if marker.is_file():
            return json.loads(marker.read_text(encoding="utf-8"))["years"]
        shard_root.mkdir(parents=True, exist_ok=True)
        current_year: str | None = None
        output = None
        years: list[str] = []
        try:
            with self.args.merged.open(encoding="utf-8-sig") as source:
                for line in source:
                    if not line.strip():
                        continue
                    year = str(json.loads(line)["date"])[:4]
                    if year != current_year:
                        if output:
                            output.close()
                        current_year = year
                        years.append(year)
                        output = gzip.open(shard_root / f"{year}.jsonl.gz", "wt", encoding="utf-8", newline="\n", compresslevel=6)
                    output.write(line.rstrip("\r\n") + "\n")
        finally:
            if output:
                output.close()
        marker.write_text(json.dumps({"years": years}, ensure_ascii=False) + "\n", encoding="utf-8")
        self.log(f"split RMRB source into {len(years)} annual shards")
        return years

    def cache_remote_rmrb_year(self, year: str) -> Path:
        cache_root = self.work / "rmrb-pdf-cache"
        target = cache_root / year
        if not target.is_dir() or not any(target.glob("*.pdf")):
            target.mkdir(parents=True, exist_ok=True)
            self.rclone_copy(
                f"jojo-b2-s3:jojo-newspaper/RMRB/{year}",
                str(target),
            )
        return cache_root

    def collect_rmrb_year(self, batch: Path, year: str) -> None:
        text_dates: list[str] = []
        pdf_dates: list[str] = []
        item_count = 0
        item_root = batch / f"canonical/newspapers/rmrb/items/{year}"
        for path in sorted(item_root.rglob("*.json.gz")):
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                item = json.load(stream)
            day = str(item["metadata"].get("publishedDate") or item["itemId"].split(":", 1)[1])
            item_count += 1
            if any(article.get("contentState") == "available" for article in item["content"].get("articles", [])):
                text_dates.append(day)
            if any(asset.get("type") == "pdf" for asset in item.get("assets", [])):
                pdf_dates.append(day)
        self.state["rmrbYears"][year] = {
            "itemCount": item_count,
            "textDates": text_dates,
            "pdfDates": pdf_dates,
        }
        self.save_state()

    def publish_rmrb_year(self, year: str) -> None:
        marker = f"rmrb:{year}"
        if marker in self.state["completed"]:
            self.log(f"skip completed {marker}")
            return
        batch = self.work / f"rmrb-{year}"
        if not (batch / "_SUCCESS.json").is_file():
            if batch.exists():
                raise RuntimeError(f"Incomplete existing batch needs inspection: {batch}")
            pdf_root = rmrb.DEFAULT_PDFS
            if year == "2013":
                pdf_root = self.cache_remote_rmrb_year(year)
            self.run([
                sys.executable, str(WORKSPACE / "tools/rmrb-repair/prepare_rmrb_publication.py"),
                "--merged", str(self.work / f"rmrb-source-years/{year}.jsonl.gz"),
                "--review-root", str(self.args.review_root),
                "--output", str(batch), "--skip-audit",
                "--snapshot-id", self.args.snapshot_id,
                "--pdf-root", str(pdf_root),
            ])
        hf_includes = [
            f"newspapers/rmrb/items/{year}/**",
            f"newspapers/rmrb/assets/pdfs/{year}/**",
            "newspapers/rmrb/assets/images/**",
            f"newspapers/rmrb/data/articles/{year}.jsonl.gz",
        ]
        self.run_parallel_uploads({
            "delivery-b2": lambda: self.rclone_copy(
                batch / "delivery/content/newspapers/rmrb",
                "jojo-b2-s3:jojo-newspaper/content/newspapers/rmrb",
                [f"/items/{year}/**"],
            ),
            "huggingface": lambda: self.hf_upload(batch / "huggingface", hf_includes),
        })
        self.collect_rmrb_year(batch, year)
        self.state["completed"].append(marker)
        self.save_state()
        self.safe_remove_batch(batch)
        cache = self.work / f"rmrb-pdf-cache/{year}"
        if cache.is_dir():
            shutil.rmtree(cache)
            self.log(f"removed downloaded legacy PDF cache: {cache}")

    def publish_rmrb_2026(self) -> None:
        year = "2026"
        marker = f"rmrb:{year}"
        if marker in self.state["completed"]:
            return
        batch = self.work / f"rmrb-{year}"
        if not (batch / "canonical/newspapers/rmrb/dataset.json").is_file():
            publication = pdfs.Publication(
                "RMRB", "rmrb", "人民日报", "newspaper", "daily", rmrb.DEFAULT_PDFS_2014_2026,
            )
            pdfs.build_publication(publication, batch, now(), year=year)
        self.run_parallel_uploads({
            "delivery-b2": lambda: self.rclone_copy(
                batch / "delivery/content/newspapers/rmrb",
                "jojo-b2-s3:jojo-newspaper/content/newspapers/rmrb",
                [f"/items/{year}/**"],
            ),
            "huggingface": lambda: self.hf_upload(
                batch / "huggingface",
                [
                    f"newspapers/rmrb/items/{year}/**",
                    f"newspapers/rmrb/assets/pdfs/{year}/**",
                    f"newspapers/rmrb/data/issues/{year}.jsonl.gz",
                ],
            ),
        })
        self.collect_rmrb_year(batch, year)
        self.state["completed"].append(marker)
        self.save_state()
        self.safe_remove_batch(batch)

    def finalize_rmrb(self) -> None:
        marker = "rmrb:final-index"
        if marker in self.state["completed"]:
            return
        all_years = self.state["rmrbYears"]
        text_dates = {day for row in all_years.values() for day in row["textDates"]}
        pdf_dates = {day for row in all_years.values() for day in row["pdfDates"]}
        all_dates = text_dates | pdf_dates
        start_date, end_date = min(all_dates), max(all_dates)
        availability = {
            "formatVersion": "jojo-periodical-availability/1",
            "text": rmrb.adaptive_calendar(start_date, end_date, text_dates),
            "pdf": rmrb.adaptive_calendar(start_date, end_date, pdf_dates),
        }
        dataset = {
            "formatVersion": "jojo-dataset/1", "datasetId": "rmrb", "type": "newspaper",
            "title": "人民日报", "language": "zh-CN", "publicationStatus": "published", "access": "public",
            "description": "以人民数据目录为权威目录、合并本地正文与人工修订，并配套整期 PDF 的人民日报数据集。",
            "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}.json.gz", "availability": availability,
        }
        index = {
            "formatVersion": "jojo-delivery-index/1", "revision": 1, "datasetId": "rmrb", "type": "newspaper",
            "title": "人民日报", "language": "zh-CN", "description": dataset["description"],
            "publicationStatus": "published", "access": "public",
            "itemPath": "items/{YYYY}/{MM}/{YYYY-MM-DD}/manifest.jox", "availability": availability,
        }
        batch = self.work / "rmrb-final-metadata"
        rmrb.write_json(batch / "canonical/newspapers/rmrb/dataset.json", dataset)
        rmrb.write_json(batch / "huggingface/newspapers/rmrb/dataset.json", dataset)
        (batch / "huggingface/newspapers/rmrb/README.md").write_text(
            "# 人民日报\n\n按人民数据目录整理的文章正文、期级元数据、文章图片和整期 PDF。\n",
            encoding="utf-8", newline="\n",
        )
        (batch / "huggingface/newspapers/README.md").write_text(
            "# 报刊数据集\n\n"
            "- [`rmrb/`](rmrb/)：人民日报\n"
            "- [`ckxx/`](ckxx/)：参考消息\n"
            "- [`hq/`](hq/)：红旗\n"
            "- [`rmhb/`](rmhb/)：人民画报\n"
            "- [`sjzs/`](sjzs/)：世界知识\n",
            encoding="utf-8", newline="\n",
        )
        rmrb.write_jox_json(batch / "delivery", "content/newspapers/rmrb/index.jox", index)
        self.run_parallel_uploads({
            "delivery-b2": lambda: self.rclone_copy(
                batch / "delivery/content/newspapers/rmrb",
                "jojo-b2-s3:jojo-newspaper/content/newspapers/rmrb",
            ),
            "huggingface-index": lambda: self.run([
                "hf", "upload", HF_REPO, str(batch / "huggingface/newspapers/rmrb"),
                "newspapers/rmrb", "--repo-type", "dataset", "--commit-message",
                "Finalize People's Daily indexes",
            ], attempts=10),
            "huggingface-readme": lambda: self.run([
                "hf", "upload", HF_REPO, str(batch / "huggingface/newspapers/README.md"),
                "newspapers/README.md", "--repo-type", "dataset", "--commit-message",
                "Document all periodical datasets",
            ], attempts=10),
        })
        self.finalize_catalog(batch)
        self.state["completed"].append(marker)
        self.save_state()
        self.safe_remove_batch(batch)

    def finalize_catalog(self, batch: Path) -> None:
        current = batch / "current-catalog.jox"
        self.run(["rclone", "copyto", "jojo-b2-s3:jojo-newspaper/catalog.jox", str(current)], attempts=3)
        try:
            catalog = json.loads(gzip.decompress(rmrb.transform_jox_bytes(current.read_bytes(), "catalog.jox")))
        except Exception:
            catalog = {"formatVersion": "jojo-catalog/1", "revision": 0, "updatedAt": now(), "datasets": []}
        replacements = {
            "rmrb": ("newspaper", "人民日报"),
            "ckxx": ("newspaper", "参考消息"),
            "hq": ("magazine", "红旗"),
            "rmhb": ("magazine", "人民画报"),
            "sjzs": ("magazine", "世界知识"),
        }
        datasets = [row for row in catalog.get("datasets", []) if row.get("datasetId") not in replacements]
        for dataset_id, (kind, title) in replacements.items():
            datasets.append({
                "datasetId": dataset_id, "type": kind, "title": title, "language": "zh-CN",
                "indexObject": f"content/newspapers/{dataset_id}/index.jox",
                "publicationStatus": "published", "access": "public",
            })
        catalog.update({
            "formatVersion": "jojo-catalog/1",
            "revision": int(catalog.get("revision", 0)) + 1,
            "updatedAt": now(),
            "datasets": datasets,
        })
        rmrb.write_jox_json(batch / "delivery", "catalog.jox", catalog)
        self.run(["rclone", "copyto", str(batch / "delivery/catalog.jox"), "jojo-b2-s3:jojo-newspaper/catalog.jox"], attempts=3)

    def run_all(self) -> None:
        self.wait_for_pids(self.args.wait_pid)
        for slug in ("ckxx", "rmhb", "sjzs"):
            self.publish_pdf_collection(slug)
        years = self.split_rmrb_source()
        for year in years:
            self.publish_rmrb_year(year)
        self.publish_rmrb_2026()
        self.finalize_rmrb()
        self.log("ALL PERIODICAL PUBLICATION TASKS COMPLETED")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--merged", type=Path, default=DEFAULT_SOURCE)
    result.add_argument("--review-root", type=Path, default=DEFAULT_REVIEW)
    result.add_argument("--work", type=Path, default=DEFAULT_WORK)
    result.add_argument("--snapshot-id", default="2026-08-20")
    result.add_argument("--wait-pid", action="append", type=int, default=[])
    return result


def main() -> None:
    Publisher(parser().parse_args()).run_all()


if __name__ == "__main__":
    main()
