"""Resumable publication state machine for Canonical-derived content.

Hugging Face Canonical is the only fact commit.  Every other destination is a
derived projection and therefore runs after the Canonical commit in a fixed
order.  A failed derived stage is retried without rewriting an already
successful Canonical commit.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping


RELEASE_STAGES = ("canonical", "delivery", "search", "activation")
StageHandler = Callable[[dict[str, Any]], dict[str, Any]]
ProgressHandler = Callable[[str, str, int], None]


def release_id(payload: Mapping[str, Any]) -> str:
    """Return the stable ID of one desired Canonical change set."""
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "release-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


class ReleaseJournal:
    """One atomic local execution receipt; never a source of content truth."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any] | None:
        if not self.path.is_file():
            return None
        return json.loads(self.path.read_text(encoding="utf-8"))

    def create(
        self,
        *,
        identifier: str,
        scope: str,
        desired: Mapping[str, Any],
    ) -> dict[str, Any]:
        existing = self.load()
        if existing is not None:
            if existing.get("releaseId") != identifier:
                if existing.get("status") != "succeeded":
                    raise ValueError(
                        f"另一个发布 {existing.get('releaseId')} 尚未完成，必须先续跑"
                    )
                existing = None
            else:
                return existing
        now = _now()
        state: dict[str, Any] = {
            "formatVersion": "jojo-canonical-release/1",
            "releaseId": identifier,
            "scope": scope,
            "status": "pending",
            "desired": json.loads(json.dumps(desired, ensure_ascii=False)),
            "createdAt": now,
            "updatedAt": now,
            "stages": {
                name: {"status": "pending", "attempts": 0}
                for name in RELEASE_STAGES
            },
        }
        self.save(state)
        return state

    def save(self, state: dict[str, Any]) -> None:
        state["updatedAt"] = _now()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)


class MirroredReleaseJournal(ReleaseJournal):
    """Mirror the current receipt remotely so another workstation can resume."""

    def __init__(
        self,
        path: Path,
        *,
        remote_loader: Callable[[], dict[str, Any] | None],
        remote_saver: Callable[[dict[str, Any]], None],
    ) -> None:
        super().__init__(path)
        self.remote_loader = remote_loader
        self.remote_saver = remote_saver

    def load(self) -> dict[str, Any] | None:
        local = super().load()
        if local is not None:
            return local
        remote = self.remote_loader()
        if remote is not None:
            ReleaseJournal.save(self, remote)
        return remote

    def save(self, state: dict[str, Any]) -> None:
        super().save(state)
        self.remote_saver(state)


class CanonicalRelease:
    """Execute all release stages in dependency order and resume safely."""

    def __init__(
        self,
        journal: ReleaseJournal,
        handlers: Mapping[str, StageHandler],
        *,
        on_progress: ProgressHandler | None = None,
    ) -> None:
        missing = [stage for stage in RELEASE_STAGES if stage not in handlers]
        if missing:
            raise ValueError("发布处理器不完整：" + ", ".join(missing))
        self.journal = journal
        self.handlers = handlers
        self.on_progress = on_progress

    def run(
        self,
        *,
        identifier: str,
        scope: str,
        desired: Mapping[str, Any],
    ) -> dict[str, Any]:
        state = self.journal.create(
            identifier=identifier,
            scope=scope,
            desired=desired,
        )
        if state.get("desired") != json.loads(json.dumps(desired, ensure_ascii=False)):
            raise ValueError("相同 releaseId 对应了不同发布内容")

        state["status"] = "running"
        state.pop("finishedAt", None)
        self.journal.save(state)
        for position, stage_name in enumerate(RELEASE_STAGES):
            stage = state["stages"][stage_name]
            if stage.get("status") == "succeeded":
                self._progress(stage_name, "已完成，跳过", _percent(position + 1))
                continue
            if any(
                state["stages"][dependency].get("status") != "succeeded"
                for dependency in RELEASE_STAGES[:position]
            ):
                raise RuntimeError(f"发布阶段依赖未完成：{stage_name}")

            stage.update({
                "status": "running",
                "attempts": int(stage.get("attempts") or 0) + 1,
                "startedAt": _now(),
            })
            stage.pop("error", None)
            self.journal.save(state)
            self._progress(stage_name, "正在执行", _percent(position))
            try:
                result = self.handlers[stage_name](state)
            except Exception as error:
                stage.update({
                    "status": "failed",
                    "error": str(error),
                    "finishedAt": _now(),
                })
                state["status"] = "failed"
                state["failedStage"] = stage_name
                state["finishedAt"] = _now()
                self.journal.save(state)
                self._progress(stage_name, f"失败：{error}", _percent(position))
                raise
            stage.update({
                "status": "succeeded",
                "result": result,
                "finishedAt": _now(),
            })
            self.journal.save(state)
            self._progress(stage_name, "已完成", _percent(position + 1))

        state["status"] = "succeeded"
        state.pop("failedStage", None)
        state["finishedAt"] = _now()
        self.journal.save(state)
        return state

    def _progress(self, stage: str, message: str, percent: int) -> None:
        if self.on_progress:
            self.on_progress(stage, message, percent)


def _percent(completed_stages: int) -> int:
    # Leave room before the first stage for deterministic planning.
    return 10 + round(90 * completed_stages / len(RELEASE_STAGES))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
