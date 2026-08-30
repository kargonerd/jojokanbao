"""Build and safely deploy the JOJO Reader Search Tencent SCF package.

The command always builds from the checked-out source.  Staging is the normal
target.  Production additionally requires an explicit confirmation flag and a
healthy staging function running the same source fingerprint.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence
from urllib.error import URLError
from urllib.request import urlopen
import zipfile


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
RUNTIME_FILES = (
    "app.py",
    "migration_exclusions.py",
    "requirements.txt",
    "scf_bootstrap",
    "search_overlay.py",
    "search_state.py",
)
DEFAULTS = {
    "region": "ap-beijing",
    "namespace": "default",
    "bucket": "jojo-search-1314955862",
    "staging_function": "flask_jojo_search_staging",
    "production_function": "flask_jojo_search",
    "staging_health": "https://1314955862-bezv90udhs.ap-beijing.tencentscf.com/health",
    "production_health": "https://s1.jojokanbao.cn/health",
}


def _linux_newlines(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _run(command: Sequence[str], *, capture: bool = True) -> str:
    try:
        result = subprocess.run(
            list(command),
            check=True,
            text=True,
            capture_output=capture,
        )
    except subprocess.CalledProcessError as exc:
        detail = str(exc.stderr or exc.stdout or "").strip()
        raise RuntimeError(
            f"命令执行失败（exit {exc.returncode}）：{Path(command[0]).name}"
            + (f"\n{detail}" if detail else "")
        ) from exc
    return result.stdout.strip() if capture else ""


def _tccli(profile: str, service: str, action: str, *arguments: str) -> list[str]:
    executable = shutil.which("tccli")
    if not executable:
        raise RuntimeError("未找到 tccli；请先安装并执行 tccli auth login")
    command = [executable, service, action, *arguments]
    if profile:
        command.extend(["--profile", profile])
    return command


def _git_commit() -> str:
    try:
        return _run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"])
    except (OSError, RuntimeError):
        return "unknown"


def source_fingerprint(source: Path = HERE) -> str:
    digest = hashlib.sha256()
    for name in RUNTIME_FILES:
        path = source / name
        digest.update(name.encode("utf-8"))
        data = path.read_bytes()
        if name == "scf_bootstrap":
            data = _linux_newlines(data)
        digest.update(data)
    return digest.hexdigest()


def _copy_runtime(source: Path, target: Path) -> None:
    for name in RUNTIME_FILES:
        destination = target / name
        shutil.copy2(source / name, destination)
        if name == "scf_bootstrap":
            destination.write_bytes(_linux_newlines(destination.read_bytes()))
            destination.chmod(0o755)


def _prune_package(package: Path) -> None:
    for path in sorted(package.rglob("__pycache__"), reverse=True):
        shutil.rmtree(path, ignore_errors=True)
    for pattern in ("*.pyc", "*.pyo", "*.pyd"):
        for path in package.rglob(pattern):
            path.unlink(missing_ok=True)
    shutil.rmtree(package / "bin", ignore_errors=True)


def _annotation_uses_runtime_union(annotation: ast.expr | None) -> bool:
    return bool(annotation) and any(
        isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr)
        for node in ast.walk(annotation)
    )


def _verify_python39(package: Path) -> None:
    """Reject syntax and evaluated annotations that cannot start on Python 3.9."""
    for path in sorted(package.rglob("*.py")):
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path), feature_version=(3, 9))
        except (UnicodeDecodeError, SyntaxError) as exc:
            raise RuntimeError(f"SCF Python 3.9 不兼容：{path.relative_to(package)}：{exc}") from exc
        future_annotations = any(
            isinstance(node, ast.ImportFrom)
            and node.module == "__future__"
            and any(alias.name == "annotations" for alias in node.names)
            for node in tree.body
        )
        if future_annotations:
            continue
        annotations: list[ast.expr | None] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                annotations.extend(argument.annotation for argument in (
                    *node.args.posonlyargs,
                    *node.args.args,
                    *node.args.kwonlyargs,
                ))
                if node.args.vararg:
                    annotations.append(node.args.vararg.annotation)
                if node.args.kwarg:
                    annotations.append(node.args.kwarg.annotation)
                annotations.append(node.returns)
            elif isinstance(node, ast.AnnAssign):
                annotations.append(node.annotation)
        if any(_annotation_uses_runtime_union(annotation) for annotation in annotations):
            raise RuntimeError(
                "SCF Python 3.9 不兼容："
                f"{path.relative_to(package)} 使用了未延迟求值的 X | Y 类型注解"
            )


def _write_zip(package: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(package.rglob("*")):
            if not path.is_file():
                continue
            name = path.relative_to(package).as_posix()
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if name == "scf_bootstrap" else 0o644) << 16
            archive.writestr(info, path.read_bytes())


def build_package(
    output: Path,
    *,
    source: Path = HERE,
    install_dependencies: bool = True,
) -> dict[str, str | int]:
    fingerprint = source_fingerprint(source)
    with tempfile.TemporaryDirectory(prefix="jojo-search-scf-") as temp:
        package = Path(temp) / "package"
        package.mkdir()
        if install_dependencies:
            _run([
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-compile",
                "--target",
                str(package),
                "-r",
                str(source / "requirements.txt"),
            ])
        _copy_runtime(source, package)
        with (package / "build_info.json").open(
            "w", encoding="utf-8", newline="\n"
        ) as stream:
            stream.write(
                json.dumps(
                    {
                        "gitCommit": _git_commit(),
                        "sourceFingerprint": fingerprint,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ) + "\n"
            )
        _prune_package(package)
        _verify_python39(package)
        _write_zip(package, output)
    return {
        "path": str(output),
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "gitCommit": _git_commit(),
        "sourceFingerprint": fingerprint,
    }


def run_unit_tests(source: Path = HERE) -> None:
    _run([
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        str(source / "tests"),
        "-p",
        "test_*.py",
    ], capture=False)


def _json_command(command: Sequence[str]) -> dict[str, Any]:
    prepared = list(command)
    if "--output" not in prepared:
        prepared.extend(["--output", "json"])
    payload = json.loads(_run(prepared) or "{}")
    response = payload.get("Response")
    return response if isinstance(response, dict) else payload


def _health(
    url: str,
    *,
    attempts: int = 20,
    expected_fingerprint: str | None = None,
) -> dict[str, Any]:
    error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urlopen(url, timeout=15) as response:  # noqa: S310 - fixed operator URL
                payload = json.loads(response.read().decode("utf-8"))
            actual = str((payload.get("build") or {}).get("sourceFingerprint") or "")
            if payload.get("status") == "ok" and (
                expected_fingerprint is None or actual == expected_fingerprint
            ):
                return payload
            error = RuntimeError(
                f"health 尚未切换到目标版本：status={payload.get('status')} "
                f"fingerprint={actual[:12] or 'missing'}"
            )
        except (OSError, URLError, ValueError) as exc:
            error = exc
        if attempt + 1 < attempts:
            time.sleep(3)
    raise RuntimeError(f"健康检查失败：{url}：{error}")


def _wait_for_function(
    function: str,
    *,
    region: str,
    namespace: str,
    profile: str,
    attempts: int = 30,
) -> None:
    for attempt in range(attempts):
        response = _json_command(_tccli(
            profile,
            "scf",
            "GetFunction",
            "--FunctionName",
            function,
            "--Namespace",
            namespace,
            "--region",
            region,
        ))
        status = str(response.get("Status") or "")
        available = str(response.get("AvailableStatus") or "")
        if status.lower() in {"failed", "error"}:
            raise RuntimeError(f"SCF 更新失败：{response.get('StatusDesc') or status}")
        if status == "Active" and available in {"", "Available"}:
            return
        if attempt + 1 < attempts:
            time.sleep(4)
    raise RuntimeError(f"SCF 长时间未恢复 Active：{function}")


def _upload(package: Path, *, bucket: str, region: str, key: str, profile: str) -> None:
    _run(_tccli(
        profile,
        "cos",
        "upload",
        "--bucket",
        bucket,
        "--region",
        region,
        "--local_path",
        str(package),
        "--cos_key",
        key,
        "--content_type",
        "application/zip",
    ))


def _delete_upload(*, bucket: str, region: str, key: str, profile: str) -> None:
    _run(_tccli(
        profile,
        "cos",
        "delete",
        "--bucket",
        bucket,
        "--region",
        region,
        "--cos_key",
        key,
    ))


def _update_function(
    function: str,
    *,
    bucket: str,
    region: str,
    namespace: str,
    key: str,
    profile: str,
) -> None:
    custom_bucket = bucket.rsplit("-", 1)[0]
    _json_command(_tccli(
        profile,
        "scf",
        "UpdateFunctionCode",
        "--FunctionName",
        function,
        "--Namespace",
        namespace,
        "--CodeSource",
        "Cos",
        "--CosBucketName",
        custom_bucket,
        "--CosBucketRegion",
        region,
        "--CosObjectName",
        "/" + key.lstrip("/"),
        "--Handler",
        "app.app",
        "--region",
        region,
    ))
    _wait_for_function(
        function,
        region=region,
        namespace=namespace,
        profile=profile,
    )


def _require_staging_revision(url: str, fingerprint: str) -> None:
    try:
        _health(url, attempts=1, expected_fingerprint=fingerprint)
    except RuntimeError as exc:
        raise RuntimeError(
            "生产发布已拒绝：staging 运行的不是当前源码。"
            f" expected={fingerprint[:12]}"
        ) from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("staging", "production"), default="staging")
    parser.add_argument("--confirm-production", action="store_true")
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--region", default=DEFAULTS["region"])
    parser.add_argument("--namespace", default=DEFAULTS["namespace"])
    parser.add_argument("--bucket", default=DEFAULTS["bucket"])
    parser.add_argument("--profile", default=os.getenv("TENCENTCLOUD_PROFILE", ""))
    parser.add_argument("--staging-function", default=DEFAULTS["staging_function"])
    parser.add_argument("--production-function", default=DEFAULTS["production_function"])
    parser.add_argument("--staging-health", default=DEFAULTS["staging_health"])
    parser.add_argument("--production-health", default=DEFAULTS["production_health"])
    args = parser.parse_args()

    if args.target == "production" and not args.confirm_production:
        parser.error("生产发布必须显式传入 --confirm-production")

    print("运行 Reader Search SCF 测试")
    run_unit_tests()
    fingerprint = source_fingerprint()
    output = args.output or (
        REPO_ROOT / ".runtime" / "scf-builds" / f"jojo-search-{fingerprint[:12]}.zip"
    )
    result = build_package(output)
    print(json.dumps({"build": result}, ensure_ascii=False))
    if args.build_only:
        return 0

    if args.target == "production":
        _require_staging_revision(args.staging_health, fingerprint)

    function = (
        args.production_function if args.target == "production" else args.staging_function
    )
    health_url = args.production_health if args.target == "production" else args.staging_health
    key = f"runtime/scf-builds/{fingerprint[:12]}.zip"
    uploaded = False
    try:
        print(f"上传代码包：cos://{args.bucket}/{key}")
        _upload(output, bucket=args.bucket, region=args.region, key=key, profile=args.profile)
        uploaded = True
        print(f"更新 SCF：{function}")
        _update_function(
            function,
            bucket=args.bucket,
            region=args.region,
            namespace=args.namespace,
            key=key,
            profile=args.profile,
        )
        health = _health(health_url, expected_fingerprint=fingerprint)
        print(json.dumps({"deployed": function, "health": health}, ensure_ascii=False))
    finally:
        if uploaded:
            try:
                _delete_upload(
                    bucket=args.bucket,
                    region=args.region,
                    key=key,
                    profile=args.profile,
                )
            except Exception as exc:  # Deployment result stays authoritative.
                print(f"警告：临时代码包清理失败：{exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
