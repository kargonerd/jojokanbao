import json
import os
import threading
import time
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote, urlparse

import requests
from PyPDF2 import PdfReader, PdfWriter

from jojo_press.services.normalize_service import NormalizeService


class MineruGateway(Protocol):
    def submit_task(self, pdf_path: Path, options: dict[str, object]) -> str: ...

    def wait_for_result(self, task_id: str) -> str: ...

    def download_result(self, url: str, output_path: Path) -> None: ...


class HttpMineruGateway:
    _STATUS_SUCCESS = {'success', 'succeeded', 'done', 'completed', 'finish', 'finished'}
    _STATUS_FAILED = {'failed', 'error', 'canceled', 'cancelled', 'timeout'}
    _MAX_POLL_ATTEMPTS = 720

    def __init__(self, api_base: str, token: str) -> None:
        self.api_base = api_base.rstrip('/')
        self.token = token

    def submit_task(self, pdf_path: Path, options: dict[str, object]) -> str:
        headers = {
            'Authorization': f'Bearer {self.token}',
            'Content-Type': 'application/json',
            'Accept': '*/*',
        }
        response = requests.post(
            f'{self.api_base}/file-urls/batch',
            headers=headers,
            json={
                **options,
                'files': [
                    {
                        'name': pdf_path.name,
                        'data_id': pdf_path.name,
                    },
                ],
            },
            timeout=45,
        )
        response.raise_for_status()
        payload = response.json()
        batch_id = self._extract_batch_id(payload)
        upload_url = self._extract_upload_url(payload)
        if not batch_id or not upload_url:
            raise RuntimeError(f'MinerU batch submission missing upload info: {json.dumps(payload, ensure_ascii=False)}')
        requests.put(
            upload_url,
            data=pdf_path.read_bytes(),
            headers={},
            timeout=180,
        ).raise_for_status()
        return batch_id

    def wait_for_result(self, task_id: str) -> str:
        endpoint = f'{self.api_base}/extract-results/batch/{task_id}'
        headers = {'Authorization': f'Bearer {self.token}'}
        for _ in range(self._MAX_POLL_ATTEMPTS):
            response = requests.get(endpoint, headers=headers, timeout=30)
            response.raise_for_status()
            payload = response.json()
            status = self._extract_status(payload)
            full_zip_url = self._extract_full_zip_url(payload)
            if full_zip_url and (not status or status in self._STATUS_SUCCESS):
                return full_zip_url
            if status in self._STATUS_FAILED:
                raise RuntimeError(f'MinerU task failed: {status}, payload={json.dumps(payload, ensure_ascii=False)}')
            time.sleep(2)
        raise TimeoutError(f'MinerU task timeout: {task_id}')

    def download_result(self, url: str, output_path: Path) -> None:
        response = requests.get(url, timeout=180)
        response.raise_for_status()
        output_path.write_bytes(response.content)

    def _extract_task_id(self, payload: dict[str, Any]) -> str | None:
        candidates = [
            payload.get('task_id'),
            payload.get('id'),
            self._deep_get(payload, 'data', 'task_id'),
            self._deep_get(payload, 'data', 'id'),
            self._deep_get(payload, 'result', 'task_id'),
            self._deep_get(payload, 'result', 'id'),
        ]
        for candidate in candidates:
            if candidate:
                return str(candidate)
        return None

    def _extract_batch_id(self, payload: dict[str, Any]) -> str | None:
        candidates = [
            payload.get('batch_id'),
            self._deep_get(payload, 'data', 'batch_id'),
            self._deep_get(payload, 'result', 'batch_id'),
        ]
        for candidate in candidates:
            if candidate:
                return str(candidate)
        return None

    def _extract_upload_url(self, payload: dict[str, Any]) -> str | None:
        candidates = [
            self._deep_get(payload, 'data', 'file_urls'),
            self._deep_get(payload, 'result', 'file_urls'),
        ]
        for candidate in candidates:
            if isinstance(candidate, list) and candidate:
                return str(candidate[0])
        return None

    def _extract_status(self, payload: dict[str, Any]) -> str:
        extract_results = self._deep_get(payload, 'data', 'extract_result') or self._deep_get(payload, 'result', 'extract_result')
        if isinstance(extract_results, list) and extract_results:
            state = extract_results[0].get('state')
            if state:
                return str(state).strip().lower()
        status = (
            payload.get('status')
            or payload.get('state')
            or self._deep_get(payload, 'data', 'status')
            or self._deep_get(payload, 'data', 'state')
            or self._deep_get(payload, 'result', 'status')
            or self._deep_get(payload, 'result', 'state')
            or ''
        )
        return str(status).strip().lower()

    def _extract_full_zip_url(self, payload: dict[str, Any]) -> str | None:
        extract_results = self._deep_get(payload, 'data', 'extract_result') or self._deep_get(payload, 'result', 'extract_result')
        if isinstance(extract_results, list):
            for item in extract_results:
                if not isinstance(item, dict):
                    continue
                for key in ('full_zip_url', 'zip_url', 'download_url'):
                    candidate = item.get(key)
                    if candidate:
                        return str(candidate)
        candidates = [
            payload.get('full_zip_url'),
            payload.get('zip_url'),
            payload.get('download_url'),
            self._deep_get(payload, 'data', 'full_zip_url'),
            self._deep_get(payload, 'data', 'zip_url'),
            self._deep_get(payload, 'data', 'download_url'),
            self._deep_get(payload, 'data', 'extract_result', 'full_zip_url'),
            self._deep_get(payload, 'result', 'full_zip_url'),
            self._deep_get(payload, 'result', 'zip_url'),
            self._deep_get(payload, 'result', 'download_url'),
            self._deep_get(payload, 'result', 'extract_result', 'full_zip_url'),
        ]
        for candidate in candidates:
            if candidate:
                return str(candidate)
        return None

    def _deep_get(self, data: dict[str, Any], *keys: str) -> Any:
        current: Any = data
        for key in keys:
            if not isinstance(current, dict):
                return None
            current = current.get(key)
        return current


@dataclass
class RecognitionTask:
    project_id: str
    status: str
    engine: str
    language: str
    is_ocr: bool
    pdf_path: str


class RecognitionTaskNotFoundError(FileNotFoundError):
    pass


class RecognitionTaskStateError(ValueError):
    pass


class MineruGatewayNotConfiguredError(RuntimeError):
    pass


def build_mineru_gateway_from_env() -> HttpMineruGateway | None:
    api_base = os.getenv('MINERU_API_BASE', '').strip()
    token = os.getenv('MINERU_API_TOKEN', '').strip()
    if not api_base or not token:
        return None
    return HttpMineruGateway(api_base=api_base, token=token)


class MineruService:
    _MINERU_MAX_PAGES = 600
    _MINERU_SPLIT_CHUNK_PAGES = 300

    def __init__(self, base_dir: Path, gateway: MineruGateway | None = None) -> None:
        self.base_dir = base_dir
        self.gateway = gateway
        self._active_workers: dict[str, threading.Thread] = {}
        self._task_state_locks: dict[str, threading.Lock] = {}

    def start_task(self, project_id: str, pdf_path: str) -> RecognitionTask:
        task = RecognitionTask(
            project_id=project_id,
            status='queued',
            engine='pipeline',
            language='chinese_cht',
            is_ocr=True,
            pdf_path=pdf_path,
        )
        if self.gateway is None:
            raise MineruGatewayNotConfiguredError('mineru gateway is not configured')

        self._write_task(task)
        self._start_background_worker(task)
        return task

    def retry_task(self, project_id: str) -> RecognitionTask:
        task = self._read_task(project_id)
        retried_task = RecognitionTask(
            project_id=task.project_id,
            status='queued',
            engine=task.engine,
            language=task.language,
            is_ocr=task.is_ocr,
            pdf_path=task.pdf_path,
        )
        self._write_task(retried_task)
        self._start_background_worker(retried_task)
        return retried_task

    def resume_task(self, project_id: str) -> RecognitionTask:
        return self._read_task(project_id)

    def _start_background_worker(self, task: RecognitionTask) -> None:
        worker = self._active_workers.get(task.project_id)
        if worker is not None and worker.is_alive():
            return
        worker = threading.Thread(
            target=self._process_task,
            args=(task,),
            daemon=True,
            name=f'mineru-{task.project_id}',
        )
        self._active_workers[task.project_id] = worker
        worker.start()

    def _process_task(self, task: RecognitionTask) -> None:
        processing_task = RecognitionTask(
            project_id=task.project_id,
            status='processing',
            engine=task.engine,
            language=task.language,
            is_ocr=task.is_ocr,
            pdf_path=task.pdf_path,
        )
        self._write_task(processing_task)
        resolved_pdf_path = self._resolve_local_pdf_path(task.pdf_path)
        try:
            try:
                content_list = self._run_gateway_pipeline(task.project_id, resolved_pdf_path, task=processing_task)
            except RuntimeError as exc:
                if not self._is_page_limit_error(exc):
                    raise
                split_paths = self._split_pdf_for_mineru(resolved_pdf_path)
                if not split_paths:
                    raise
                all_content_items: list[dict] = []
                for split_path in split_paths:
                    all_content_items.extend(self._run_gateway_pipeline(task.project_id, split_path, task=processing_task))
                content_list = all_content_items
                content_list_path = self._content_list_path(task.project_id)
                content_list_path.parent.mkdir(parents=True, exist_ok=True)
                content_list_path.write_text(json.dumps(content_list, ensure_ascii=False), encoding='utf-8')
            self._write_normalized_document(task.project_id, content_list=content_list, source_pdf=task.pdf_path)
            self._write_task(
                RecognitionTask(
                    project_id=task.project_id,
                    status='completed',
                    engine=task.engine,
                    language=task.language,
                    is_ocr=task.is_ocr,
                    pdf_path=task.pdf_path,
                )
            )
        except Exception:
            self._write_task(
                RecognitionTask(
                    project_id=task.project_id,
                    status='failed',
                    engine=task.engine,
                    language=task.language,
                    is_ocr=task.is_ocr,
                    pdf_path=task.pdf_path,
                )
            )
        finally:
            worker = self._active_workers.get(task.project_id)
            if worker is threading.current_thread():
                self._active_workers.pop(task.project_id, None)

    def _run_gateway_pipeline(self, project_id: str, pdf_path: Path, *, task: RecognitionTask) -> list[dict]:
        task_id = self.gateway.submit_task(
            pdf_path,
            options={
                'language': task.language,
                'is_ocr': task.is_ocr,
                'engine': task.engine,
            },
        )
        result_url = self.gateway.wait_for_result(task_id)
        raw_result_zip_path = self._raw_result_zip_path(project_id)
        raw_result_zip_path.parent.mkdir(parents=True, exist_ok=True)
        self.gateway.download_result(result_url, raw_result_zip_path)
        # Extract both content_list and layout
        self._extract_layout(project_id, raw_result_zip_path)
        return self._extract_content_list(project_id, raw_result_zip_path)

    def _is_page_limit_error(self, error: RuntimeError) -> bool:
        return 'number of pages exceeds limit' in str(error).lower()

    def _split_pdf_for_mineru(self, pdf_path: Path) -> list[Path]:
        output_root = self.base_dir / '_tmp' / 'mineru-splits' / pdf_path.stem
        output_root.mkdir(parents=True, exist_ok=True)
        with pdf_path.open('rb') as handle:
            reader = PdfReader(handle)
            total_pages = len(reader.pages)
            split_paths: list[Path] = []
            for start in range(0, total_pages, self._MINERU_SPLIT_CHUNK_PAGES):
                writer = PdfWriter()
                end = min(start + self._MINERU_SPLIT_CHUNK_PAGES, total_pages)
                for index in range(start, end):
                    writer.add_page(reader.pages[index])
                split_path = output_root / f'{pdf_path.stem}.part-{(start // self._MINERU_SPLIT_CHUNK_PAGES) + 1:02d}.pdf'
                with split_path.open('wb') as split_file:
                    writer.write(split_file)
                split_paths.append(split_path)
        return split_paths

    def _task_state_path(self, project_id: str) -> Path:
        return self.base_dir / project_id / 'state' / 'recognition-task.json'

    def _task_state_lock(self, project_id: str) -> threading.Lock:
        lock = self._task_state_locks.get(project_id)
        if lock is None:
            lock = threading.Lock()
            self._task_state_locks[project_id] = lock
        return lock

    def _raw_result_zip_path(self, project_id: str) -> Path:
        return self.base_dir / project_id / 'artifacts' / 'mineru' / 'raw-result.zip'

    def _resolve_local_pdf_path(self, raw_path: str) -> Path:
        if raw_path.startswith('file:///'):
            parsed = urlparse(raw_path)
            return Path(unquote(parsed.path.lstrip('/'))).resolve()
        return Path(raw_path).expanduser().resolve()

    def _content_list_path(self, project_id: str) -> Path:
        return self.base_dir / project_id / 'artifacts' / 'mineru' / 'content_list.json'

    def _layout_path(self, project_id: str) -> Path:
        return self.base_dir / project_id / 'artifacts' / 'mineru' / 'layout.json'

    def _book_document_path(self, project_id: str) -> Path:
        return self.base_dir / project_id / 'output' / 'book-document.json'

    def _extract_content_list(self, project_id: str, zip_path: Path) -> list[dict]:
        with zipfile.ZipFile(zip_path, 'r') as archive:
            content_list_name = self._find_content_list_name(archive)
            payload = archive.read(content_list_name).decode('utf-8')
        content_list_path = self._content_list_path(project_id)
        content_list_path.parent.mkdir(parents=True, exist_ok=True)
        content_list_path.write_text(payload, encoding='utf-8')
        return json.loads(payload)

    def _extract_layout(self, project_id: str, zip_path: Path) -> dict:
        """Extract layout.json from MinerU result zip."""
        with zipfile.ZipFile(zip_path, 'r') as archive:
            if 'layout.json' not in archive.namelist():
                raise KeyError('layout.json not found in MinerU result archive')
            payload = archive.read('layout.json').decode('utf-8')
        layout_path = self._layout_path(project_id)
        layout_path.parent.mkdir(parents=True, exist_ok=True)
        layout_path.write_text(payload, encoding='utf-8')
        return json.loads(payload)

    def _find_content_list_name(self, archive: zipfile.ZipFile) -> str:
        if 'content_list.json' in archive.namelist():
            return 'content_list.json'
        for name in archive.namelist():
            if name.endswith('content_list.json'):
                return name
        raise KeyError('content_list.json not found in MinerU result archive')

    def _write_normalized_document(self, project_id: str, *, content_list: list[dict], source_pdf: str) -> None:
        document = NormalizeService().from_mineru(content_list=content_list, source_pdf=source_pdf)
        document_path = self._book_document_path(project_id)
        document_path.parent.mkdir(parents=True, exist_ok=True)
        document_path.write_text(document.model_dump_json(indent=2), encoding='utf-8')

    def _write_task(self, task: RecognitionTask) -> None:
        state_path = self._task_state_path(task.project_id)
        state_path.parent.mkdir(parents=True, exist_ok=True)
        with self._task_state_lock(task.project_id):
            state_path.write_text(
                json.dumps(asdict(task), ensure_ascii=False, indent=2),
                encoding='utf-8',
            )

    def _read_task(self, project_id: str) -> RecognitionTask:
        state_path = self._task_state_path(project_id)
        try:
            with self._task_state_lock(project_id):
                payload = json.loads(state_path.read_text(encoding='utf-8'))
            return RecognitionTask(**payload)
        except FileNotFoundError as exc:
            raise RecognitionTaskNotFoundError(project_id) from exc
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise RecognitionTaskStateError(f'corrupted recognition task state in {state_path}') from exc
