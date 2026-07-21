"""MinerU import and markdown proofreading CLI."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import requests
from PyPDF2 import PdfReader, PdfWriter
from requests import Response
from requests.exceptions import RequestException

try:
    from cos_manager import get_cos_manager, get_source_pdf_key
    from notebook_service import (
        bind_source_document,
        normalize_markdown,
        replace_asset_urls,
        upload_source_asset,
    )
except ImportError:  # pragma: no cover
    from app.rag.cos_manager import get_cos_manager, get_source_pdf_key
    from app.rag.notebook_service import (
        bind_source_document,
        normalize_markdown,
        replace_asset_urls,
        upload_source_asset,
    )


IMAGE_LINK_RE = re.compile(r"!\[[^\]]*]\(([^)]+)\)")
STATUS_SUCCESS = {"success", "succeeded", "done", "completed", "finish", "finished"}
STATUS_FAILED = {"failed", "error", "canceled", "cancelled", "timeout"}
REQUEST_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
PAGE_NUMBER_RE = re.compile(r"^\s*(?:\u7b2c\s*)?(?P<page>\d(?:[\d ]{0,7}\d)?)\s*(?:\u9875|\u9801)?\s*$")
PAGE_NUMBER_DECORATED_RE = re.compile(r"^\s*[-\u2014\u2013\u00b7\u2022*]*\s*(?P<page>\d(?:[\d ]{0,7}\d)?)\s*[-\u2014\u2013\u00b7\u2022*]*\s*$")
TOC_TITLE_FIRST_RE = re.compile(
    r"^(?P<title>.+?)(?:\s?[.\u00b7\u2022\u2026]{2,}\s?|\s{2,})(?P<page>\d(?:[\d ]{0,7}\d)?)$"
)
TOC_PAGE_FIRST_RE = re.compile(r"^(?P<page>\d(?:[\d ]{0,7}\d)?)\s+(?P<title>.+)$")
CHAPTER_HEADING_RE = re.compile(r"^\u7b2c[\u4e00-\u9fff0-9]+[\u5377\u7ae0\u8282\u7bc0\u7f16\u7de8\u90e8\u7bc7]\s*.*$")
SECTION_HEADING_RE = re.compile(r"^[\u4e00-\u9fff0-9]+[\u3001.\uff0e]\s*.+$")
SUBSECTION_HEADING_RE = re.compile(r"^[\uff08(][\u4e00-\u9fff0-9]+[)\uff09]\s*.+$")
FOOTNOTE_RE = re.compile(
    r"^(?P<marker>\[\d+\]|\d+[.)]|[\u2460-\u2473])\s*(?P<text>.+)$"
)
TITLE_CANDIDATE_RE = re.compile(r"^[A-Za-z0-9\u4e00-\u9fff\u300a\u300b\u3008\u3009\uff08\uff09()\u00b7\-\s]{6,140}$")
CONTROL_LINE_RE = re.compile(r"^(\u76ee\u5f55|\u76ee\u9304|\u76ee\u6b21|\u6ce8\u91ca|\u8a3b\u91cb|\u811a\u6ce8|\u8173\u8a3b|\u9644\u5f55|\u9644\u9304|\u540e\u8bb0|\u5f8c\u8a18|\u8dcb)$")
FULLWIDTH_DIGIT_MAP = str.maketrans("\uff10\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18\uff19", "0123456789")
CIRCLED_DIGITS = {str(chr(code)): str(index) for index, code in enumerate(range(0x2460, 0x2474), start=1)}

def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_local_path(raw_path: str) -> Path:
    if raw_path.startswith("file:///"):
        parsed = urlparse(raw_path)
        return Path(unquote(parsed.path.lstrip("/"))).resolve()
    return Path(raw_path).expanduser().resolve()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", value).strip("-")
    return normalized[:80] or hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def stable_suffix(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def _deep_get(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _extract_task_id(payload: dict[str, Any]) -> str | None:
    candidates = [
        payload.get("task_id"),
        payload.get("id"),
        _deep_get(payload, "data", "task_id"),
        _deep_get(payload, "data", "id"),
        _deep_get(payload, "result", "task_id"),
        _deep_get(payload, "result", "id"),
    ]
    for item in candidates:
        if item:
            return str(item)
    return None


def _extract_status(payload: dict[str, Any]) -> str:
    status = (
        payload.get("status")
        or payload.get("state")
        or _deep_get(payload, "data", "status")
        or _deep_get(payload, "data", "state")
        or _deep_get(payload, "result", "status")
        or _deep_get(payload, "result", "state")
        or ""
    )
    return str(status).strip().lower()


def _extract_full_zip_url(payload: dict[str, Any]) -> str | None:
    candidates = [
        payload.get("full_zip_url"),
        payload.get("zip_url"),
        payload.get("download_url"),
        _deep_get(payload, "data", "full_zip_url"),
        _deep_get(payload, "data", "zip_url"),
        _deep_get(payload, "data", "download_url"),
        _deep_get(payload, "result", "full_zip_url"),
        _deep_get(payload, "result", "zip_url"),
        _deep_get(payload, "result", "download_url"),
    ]
    for item in candidates:
        if item:
            return str(item)
    return None


def request_with_retry(
    method: str,
    url: str,
    *,
    attempts: int = 5,
    backoff_seconds: float = 2.0,
    retryable_statuses: set[int] | None = None,
    **kwargs: Any,
) -> Response:
    retryable = retryable_statuses or REQUEST_RETRYABLE_STATUS
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            response = requests.request(method, url, **kwargs)
            if response.status_code in retryable and attempt < attempts:
                snippet = response.text[:300]
                print(
                    f"[HTTP] retry {attempt}/{attempts} for {method.upper()} {url} "
                    f"after status={response.status_code}: {snippet}"
                )
                time.sleep(backoff_seconds * attempt)
                continue
            return response
        except RequestException as exc:
            last_error = exc
            if attempt >= attempts:
                break
            print(f"[HTTP] retry {attempt}/{attempts} for {method.upper()} {url}: {exc}")
            time.sleep(backoff_seconds * attempt)

    if last_error:
        raise last_error
    raise RuntimeError(f"Request failed without response: {method.upper()} {url}")


def build_mineru_task_payloads(file_url: str, options: dict[str, Any]) -> list[dict[str, Any]]:
    payloads = [
        {"url": file_url},
        {"file_url": file_url},
        {"files": [file_url]},
        {"files": [{"url": file_url}]},
        {"extract_source": [{"url": file_url}]},
    ]
    merged_payloads: list[dict[str, Any]] = []
    for payload in payloads:
        merged = dict(options)
        merged.update(payload)
        merged_payloads.append(merged)
    return merged_payloads


def submit_mineru_task(api_base: str, token: str, file_url: str, options: dict[str, Any]) -> str:
    endpoint = f"{api_base.rstrip('/')}/extract/task"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payloads = build_mineru_task_payloads(file_url, options)
    errors: list[str] = []

    for payload in payloads:
        response = request_with_retry("POST", endpoint, headers=headers, json=payload, timeout=45)
        text = response.text[:500]
        if response.status_code >= 300:
            errors.append(f"{payload}: HTTP {response.status_code} {text}")
            continue
        try:
            data = response.json()
        except Exception as exc:
            errors.append(f"{payload}: invalid JSON ({exc})")
            continue
        task_id = _extract_task_id(data)
        if task_id:
            return task_id
        errors.append(f"{payload}: no task_id in {json.dumps(data, ensure_ascii=False)[:500]}")

    raise RuntimeError("Failed to submit MinerU task:\n" + "\n".join(errors))


def wait_mineru_result(api_base: str, token: str, task_id: str, poll_interval: int, timeout_seconds: int) -> str:
    endpoint = f"{api_base.rstrip('/')}/extract/task/{task_id}"
    headers = {"Authorization": f"Bearer {token}"}
    started = time.time()

    while True:
        if time.time() - started > timeout_seconds:
            raise TimeoutError(f"MinerU task timeout: {task_id}")

        response = request_with_retry("GET", endpoint, headers=headers, timeout=30, attempts=8, backoff_seconds=1.5)
        response.raise_for_status()
        payload = response.json()
        status = _extract_status(payload)
        full_zip_url = _extract_full_zip_url(payload)

        if full_zip_url and (not status or status in STATUS_SUCCESS):
            return full_zip_url
        if status in STATUS_FAILED:
            raise RuntimeError(f"MinerU task failed: {status}, payload={json.dumps(payload, ensure_ascii=False)}")

        print(f"[MinerU] task={task_id} status={status or 'processing'}")
        time.sleep(poll_interval)


def download_zip(url: str, output_path: Path) -> None:
    with request_with_retry("GET", url, stream=True, timeout=180, attempts=6, backoff_seconds=2.0) as response:
        response.raise_for_status()
        with output_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 64):
                if chunk:
                    handle.write(chunk)


def find_main_markdown(extract_dir: Path) -> Path:
    candidates = list(extract_dir.rglob("full.md"))
    if candidates:
        return candidates[0]
    all_md = list(extract_dir.rglob("*.md"))
    if not all_md:
        raise FileNotFoundError("No markdown found in MinerU zip output")
    return sorted(all_md, key=lambda path: (len(path.parts), path.name))[0]


def upload_markdown_assets(
    notebook_id: str,
    source_id: str,
    markdown_path: Path,
    markdown_text: str,
    asset_prefix: str = "",
) -> tuple[str, list[dict[str, Any]]]:
    manifest: list[dict[str, Any]] = []
    links = sorted(set(IMAGE_LINK_RE.findall(markdown_text)))

    for link in links:
        if not link or link.startswith("data:"):
            continue

        file_bytes: bytes | None = None
        filename: str | None = None
        source_url = link

        if link.startswith("http://") or link.startswith("https://"):
            response = request_with_retry("GET", link, timeout=60, attempts=4, backoff_seconds=1.5)
            if response.status_code >= 300:
                print(f"[WARN] skip remote asset: {link} (HTTP {response.status_code})")
                continue
            file_bytes = response.content
            filename = Path(link.split("?", 1)[0]).name or "asset.bin"
        else:
            local_path = (markdown_path.parent / link).resolve()
            if not local_path.exists():
                print(f"[WARN] skip missing local asset: {link}")
                continue
            file_bytes = local_path.read_bytes()
            filename = local_path.name

        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        upload_name = f"{asset_prefix}{filename}" if asset_prefix else filename
        uploaded = upload_source_asset(notebook_id, source_id, upload_name, file_bytes, content_type)
        manifest.append(
            {
                "filename": uploaded["filename"],
                "key": uploaded["key"],
                "url": uploaded["url"],
                "original_url": source_url,
            }
        )
        print(f"[COS] asset uploaded: {source_url} -> {uploaded['url']}")

    rewritten = replace_asset_urls(markdown_text, manifest)
    return rewritten, manifest


def copy_local_assets(
    markdown_path: Path,
    markdown_text: str,
    output_dir: Path,
    asset_prefix: str = "",
) -> tuple[str, list[dict[str, Any]]]:
    assets_dir = output_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    rewritten = markdown_text

    for link in sorted(set(IMAGE_LINK_RE.findall(markdown_text))):
        if not link or link.startswith("http://") or link.startswith("https://") or link.startswith("data:"):
            continue
        local_path = (markdown_path.parent / link).resolve()
        if not local_path.exists():
            print(f"[WARN] skip missing local asset: {link}")
            continue
        target = assets_dir / f"{asset_prefix}{local_path.name}"
        if not target.exists():
            shutil.copy2(local_path, target)
        relative = f"assets/{target.name}"
        rewritten = rewritten.replace(link, relative)
        manifest.append({"original_url": link, "url": relative, "filename": target.name})

    return rewritten, manifest


def clean_inline_spacing(text: str) -> str:
    text = text.translate(FULLWIDTH_DIGIT_MAP)
    text = text.replace("\u3000", " ").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def compact_digits(text: str) -> str:
    return re.sub(r"\s+", "", clean_inline_spacing(text))


def normalize_toc_page(page: str) -> str:
    return compact_digits(page)


def is_page_number_line(line: str) -> bool:
    stripped = clean_inline_spacing(line)
    if not stripped:
        return False
    if PAGE_NUMBER_RE.match(stripped) or PAGE_NUMBER_DECORATED_RE.match(stripped):
        digits = compact_digits(stripped.replace("\u9875", "").replace("\u9801", "").replace("\u7b2c", ""))
        return digits.isdigit() and 1 <= len(digits) <= 4
    return False


def looks_like_title_candidate(line: str) -> bool:
    stripped = clean_inline_spacing(line)
    if not stripped or stripped.startswith("#"):
        return False
    if len(stripped) < 8 or len(stripped) > 140:
        return False
    if CONTROL_LINE_RE.match(stripped):
        return False
    return bool(TITLE_CANDIDATE_RE.match(stripped))


def normalize_footnote_marker(marker: str) -> str:
    marker = marker.strip()
    if marker in CIRCLED_DIGITS:
        return CIRCLED_DIGITS[marker]
    if marker.startswith("[") and marker.endswith("]"):
        return marker[1:-1]
    return re.sub(r"\D+", "", marker) or marker


def cleanup_front_matter(markdown_text: str) -> str:
    lines = markdown_text.splitlines()
    toc_index = next(
        (idx for idx, line in enumerate(lines[:250]) if line.strip() in {"## 目录", "## 目錄", "## 目次"}),
        None,
    )
    if toc_index is None:
        return markdown_text

    keep_until = None
    for idx, line in enumerate(lines[: min(toc_index, 40)]):
        if line.startswith("![]("):
            keep_until = idx

    if keep_until is not None and toc_index - keep_until > 8:
        lines = lines[: keep_until + 1] + [""] + lines[toc_index:]

    cleaned: list[str] = []
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if idx < 80:
            if stripped in {"# I I", "# II", "n"}:
                continue
            if stripped.startswith("# OX FO R D") or stripped.startswith("Oxford University Press"):
                continue
            if stripped.startswith("Published in Hong Kong by Oxford University Press"):
                continue
            if stripped.startswith("All rights re served"):
                continue
            if stripped.startswith("You mu s t n o t circulate"):
                continue
            if re.fullmatch(r"(?:\d\s+){4,}\d", stripped):
                continue
            if re.fullmatch(r"97[\d\- ]+", stripped):
                continue
        cleaned.append(line)

    return "\n".join(cleaned).strip() + "\n"


def proofread_markdown(markdown_text: str, title: str | None = None) -> tuple[str, dict[str, Any]]:
    text = markdown_text.replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    raw_lines = [line.rstrip() for line in text.split("\n")]
    report = {
        "removed_page_number_lines": 0,
        "promoted_headings": 0,
        "formatted_toc_lines": 0,
        "normalized_footnotes": 0,
        "inserted_title": False,
        "collapsed_blank_runs": 0,
    }

    processed: list[str] = []
    pending_footnote_index: int | None = None
    in_toc = False

    for raw_line in raw_lines:
        line = clean_inline_spacing(raw_line)
        if is_page_number_line(line):
            report["removed_page_number_lines"] += 1
            continue

        if not line:
            if processed and processed[-1] == "":
                report["collapsed_blank_runs"] += 1
                continue
            processed.append("")
            pending_footnote_index = None
            continue

        control_token = line.lstrip("#").strip().replace(" ", "")
        heading_text = line.lstrip("#").strip()

        if control_token in {"\u76ee\u5f55", "\u76ee\u9304", "\u76ee\u6b21"} or (control_token.startswith("\u76ee") and len(control_token) <= 3):
            processed.append("## \u76ee\u5f55")
            in_toc = True
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue

        if control_token in {"\u6ce8\u91ca", "\u8a3b\u91cb", "\u811a\u6ce8", "\u8173\u8a3b"}:
            processed.append("## \u6ce8\u91ca")
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue

        toc_match = TOC_TITLE_FIRST_RE.match(line) or (TOC_PAGE_FIRST_RE.match(line) if in_toc else None)
        if in_toc and toc_match:
            title_text = clean_inline_spacing(toc_match.group("title"))
            page_text = normalize_toc_page(toc_match.group("page"))
            if title_text and page_text.isdigit():
                processed.append(f"- {title_text} \u2026\u2026 {page_text}")
                report["formatted_toc_lines"] += 1
                pending_footnote_index = None
                continue


        footnote_match = FOOTNOTE_RE.match(line)
        if footnote_match:
            marker = normalize_footnote_marker(footnote_match.group("marker"))
            processed.append(f"[^{marker}]: {footnote_match.group('text').strip()}")
            pending_footnote_index = len(processed) - 1
            report["normalized_footnotes"] += 1
            continue

        if pending_footnote_index is not None and not CHAPTER_HEADING_RE.match(line) and not SECTION_HEADING_RE.match(line):
            processed[pending_footnote_index] += f" {line}"
            continue

        normalized_heading = heading_text.lstrip("-").strip()

        if CHAPTER_HEADING_RE.match(heading_text):
            processed.append(f"{'###' if in_toc else '##'} {heading_text}")
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue
        if SECTION_HEADING_RE.match(normalized_heading):
            processed.append(f"{'####' if in_toc else '###'} {normalized_heading}")
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue
        if SUBSECTION_HEADING_RE.match(normalized_heading):
            processed.append(f"{'#####' if in_toc else '####'} {normalized_heading}")
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue

        if in_toc and line.startswith("#"):
            processed.append(f"#### {normalized_heading}")
            report["promoted_headings"] += 1
            pending_footnote_index = None
            continue

        heading_match = re.match(r"^(#{1,6})(\S)", line)
        if heading_match:
            line = f"{heading_match.group(1)} {heading_match.group(2)}{line[heading_match.end():]}"

        processed.append(line)
        pending_footnote_index = None

    while processed and not processed[0]:
        processed.pop(0)

    saw_title = any(item.startswith("# ") for item in processed[:5])
    desired_title = clean_inline_spacing(title or "")
    if not desired_title and processed and looks_like_title_candidate(processed[0]):
        desired_title = processed[0]
        processed = processed[1:]

    if desired_title and not saw_title:
        processed.insert(0, "")
        processed.insert(0, f"# {desired_title}")
        report["inserted_title"] = True

    final_text = normalize_markdown("\n".join(processed), title=None if saw_title else None).strip() + "\n"
    final_text = re.sub(
        r"(?m)^(#{1,5})\s+(#{1,5})\s+",
        lambda match: "#" * min(6, len(match.group(1)) + len(match.group(2))) + " ",
        final_text,
    )
    final_text = cleanup_front_matter(final_text)
    return final_text, report


def build_output_dir(args: argparse.Namespace, pdf_path: Path) -> Path:
    if args.output_dir:
        return Path(args.output_dir).expanduser().resolve()
    return (Path("tmp") / "mineru_outputs" / slugify(pdf_path.stem)).resolve()


def get_pdf_page_count(pdf_path: Path) -> int:
    with pdf_path.open("rb") as handle:
        return len(PdfReader(handle).pages)


def split_pdf(pdf_path: Path, chunk_pages: int, output_root: Path) -> list[Path]:
    output_root.mkdir(parents=True, exist_ok=True)
    with pdf_path.open("rb") as handle:
        reader = PdfReader(handle)
        total_pages = len(reader.pages)
        parts: list[Path] = []
        for start in range(0, total_pages, chunk_pages):
            writer = PdfWriter()
            end = min(start + chunk_pages, total_pages)
            for index in range(start, end):
                writer.add_page(reader.pages[index])
            part_path = output_root / f"{pdf_path.stem}.part-{(start // chunk_pages) + 1:02d}.pdf"
            with part_path.open("wb") as out:
                writer.write(out)
            parts.append(part_path)
        return parts


def process_single_pdf(
    *,
    pdf_path: Path,
    title: str,
    token: str,
    mineru_api_base: str,
    poll_interval: int,
    timeout_seconds: int,
    mineru_task_options: dict[str, Any],
    mode: str,
    output_dir: Path,
    notebook_id: str,
    source_id: str,
    chunk_index: int | None = None,
) -> dict[str, Any]:
    cos_manager = get_cos_manager()
    pdf_bytes = pdf_path.read_bytes()

    if mode == "bind":
        pdf_key = get_source_pdf_key(notebook_id, source_id, pdf_path.name)
    else:
        folder = f"{slugify(pdf_path.stem)}-{stable_suffix(pdf_path.name)}"
        pdf_key = f"catalog/imports/{folder}/source.pdf"

    pdf_url = cos_manager.upload_file(pdf_key, io.BytesIO(pdf_bytes), "application/pdf")
    if not pdf_url:
        raise RuntimeError("Failed to upload PDF to COS")
    print(f"[COS] pdf uploaded: {pdf_url}")

    task_id = submit_mineru_task(mineru_api_base, token, pdf_url, mineru_task_options)
    print(f"[MinerU] task submitted: {task_id}")
    full_zip_url = wait_mineru_result(mineru_api_base, token, task_id, poll_interval, timeout_seconds)
    print(f"[MinerU] full_zip_url: {full_zip_url}")

    with tempfile.TemporaryDirectory(prefix="mineru_import_") as tmp_dir:
        temp_root = Path(tmp_dir)
        zip_path = temp_root / "result.zip"
        extract_dir = temp_root / "result"
        extract_dir.mkdir(parents=True, exist_ok=True)

        download_zip(full_zip_url, zip_path)
        with zipfile.ZipFile(zip_path, "r") as archive:
            archive.extractall(extract_dir)

        markdown_path = find_main_markdown(extract_dir)
        raw_markdown = markdown_path.read_text(encoding="utf-8", errors="ignore")
        asset_prefix = f"chunk-{chunk_index:02d}-" if chunk_index is not None else ""

        if mode == "bind":
            rewritten_markdown, asset_manifest = upload_markdown_assets(
                notebook_id=notebook_id,
                source_id=source_id,
                markdown_path=markdown_path,
                markdown_text=raw_markdown,
                asset_prefix=asset_prefix,
            )
        else:
            rewritten_markdown, asset_manifest = copy_local_assets(
                markdown_path=markdown_path,
                markdown_text=raw_markdown,
                output_dir=output_dir,
                asset_prefix=asset_prefix,
            )

        proofread_markdown_text, proofread_report = proofread_markdown(rewritten_markdown, title=title)
        return {
            "task_id": task_id,
            "full_zip_url": full_zip_url,
            "raw_markdown": raw_markdown,
            "proofread_markdown": proofread_markdown_text,
            "proofread_report": proofread_report,
            "asset_manifest": asset_manifest,
        }


def save_standalone_outputs(
    output_dir: Path,
    final_markdown: str,
    raw_markdown: str,
    report: dict[str, Any],
    asset_manifest: list[dict[str, Any]],
    pdf_path: Path,
    task_ids: list[str],
    full_zip_urls: list[str],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "raw.md").write_text(raw_markdown, encoding="utf-8")
    (output_dir / "proofread.md").write_text(final_markdown, encoding="utf-8")
    (output_dir / "report.json").write_text(
        json.dumps(
            {
                "pdf": str(pdf_path),
                "task_ids": task_ids,
                "full_zip_urls": full_zip_urls,
                "asset_count": len(asset_manifest),
                "proofread_report": report,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def run_import(args: argparse.Namespace) -> None:
    load_env_file(Path(".env"))
    get_cos_manager()

    token = args.mineru_token or os.environ.get("MINERU_API_TOKEN")
    if not token:
        raise ValueError("Missing MinerU token. Use --mineru-token or set MINERU_API_TOKEN in env/.env")

    pdf_path = resolve_local_path(args.pdf)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    mode = args.mode
    if mode == "bind" and (not args.notebook_id or not args.source_id):
        raise ValueError("--notebook-id and --source-id are required in bind mode")

    extra_formats = [item for item in args.extra_formats if item in {"docx", "html", "latex"}]

    mineru_task_options: dict[str, Any] = {
        "model_version": args.model_version,
        "is_ocr": args.is_ocr,
        "enable_formula": args.enable_formula,
        "enable_table": args.enable_table,
        "language": args.language,
        "no_cache": args.no_cache,
    }
    if extra_formats:
        mineru_task_options["extra_formats"] = extra_formats
    if args.page_ranges:
        mineru_task_options["page_ranges"] = args.page_ranges
    if args.cache_tolerance is not None:
        mineru_task_options["cache_tolerance"] = args.cache_tolerance

    print(
        "[MinerU] options="
        + json.dumps(mineru_task_options, ensure_ascii=False, separators=(",", ":"))
    )

    output_dir = build_output_dir(args, pdf_path)
    page_count = get_pdf_page_count(pdf_path)
    print(f"[PDF] pages={page_count}")

    pdf_parts = [pdf_path]
    if page_count > args.chunk_pages:
        parts_root = output_dir / "_pdf_parts"
        pdf_parts = split_pdf(pdf_path, args.chunk_pages, parts_root)
        print(f"[PDF] split into {len(pdf_parts)} parts with chunk_pages={args.chunk_pages}")

    chunk_results: list[dict[str, Any]] = []
    for index, part in enumerate(pdf_parts, start=1):
        print(f"[RUN] processing part {index}/{len(pdf_parts)}: {part.name}")
        chunk_results.append(
            process_single_pdf(
                pdf_path=part,
                title=(args.title or pdf_path.stem) if index == 1 else "",
                token=token,
                mineru_api_base=args.mineru_api_base,
                poll_interval=args.poll_interval,
                timeout_seconds=args.timeout_seconds,
                mineru_task_options=mineru_task_options,
                mode=mode,
                output_dir=output_dir,
                notebook_id=args.notebook_id,
                source_id=args.source_id,
                chunk_index=index if len(pdf_parts) > 1 else None,
            )
        )

    merged_raw = "\n\n".join(item["raw_markdown"] for item in chunk_results)
    merged_proofread = "\n\n".join(item["proofread_markdown"] for item in chunk_results)
    merged_proofread, merged_report = proofread_markdown(merged_proofread, title=args.title or pdf_path.stem)
    merged_assets = [asset for item in chunk_results for asset in item["asset_manifest"]]

    aggregate_report = {
        "chunk_count": len(chunk_results),
        "page_count": page_count,
        "chunk_reports": [item["proofread_report"] for item in chunk_results],
        "merged_report": merged_report,
    }

    if mode == "bind":
        profile = bind_source_document(
            notebook_id=args.notebook_id,
            source_id=args.source_id,
            markdown_text=merged_proofread,
            asset_manifest=merged_assets,
        )
        if args.output_markdown:
            output = Path(args.output_markdown).resolve()
            output.write_text(merged_proofread, encoding="utf-8")
            print(f"[OUT] proofread markdown saved: {output}")

        print("[DONE] source document bound successfully")
        print(
            json.dumps(
                {
                    "mode": mode,
                    "notebook_id": args.notebook_id,
                    "source_id": args.source_id,
                    "task_ids": [item["task_id"] for item in chunk_results],
                    "asset_count": len(merged_assets),
                    "markdown_url": profile.get("markdown_url"),
                    "proofread_report": aggregate_report,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        save_standalone_outputs(
            output_dir=output_dir,
            final_markdown=merged_proofread,
            raw_markdown=merged_raw,
            report=aggregate_report,
            asset_manifest=merged_assets,
            pdf_path=pdf_path,
            task_ids=[item["task_id"] for item in chunk_results],
            full_zip_urls=[item["full_zip_url"] for item in chunk_results],
        )
        print("[DONE] standalone proofread complete")
        print(
            json.dumps(
                {
                    "mode": mode,
                    "task_ids": [item["task_id"] for item in chunk_results],
                    "asset_count": len(merged_assets),
                    "output_dir": str(output_dir),
                    "proofread_report": aggregate_report,
                },
                ensure_ascii=False,
                indent=2,
            )
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import PDF with MinerU and proofread markdown")
    parser.add_argument("--mode", choices=["bind", "standalone"], default="bind")
    parser.add_argument("--notebook-id", default="", help="NotebookLM notebook id for bind mode")
    parser.add_argument("--source-id", default="", help="NotebookLM source id for bind mode")
    parser.add_argument("--pdf", required=True, help="Local PDF path or file:/// path")
    parser.add_argument("--title", default="", help="Optional markdown title override")
    parser.add_argument("--output-markdown", default="", help="Optional output path for final markdown in bind mode")
    parser.add_argument("--output-dir", default="", help="Standalone mode output directory")
    parser.add_argument("--mineru-token", default="", help="MinerU bearer token")
    parser.add_argument(
        "--mineru-api-base",
        default="https://mineru.net/api/v4",
        help="MinerU API base (default: https://mineru.net/api/v4)",
    )
    parser.add_argument(
        "--model-version",
        choices=["pipeline", "vlm", "MinerU-HTML"],
        default="vlm",
        help="MinerU model version (default: vlm)",
    )
    parser.add_argument("--language", default="ch", help="MinerU language hint (default: ch)")
    parser.add_argument("--is-ocr", action=argparse.BooleanOptionalAction, default=True, help="Enable OCR (default: true)")
    parser.add_argument(
        "--enable-formula",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable formula parsing (default: true)",
    )
    parser.add_argument(
        "--enable-table",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable table parsing (default: true)",
    )
    parser.add_argument(
        "--extra-formats",
        nargs="*",
        default=["markdown"],
        help="Extra MinerU output formats, space separated (default: markdown)",
    )
    parser.add_argument("--page-ranges", default="", help="Optional MinerU page ranges, e.g. 1-80")
    parser.add_argument(
        "--cache-tolerance",
        type=int,
        default=None,
        help="Optional MinerU cache tolerance in seconds",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Disable MinerU cache usage (default: false)",
    )
    parser.add_argument("--chunk-pages", type=int, default=250, help="Split PDF when page count exceeds this threshold")
    parser.add_argument("--poll-interval", type=int, default=5, help="Poll interval seconds")
    parser.add_argument("--timeout-seconds", type=int, default=1800, help="Task timeout seconds")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        run_import(args)
        return 0
    except Exception as exc:
        print(f"[ERROR] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
