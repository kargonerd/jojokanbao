"""Local Workbench routes for importing and publishing JOJO content."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import threading
import uuid

from flask import Blueprint, jsonify, request

from content_publish import (
    ROOT,
    publication_status,
    publish_b2,
    publish_elasticsearch,
    publish_huggingface,
)
from content_search import search_content


content_blueprint = Blueprint("content", __name__)
RUNTIME = Path(__file__).resolve().parent / ".runtime" / "content-jobs"
RUNTIME.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()
_jobs: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _save(job: dict) -> None:
    job["updatedAt"] = _now()
    directory = RUNTIME / job["jobId"]
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "state.json").write_text(
        json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8"
    )


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
            if job.get("status") in {"building", "publishing"}:
                job["status"] = "interrupted"
                job["message"] = "Workbench 重启中断了任务，可以重新导入或发布"
            _jobs[job["jobId"]] = job
        except Exception:
            continue


_load_jobs()


def _new_job(input_paths: list[str], fetch_assets: bool, job_id: str | None = None) -> dict:
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
    job = _set(job_id, status="building", phase="inspect", message="正在检查微信读书 JSON")
    pnpm = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"
    command = [pnpm, "--filter", "@jojo/content-pipeline", "cli"]
    for input_path in job["inputPaths"]:
        command.extend(["--input", input_path])
    command.extend(["--output", job["outputDirectory"], "--allow-partial"])
    if not job["fetchAssets"]:
        command.append("--no-assets")
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
        if code:
            raise RuntimeError(f"内容处理退出码 {code}")
        report_path = Path(job["outputDirectory"]) / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
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
        return jsonify({"success": True, "jobs": values[:20]})


@content_blueprint.get("/api/content/jobs/<job_id>")
def job(job_id: str):
    with _lock:
        value = _jobs.get(job_id)
        if not value:
            return jsonify({"success": False, "message": "任务不存在"}), 404
        return jsonify({"success": True, "job": value})


@content_blueprint.post("/api/content/import-paths")
def import_paths():
    data = request.get_json(silent=True) or {}
    supplied = data.get("paths") or []
    if isinstance(supplied, str):
        supplied = [supplied]
    paths: list[str] = []
    for raw_path in supplied:
        value = Path(str(raw_path)).expanduser().resolve()
        if value.is_dir():
            paths.extend(str(item) for item in sorted(value.glob("*.json")) if item.is_file())
        elif value.is_file() and value.suffix.lower() == ".json":
            paths.append(str(value))
    paths = list(dict.fromkeys(paths))
    if not paths:
        return jsonify({"success": False, "message": "没有找到 JSON 文件"}), 400
    return jsonify({"success": True, "job": _new_job(paths, bool(data.get("fetchAssets", True)))})


@content_blueprint.post("/api/content/import-files")
def import_files():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"success": False, "message": "没有上传文件"}), 400
    job_id = uuid.uuid4().hex[:16]
    upload_root = RUNTIME / job_id / "input"
    upload_root.mkdir(parents=True, exist_ok=True)
    input_paths = []
    for index, file in enumerate(files, 1):
        if not file.filename or not file.filename.lower().endswith(".json"):
            continue
        target = upload_root / f"{index:04d}.json"
        file.save(target)
        input_paths.append(str(target))
    if not input_paths:
        shutil.rmtree(RUNTIME / job_id, ignore_errors=True)
        return jsonify({"success": False, "message": "只支持 JSON 文件"}), 400
    # _new_job allocates its own durable identifier; uploaded files remain valid inputs.
    return jsonify({"success": True, "job": _new_job(
        input_paths,
        request.form.get("fetchAssets", "true").lower() != "false",
        job_id=job_id,
    )})


@content_blueprint.post("/api/content/jobs/<job_id>/publish")
def publish(job_id: str):
    data = request.get_json(silent=True) or {}
    targets = [name for name in ("b2", "elasticsearch", "huggingface") if name in (data.get("targets") or [])]
    with _lock:
        value = _jobs.get(job_id)
        if not value:
            return jsonify({"success": False, "message": "任务不存在"}), 404
        if value["status"] not in {"ready", "published", "publish-failed"}:
            return jsonify({"success": False, "message": "任务尚未生成可发布内容"}), 409
        if not targets:
            return jsonify({"success": False, "message": "至少选择一个发布目标"}), 400
        value["status"] = "publishing"
        value["phase"] = "publishing"
        value["message"] = "正在发布"
        _save(value)
    threading.Thread(target=_publish, args=(job_id, targets), daemon=True).start()
    return jsonify({"success": True, "job": value})


def _publish(job_id: str, targets: list[str]) -> None:
    publishers = {
        "b2": publish_b2,
        "elasticsearch": publish_elasticsearch,
        "huggingface": publish_huggingface,
    }
    build_root = Path(_jobs[job_id]["outputDirectory"])
    failed = False
    for target in targets:
        try:
            _set(job_id, message=f"正在发布到 {target}")
            result = publishers[target](build_root, lambda line: _log(job_id, f"[{target}] {line}"))
            with _lock:
                _jobs[job_id].setdefault("publish", {})[target] = {
                    "status": "completed", "completedAt": _now(), "result": result
                }
                _save(_jobs[job_id])
        except Exception as exc:
            failed = True
            _log(job_id, f"[{target}] {exc}")
            with _lock:
                _jobs[job_id].setdefault("publish", {})[target] = {
                    "status": "failed", "completedAt": _now(), "message": str(exc)
                }
                _save(_jobs[job_id])
    _set(
        job_id,
        status="publish-failed" if failed else "published",
        phase="complete" if not failed else "publish-failed",
        message="部分发布失败，可直接重试" if failed else "所有选定目标发布完成",
    )
