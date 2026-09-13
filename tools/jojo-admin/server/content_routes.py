"""Local JOJO Admin routes for importing and publishing content."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid

from flask import Blueprint, jsonify, request, send_file

from content_publish import (
    ROOT,
    publication_status,
    publish_b2,
    publish_huggingface,
)
from content_search import search_content
from content_index import sync_publication
from content_metadata import update_publication, validate_book_title


content_blueprint = Blueprint("content", __name__)
RUNTIME = Path(__file__).resolve().parent / ".runtime" / "content-jobs"
RUNTIME.mkdir(parents=True, exist_ok=True)
SUPPORTED_SOURCE_SUFFIXES = {".json", ".epub", ".azw", ".mobi", ".prc"}
_lock = threading.RLock()
_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _save(job: dict) -> None:
    job["updatedAt"] = _now()
    directory = RUNTIME / job["jobId"]
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / "state.json.tmp"
    temporary.write_text(
        json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(directory / "state.json")


def _set(job_id: str, **changes) -> dict:
    with _lock:
        job = _jobs[job_id]
        job.update(changes)
        _save(job)
        return dict(job)


def _log(job_id: str, line: str) -> None:
    with _lock:
        job = _jobs[job_id]
        logs = job.setdefault("logs", [])
        logs.append(line)
        if len(logs) > 500:
            del logs[:-500]
        _save(job)


def _load_jobs() -> None:
    for state in RUNTIME.glob("*/state.json"):
        try:
            job = json.loads(state.read_text(encoding="utf-8"))
            if job.get("status") == "publishing":
                job["status"] = "publish-failed"
                job["message"] = "上传被管理台重启中断，请重试同步"
                for result in job.get("publish", {}).values():
                    if result.get("status") in {"pending", "uploading"}:
                        result.update(status="failed", message=job["message"])
            elif job.get("status") in {"queued", "building"}:
                job["status"] = "interrupted"
                job["message"] = "管理台重启中断了任务，可以重新导入或发布"
            # Older jobs did not record which settings each successful upload used.
            for result in job.get("publish", {}).values():
                if result.get("status") == "completed":
                    result.setdefault("publicationStatus", job.get("publicationStatus", "draft"))
                    result.setdefault("access", job.get("access", "public"))
            _jobs[job["jobId"]] = job
        except Exception:
            continue


_load_jobs()


def _new_job(input_paths: list[str], fetch_assets: bool, publication_status: str = "draft", access: str = "public", job_id: str | None = None, *, library_source: str) -> dict:
    job_id = job_id or uuid.uuid4().hex[:16]
    job = {
        "jobId": job_id,
        "status": "queued",
        "phase": "queued",
        "message": "等待内容处理",
        "createdAt": _now(),
        "updatedAt": _now(),
        "inputPaths": input_paths,
        "fetchAssets": fetch_assets,
        "publicationStatus": publication_status,
        "access": "authenticated" if library_source == "community" else access,
        "librarySource": library_source,
        "outputDirectory": str(RUNTIME / job_id / "output"),
        "progress": {},
        "report": None,
        "publish": {},
        "logs": [],
    }
    with _lock:
        _jobs[job_id] = job
        _save(job)
    threading.Thread(target=_build, args=(job_id,), daemon=True).start()
    return job


def _build(job_id: str) -> None:
    job = _set(job_id, status="building", phase="inspect", message="正在检查电子书源文件")
    pnpm = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"
    command = [pnpm, "--filter", "@jojo/content-pipeline", "cli"]
    for input_path in job["inputPaths"]:
        command.extend(["--input", input_path])
    command.extend(["--output", job["outputDirectory"]])
    command.extend(["--library-source", job["librarySource"]])
    if not job["fetchAssets"]:
        command.append("--no-assets")
    command.append("--published" if job.get("publicationStatus") == "published" else "--draft")
    command.append("--authenticated" if job.get("access") == "authenticated" else "--public")
    try:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if not line:
                continue
            _log(job_id, line)
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            phase = str(event.get("phase", "building"))
            if phase == "complete":
                _set(job_id, progress=event, phase="complete")
            elif phase == "failed":
                _set(job_id, progress=event, phase="failed")
            else:
                _set(job_id, progress=event, phase=phase, message=_phase_message(event))
        code = process.wait()
        report_path = Path(job["outputDirectory"]) / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
        if code:
            if report:
                _set(job_id, report=report)
                errors = [item.get("message", "") for item in report.get("diagnostics", []) if item.get("level") == "error"]
                if errors:
                    raise RuntimeError("；".join(errors[:3]))
            raise RuntimeError(f"内容处理退出码 {code}")
        assert report is not None
        _set(job_id, status="ready", phase="complete", message="内容已生成并通过结构检查", report=report)
    except Exception as exc:
        _log(job_id, str(exc))
        _set(job_id, status="failed", phase="failed", message=str(exc))


def _phase_message(event: dict) -> str:
    phase = event.get("phase")
    if phase == "inspect":
        return f"检查文件 {event.get('current', 0)}/{event.get('total', 0)}"
    if phase == "decode":
        return f"解码 {event.get('current', 0)}/{event.get('total', 0)}：{event.get('file', '')}"
    if phase == "build-item":
        return f"生成 Item：{event.get('title', '')}"
    return "正在处理"


@content_blueprint.get("/api/content/status")
def status():
    return jsonify({"success": True, "publishers": publication_status()})


@content_blueprint.post("/api/content/search")
def content_search():
    try:
        return jsonify(search_content(request.get_json(silent=True) or {}))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@content_blueprint.get("/api/content/jobs")
def jobs():
    with _lock:
        values = sorted(_jobs.values(), key=lambda item: item["createdAt"], reverse=True)
        return jsonify({"success": True, "jobs": [_job_view(value) for value in values[:20]]})


def _newer_job(value: dict) -> dict | None:
    ids = {item["itemId"] for item in (value.get("report") or {}).get("itemsBuilt", []) if item.get("itemId")}
    if not ids:
        return None
    candidates = [other for other in _jobs.values()
                  if other.get("createdAt", "") > value.get("createdAt", "")
                  and other.get("status") in {"ready", "publishing", "published", "publish-failed"}
                  and any(item.get("itemId") in ids for item in (other.get("report") or {}).get("itemsBuilt", []))]
    return max(candidates, key=lambda item: item["createdAt"], default=None)


def _job_view(value: dict) -> dict:
    newer = _newer_job(value)
    return {**value, "newerJobId": newer["jobId"] if newer else None}


@content_blueprint.get("/api/content/jobs/<job_id>")
def job(job_id: str):
    with _lock:
        value = _jobs.get(job_id)
        if not value:
            return jsonify({"success": False, "message": "任务不存在"}), 404
        return jsonify({"success": True, "job": _job_view(value)})


@content_blueprint.get("/api/content/jobs/<job_id>/preview/delivery/<path:object_key>")
def preview_delivery(job_id: str, object_key: str):
    """Serve the exact local Reader payload, without publishing or cloud access."""
    with _lock:
        value = _jobs.get(job_id)
        if not value:
            return jsonify({"success": False, "message": "任务不存在"}), 404
        if value["status"] not in {"ready", "publishing", "published", "publish-failed"}:
            return jsonify({"success": False, "message": "内容尚未生成，暂时无法预览"}), 409
    # Only generated delivery objects are exposed, never source files or state.
    root = RUNTIME.resolve() / job_id / "output" / "delivery"
    target = (root / object_key).resolve()
    if (not re.fullmatch(r"[A-Za-z0-9_-]+", job_id)
            or root.resolve() != root
            or not target.is_relative_to(root)
            or target.suffix != ".jox"
            or not target.is_file()):
        return jsonify({"success": False, "message": "找不到本地预览文件"}), 404
    response = send_file(target, mimetype="application/octet-stream", conditional=True)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@content_blueprint.post("/api/content/import-paths")
def import_paths():
    data = request.get_json(silent=True) or {}
    library_source = data.get("librarySource") if isinstance(data, dict) else None
    if library_source not in ("jojo", "community"):
        return jsonify({"success": False, "message": "请选择 JOJO书库或共享书库"}), 400
    supplied = data.get("paths") or []
    if isinstance(supplied, str):
        supplied = [supplied]
    paths: list[str] = []
    for raw_path in supplied:
        value = Path(str(raw_path)).expanduser().resolve()
        if value.is_dir():
            paths.extend(
                str(item) for item in sorted(value.iterdir())
                if item.is_file() and item.suffix.lower() in SUPPORTED_SOURCE_SUFFIXES
            )
        elif value.is_file() and value.suffix.lower() in SUPPORTED_SOURCE_SUFFIXES:
            paths.append(str(value))
    paths = list(dict.fromkeys(paths))
    if not paths:
        return jsonify({"success": False, "message": "没有找到支持的 JSON、EPUB 或 Kindle 文件"}), 400
    publication_status = "published" if data.get("publicationStatus") == "published" else "draft"
    access = "authenticated" if data.get("access") == "authenticated" else "public"
    return jsonify({"success": True, "job": _new_job(paths, bool(data.get("fetchAssets", True)), publication_status, access, library_source=library_source)})


@content_blueprint.post("/api/content/import-files")
def import_files():
    library_source = request.form.get("librarySource")
    if library_source not in ("jojo", "community"):
        return jsonify({"success": False, "message": "请选择 JOJO书库或共享书库"}), 400
    files = request.files.getlist("files")
    if not files:
        return jsonify({"success": False, "message": "没有上传文件"}), 400
    job_id = uuid.uuid4().hex[:16]
    upload_root = RUNTIME / job_id / "input"
    upload_root.mkdir(parents=True, exist_ok=True)
    input_paths = []
    for index, file in enumerate(files, 1):
        filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
        filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", filename).rstrip(" .")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED_SOURCE_SUFFIXES:
            continue
        if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", filename, re.I):
            filename = f"_{filename}"
        # Keep the name for metadata fallback; isolate duplicate names per upload.
        target = upload_root / f"{index:04d}" / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        file.save(target)
        input_paths.append(str(target))
    if not input_paths:
        shutil.rmtree(RUNTIME / job_id, ignore_errors=True)
        return jsonify({"success": False, "message": "只支持 JSON、EPUB、AZW、MOBI 和 PRC 文件"}), 400
    return jsonify({"success": True, "job": _new_job(
        input_paths,
        request.form.get("fetchAssets", "true").lower() != "false",
        "published" if request.form.get("publicationStatus") == "published" else "draft",
        "authenticated" if request.form.get("access") == "authenticated" else "public",
        job_id=job_id,
        library_source=library_source,
    )})


@content_blueprint.post("/api/content/jobs/<job_id>/publish")
def publish(job_id: str):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict) or not isinstance(data.get("targets"), list):
        return jsonify({"success": False, "message": "请选择上传目标"}), 400
    targets = [name for name in ("huggingface", "b2", "elasticsearch") if name in (data.get("targets") or [])]
    if targets and "elasticsearch" not in targets:
        targets.append("elasticsearch")
    with _lock:
        value = _jobs.get(job_id)
        if not value:
            return jsonify({"success": False, "message": "任务不存在"}), 404
        if value["status"] not in {"ready", "published", "publish-failed"}:
            return jsonify({"success": False, "message": "任务尚未生成可发布内容"}), 409
        newer = _newer_job(value)
        if newer:
            return jsonify({"success": False, "message": "这本书已有更新的导入版本，请切换到最新版本发布，避免覆盖修复后的内容", "newerJobId": newer["jobId"]}), 409
        if not targets:
            return jsonify({"success": False, "message": "至少选择一个发布目标"}), 400
        publication = data.get("publicationStatus", value.get("publicationStatus", "draft"))
        access = data.get("access", value.get("access", "public"))
        if value.get("librarySource") == "community":
            access = "authenticated"
        if publication not in ("draft", "published") or access not in ("public", "authenticated"):
            return jsonify({"success": False, "message": "无效的发布设置"}), 400
        title = None
        if "title" in data:
            try:
                title = validate_book_title(data["title"])
            except ValueError as exc:
                return jsonify({"success": False, "message": str(exc)}), 400
            items = (value.get("report") or {}).get("itemsBuilt", [])
            if len(items) != 1:
                return jsonify({"success": False, "message": "请在单本书籍任务中修改书名"}), 400
            if title == items[0].get("itemTitle") and title == items[0].get("datasetTitle"):
                title = None
        configured = publication_status()
        if any(not configured[target]["configured"] for target in targets if target != "elasticsearch"):
            return jsonify({"success": False, "message": "选中的上传目标尚未配置"}), 400
        changed = title is not None or publication != value.get("publicationStatus", "draft") or access != value.get("access", "public")
        if changed:
            # A failed attempt may still have uploaded files or committed remotely.
            previous_targets = set(value.get("publish", {})) - {"elasticsearch"}
            if previous_targets - set(targets):
                return jsonify({"success": False, "message": "修改状态时，请同时选择此前已上传的目标，以同步所有副本"}), 400
            try:
                update_publication(Path(value["outputDirectory"]), publication, access, **({"title": title} if title is not None else {}))
                if title is not None:
                    value["report"] = json.loads((Path(value["outputDirectory"]) / "report.json").read_text(encoding="utf-8"))
            except Exception as exc:
                return jsonify({"success": False, "message": f"保存发布设置失败：{exc}"}), 500
        for target in targets:
            previous = value.setdefault("publish", {}).get(target, {})
            successful = previous if previous.get("status") == "completed" else previous.get("lastSuccessful")
            value["publish"][target] = {"status": "pending", **({"lastSuccessful": successful} if successful else {})}
        value["publicationStatus"] = publication
        value["access"] = access
        value["status"] = "publishing"
        value["phase"] = "publishing"
        value["message"] = "发布设置已保存，正在上传"
        _save(value)
    threading.Thread(target=_publish, args=(job_id, targets), daemon=True).start()
    return jsonify({"success": True, "job": value})


def _publish(job_id: str, targets: list[str]) -> None:
    publishers = {
        "b2": publish_b2,
        "huggingface": publish_huggingface,
    }
    build_root = Path(_jobs[job_id]["outputDirectory"])
    failed = False
    for target in targets:
        try:
            with _lock:
                _jobs[job_id]["publish"][target]["status"] = "uploading"
            _set(job_id, message=f"正在发布到 {target}")
            if target == "elasticsearch":
                hf = _jobs[job_id]["publish"].get("huggingface", {})
                b2 = _jobs[job_id]["publish"].get("b2", {})
                if hf.get("status") != "completed" or b2.get("status") != "completed":
                    raise ValueError("请先完成 Hugging Face 和 B2 同步，再重试 ES")
                result = sync_publication(build_root, hf.get("result") or {}, lambda line: _log(job_id, f"[elasticsearch] {line}"))
            else:
                result = publishers[target](build_root, lambda line: _log(job_id, f"[{target}] {line}"))
            with _lock:
                _jobs[job_id].setdefault("publish", {})[target] = {
                    "status": "completed", "completedAt": _now(), "result": result,
                    "publicationStatus": _jobs[job_id].get("publicationStatus", "draft"),
                    "access": _jobs[job_id].get("access", "public"),
                    "librarySource": _jobs[job_id].get("librarySource", "jojo"),
                }
                _save(_jobs[job_id])
        except Exception as exc:
            failed = True
            _log(job_id, f"[{target}] {exc}")
            with _lock:
                _jobs[job_id]["publish"][target].update(
                    status="failed", failedAt=_now(), message=str(exc),
                )
                _save(_jobs[job_id])
    _set(
        job_id,
        status="publish-failed" if failed else "published",
        phase="complete" if not failed else "publish-failed",
        message="部分同步失败，可直接重试" if failed else "发布与检索同步完成",
    )
