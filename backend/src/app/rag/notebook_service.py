"""Notebook/source service layer for catalog, documents, and source-scoped AI."""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import io
import json
import mimetypes
import os
import posixpath
import re
import zipfile
from typing import Any, Callable, Iterable, Optional

import requests

try:
    from notebooklm import AuthTokens, NotebookLMClient
    from notebooklm.auth import fetch_tokens
except ImportError:  # pragma: no cover - local path fallback
    from notebooklm import AuthTokens, NotebookLMClient
    from notebooklm.auth import fetch_tokens

try:
    from cos_manager import (
        get_cos_manager,
        get_notebook_cover_key,
        get_source_asset_key,
        get_source_cover_key,
        get_source_markdown_key,
        get_source_pdf_key,
    )
    from database import (
        AccountManager,
        AnalysisCacheManager,
        NotebookProfileManager,
        SourceProfileManager,
    )
except ImportError:  # pragma: no cover - package import fallback
    from app.rag.cos_manager import (
        get_cos_manager,
        get_notebook_cover_key,
        get_source_asset_key,
        get_source_cover_key,
        get_source_markdown_key,
        get_source_pdf_key,
    )
    from app.rag.database import (
        AccountManager,
        AnalysisCacheManager,
        NotebookProfileManager,
        SourceProfileManager,
    )


JSON_BLOCK_RE = re.compile(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', re.IGNORECASE)
JSON_OBJECT_RE = re.compile(r'(\{[\s\S]*\})')
WHITESPACE_RE = re.compile(r'\s+')
PACKAGE_SCHEMA_VERSION = '1.0'
PACKAGE_MANIFEST_NAME = 'manifest.json'
cos_manager = get_cos_manager()


def run_async(coro):
    """Run async code safely from sync Flask handlers."""

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_run)
        return future.result()


def parse_cookie_value(cookie_value: str) -> dict[str, str]:
    """Convert stored cookie JSON/string into a name/value mapping."""
    try:
        parsed = json.loads(cookie_value)
        if isinstance(parsed, list):
            result = {}
            for item in parsed:
                if isinstance(item, dict) and item.get('name') and item.get('value') is not None:
                    result[item['name']] = item['value']
            if result:
                return result
    except Exception:
        pass

    result = {}
    for part in cookie_value.split(';'):
        if '=' not in part:
            continue
        key, value = part.split('=', 1)
        key = key.strip()
        value = value.strip()
        if key:
            result[key] = value
    return result


def list_accounts(include_cookie: bool = True) -> list[dict[str, Any]]:
    """Return stored Google accounts, optionally hiding cookie payloads."""
    accounts = AccountManager.get_all()
    if include_cookie:
        return accounts
    sanitized = []
    for account in accounts:
        sanitized.append({
            'id': account['id'],
            'name': account['name'],
            'notebooks': account.get('notebooks', []),
            'added_at': account.get('added_at'),
            'expires_at': account.get('expires_at'),
        })
    return sanitized


def find_account_for_notebook(notebook_id: str) -> Optional[dict[str, Any]]:
    """Find the account that owns a NotebookLM notebook."""
    profile = NotebookProfileManager.get_by_id(notebook_id)
    accounts = list_accounts(include_cookie=True)

    if profile:
        for account in accounts:
            if account['name'] == profile['account_name']:
                return account

    for account in accounts:
        notebooks = account.get('notebooks') or []
        if any(nb.get('id') == notebook_id for nb in notebooks):
            return account
    return None


def ensure_notebook_profile(notebook_id: str, notebook_title: str, account_name: str) -> dict[str, Any]:
    profile = NotebookProfileManager.get_by_id(notebook_id)
    if profile:
        updates = {}
        if profile.get('notebook_title') != notebook_title:
            updates['notebook_title'] = notebook_title
        if profile.get('account_name') != account_name:
            updates['account_name'] = account_name
        if updates:
            updates['notebook_id'] = notebook_id
            NotebookProfileManager.save({**profile, **updates})
            profile = NotebookProfileManager.get_by_id(notebook_id) or {**profile, **updates}
        return profile

    NotebookProfileManager.save({
        'notebook_id': notebook_id,
        'account_name': account_name,
        'notebook_title': notebook_title,
        'display_title': notebook_title,
        'description': '',
        'cover_url': '',
        'is_published': False,
        'sort_order': 0,
    })
    return NotebookProfileManager.get_by_id(notebook_id) or {
        'notebook_id': notebook_id,
        'account_name': account_name,
        'notebook_title': notebook_title,
        'display_title': notebook_title,
        'description': '',
        'cover_url': '',
        'is_published': False,
        'sort_order': 0,
    }


def ensure_source_profile(
    notebook_id: str,
    source_id: str,
    source_title: str,
    source_kind: str = '',
    source_url: str = '',
) -> dict[str, Any]:
    profile = SourceProfileManager.get(notebook_id, source_id)
    if profile:
        updates = {}
        if profile.get('source_title') != source_title:
            updates['source_title'] = source_title
        if source_kind and profile.get('source_kind') != source_kind:
            updates['source_kind'] = source_kind
        if source_url and profile.get('source_url') != source_url:
            updates['source_url'] = source_url
        if updates:
            SourceProfileManager.save({**profile, **updates, 'notebook_id': notebook_id, 'source_id': source_id})
            profile = SourceProfileManager.get(notebook_id, source_id) or {**profile, **updates}
        return profile

    SourceProfileManager.save({
        'notebook_id': notebook_id,
        'source_id': source_id,
        'source_title': source_title,
        'display_title': source_title,
        'description': '',
        'cover_url': '',
        'source_kind': source_kind,
        'source_url': source_url,
        'asset_manifest': [],
        'document_status': 'missing',
        'is_published': False,
        'sort_order': 0,
    })
    return SourceProfileManager.get(notebook_id, source_id) or {
        'notebook_id': notebook_id,
        'source_id': source_id,
        'source_title': source_title,
        'display_title': source_title,
        'description': '',
        'cover_url': '',
        'source_kind': source_kind,
        'source_url': source_url,
        'asset_manifest': [],
        'document_status': 'missing',
        'is_published': False,
        'sort_order': 0,
    }


def notebook_publish_readiness(notebook_id: str) -> dict[str, Any]:
    profile = NotebookProfileManager.get_by_id(notebook_id) or {}
    sources = SourceProfileManager.get_all_for_notebook(notebook_id, include_unpublished=True)

    reasons: list[str] = []
    if not (profile.get('display_title') or '').strip():
        reasons.append('missing_title')
    if not (profile.get('description') or '').strip():
        reasons.append('missing_description')
    if not (profile.get('cover_url') or '').strip():
        reasons.append('missing_cover')
    if not sources:
        reasons.append('missing_sources')

    incomplete_sources = []
    for source in sources:
        readiness = source_publish_readiness(notebook_id, source['source_id'])
        if not readiness['ready']:
            incomplete_sources.append(source['source_id'])

    if incomplete_sources:
        reasons.append('incomplete_sources')

    return {
        'ready': not reasons,
        'reasons': reasons,
        'incomplete_source_ids': incomplete_sources,
    }


def source_publish_readiness(notebook_id: str, source_id: str) -> dict[str, Any]:
    profile = SourceProfileManager.get(notebook_id, source_id) or {}
    reasons: list[str] = []
    if not (profile.get('display_title') or '').strip():
        reasons.append('missing_title')
    if not (profile.get('description') or '').strip():
        reasons.append('missing_description')
    if not (profile.get('cover_url') or '').strip():
        reasons.append('missing_cover')
    if not (profile.get('markdown_url') or '').strip():
        reasons.append('missing_document')
    if profile.get('document_status') != 'ready':
        reasons.append('document_not_ready')

    return {
        'ready': not reasons,
        'reasons': reasons,
    }


def merge_notebook_record(account_name: str, notebook: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    readiness = notebook_publish_readiness(notebook['id'])
    published = bool(profile.get('is_published', False)) and readiness['ready']
    return {
        'id': notebook['id'],
        'notebook_id': notebook['id'],
        'account_name': account_name,
        'notebook_title': notebook.get('title') or profile.get('notebook_title') or notebook['id'],
        'title': profile.get('display_title') or profile.get('notebook_title') or notebook.get('title') or notebook['id'],
        'description': profile.get('description', ''),
        'cover_url': profile.get('cover_url', ''),
        'is_published': published,
        'publish_ready': readiness['ready'],
        'publish_reasons': readiness['reasons'],
        'sort_order': profile.get('sort_order', 0),
        'source_count': len(SourceProfileManager.get_all_for_notebook(notebook['id'], include_unpublished=False)),
        'created_at': profile.get('created_at'),
        'updated_at': profile.get('updated_at'),
    }


def list_catalog_notebooks(include_unpublished: bool = False) -> list[dict[str, Any]]:
    """List notebook-backed libraries merged with display metadata."""
    notebooks: list[dict[str, Any]] = []
    for account in list_accounts(include_cookie=False):
        for notebook in account.get('notebooks') or []:
            profile = ensure_notebook_profile(notebook['id'], notebook.get('title', ''), account['name'])
            record = merge_notebook_record(account['name'], notebook, profile)
            if include_unpublished or record['is_published']:
                notebooks.append(record)

    notebooks.sort(key=lambda item: (item.get('sort_order', 0), item.get('title', '')))
    return notebooks


def get_catalog_notebook(notebook_id: str, include_unpublished: bool = True) -> Optional[dict[str, Any]]:
    for notebook in list_catalog_notebooks(include_unpublished=include_unpublished):
        if notebook['id'] == notebook_id:
            return notebook
    return None


async def get_client_for_notebook_async(notebook_id: str) -> NotebookLMClient:
    account = find_account_for_notebook(notebook_id)
    if not account:
        raise ValueError(f'Notebook {notebook_id} is not associated with any account')

    cookies = parse_cookie_value(account['cookie'])
    if not cookies:
        raise ValueError(f'Notebook {notebook_id} account cookie is invalid')

    csrf_token, session_id = await fetch_tokens(cookies)
    auth = AuthTokens(cookies=cookies, csrf_token=csrf_token, session_id=session_id)
    return NotebookLMClient(auth)


def get_client_for_notebook(notebook_id: str) -> NotebookLMClient:
    return run_async(get_client_for_notebook_async(notebook_id))


def _source_kind_value(source: Any) -> str:
    kind = getattr(source, 'kind', None)
    return kind.value if hasattr(kind, 'value') else str(kind or '')


async def sync_notebook_sources_async(notebook_id: str, include_unpublished: bool = False) -> list[dict[str, Any]]:
    async with await get_client_for_notebook_async(notebook_id) as client:
        live_sources = await client.sources.list(notebook_id)

    merged_sources = []
    for source in live_sources:
        profile = ensure_source_profile(
            notebook_id=notebook_id,
            source_id=source.id,
            source_title=source.title,
            source_kind=_source_kind_value(source),
            source_url=getattr(source, 'url', '') or '',
        )

        item = {
            'id': source.id,
            'source_id': source.id,
            'notebook_id': notebook_id,
            'source_title': source.title,
            'title': profile.get('display_title') or source.title,
            'description': profile.get('description', ''),
            'cover_url': profile.get('cover_url', ''),
            'kind': _source_kind_value(source),
            'url': getattr(source, 'url', None),
            'is_published': bool(profile.get('is_published', False)) and source_publish_readiness(notebook_id, source.id)['ready'],
            'sort_order': profile.get('sort_order', 0),
            'document_status': profile.get('document_status', 'missing'),
            'markdown_url': profile.get('markdown_url', ''),
            'has_document': bool(profile.get('markdown_url')),
            'asset_manifest': profile.get('asset_manifest', []),
            'package_manifest': profile.get('package_manifest', {}),
            'chapter_count': len(profile.get('chapters', [])),
            'document_mode': profile.get('package_manifest') and 'import_package' or 'bound_document',
        }
        readiness = source_publish_readiness(notebook_id, source.id)
        item['publish_ready'] = readiness['ready']
        item['publish_reasons'] = readiness['reasons']
        if include_unpublished or item['is_published']:
            merged_sources.append(item)

    merged_sources.sort(key=lambda item: (item.get('sort_order', 0), item.get('title', '')))
    return merged_sources


def sync_notebook_sources(notebook_id: str, include_unpublished: bool = False) -> list[dict[str, Any]]:
    return run_async(sync_notebook_sources_async(notebook_id, include_unpublished=include_unpublished))


def get_source_record(notebook_id: str, source_id: str, include_unpublished: bool = True) -> Optional[dict[str, Any]]:
    sources = sync_notebook_sources(notebook_id, include_unpublished=include_unpublished)
    for source in sources:
        if source['id'] == source_id:
            return source
    return None


def fetch_url_text(url: str) -> str:
    """Load text content from file:// or http(s):// URLs."""
    if url.startswith('file://'):
        with open(url[7:], 'r', encoding='utf-8') as handle:
            return handle.read()

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    response.encoding = response.encoding or 'utf-8'
    return response.text


def get_source_document_text(notebook_id: str, source_id: str) -> dict[str, Any]:
    source = get_source_record(notebook_id, source_id, include_unpublished=True)
    if not source:
        raise ValueError('Source not found')

    profile = SourceProfileManager.get(notebook_id, source_id)
    if profile and profile.get('markdown_url'):
        text = fetch_url_text(profile['markdown_url'])
        chapters = profile.get('chapters', [])
        return {
            'id': source_id,
            'title': source['title'],
            'text': text,
            'mode': profile.get('package_manifest') and 'import_package' or 'bound_document',
            'document_url': profile['markdown_url'],
            'toc': profile.get('toc', []),
            'chapters': [
                {
                    'id': chapter.get('id'),
                    'title': chapter.get('title'),
                    'order': chapter.get('order', 0),
                    'summary': chapter.get('summary', ''),
                }
                for chapter in chapters
            ],
            'annotations': profile.get('annotations', []),
            'reader_config': profile.get('reader_config', {}),
            'chapter_count': len(chapters),
        }

    async def fetch():
        async with await get_client_for_notebook_async(notebook_id) as client:
            fulltext = await client.sources.get_fulltext(notebook_id, source_id)
            return fulltext.content

    return {
        'id': source_id,
        'title': source['title'],
        'text': run_async(fetch()),
        'mode': 'notebooklm_fulltext',
        'document_url': None,
        'toc': [],
        'chapters': [],
        'annotations': [],
        'reader_config': {},
        'chapter_count': 0,
    }


def upload_notebook_cover(notebook_id: str, file_storage) -> str:
    key = get_notebook_cover_key(notebook_id)
    url = cos_manager.upload_file(key, file_storage, getattr(file_storage, 'content_type', None))
    if not url:
        raise RuntimeError('Upload failed')
    profile = NotebookProfileManager.get_by_id(notebook_id)
    if not profile:
        raise ValueError('Notebook profile not found')
    NotebookProfileManager.save({**profile, 'cover_url': url})
    return url


def upload_source_cover(notebook_id: str, source_id: str, file_storage) -> str:
    key = get_source_cover_key(notebook_id, source_id)
    url = cos_manager.upload_file(key, file_storage, getattr(file_storage, 'content_type', None))
    if not url:
        raise RuntimeError('Upload failed')
    profile = SourceProfileManager.get(notebook_id, source_id)
    if not profile:
        raise ValueError('Source profile not found')
    SourceProfileManager.save({**profile, 'cover_url': url})
    return url


def bind_source_document(
    notebook_id: str,
    source_id: str,
    markdown_text: str,
    asset_manifest: Optional[list[dict[str, Any]]] = None,
    pdf_bytes: bytes | None = None,
    pdf_filename: str | None = None,
) -> dict[str, Any]:
    profile = SourceProfileManager.get(notebook_id, source_id)
    if not profile:
        raise ValueError('Source profile not found')

    markdown_key = get_source_markdown_key(notebook_id, source_id)
    markdown_url = cos_manager.upload_file(
        markdown_key,
        io.BytesIO(markdown_text.encode('utf-8')),
        'text/markdown; charset=utf-8',
    )
    if not markdown_url:
        raise RuntimeError('Markdown upload failed')

    pdf_key = profile.get('pdf_key', '')
    pdf_url = profile.get('pdf_url', '')
    if pdf_bytes:
        pdf_key = get_source_pdf_key(notebook_id, source_id, pdf_filename or 'source.pdf')
        pdf_url = cos_manager.upload_file(pdf_key, io.BytesIO(pdf_bytes), 'application/pdf') or ''

    updated = {
        **profile,
        'markdown_key': markdown_key,
        'markdown_url': markdown_url,
        'pdf_key': pdf_key,
        'pdf_url': pdf_url,
        'asset_manifest': asset_manifest if asset_manifest is not None else profile.get('asset_manifest', []),
        'document_status': 'ready',
    }
    SourceProfileManager.save(updated)
    return SourceProfileManager.get(notebook_id, source_id) or updated


def upload_source_asset(notebook_id: str, source_id: str, filename: str, data: bytes, content_type: str) -> dict[str, str]:
    key = get_source_asset_key(notebook_id, source_id, filename)
    url = cos_manager.upload_file(key, io.BytesIO(data), content_type)
    if not url:
        raise RuntimeError(f'Failed to upload asset: {filename}')
    return {'filename': os.path.basename(filename), 'key': key, 'url': url}


def _normalize_package_path(path: str) -> str:
    normalized = posixpath.normpath((path or '').replace('\\', '/')).lstrip('./')
    if not normalized or normalized.startswith('../') or normalized == '..':
        raise ValueError(f'Invalid package path: {path}')
    return normalized


def _read_package_json(package: zipfile.ZipFile, path: str) -> Any:
    normalized = _normalize_package_path(path)
    try:
        with package.open(normalized) as handle:
            return json.loads(handle.read().decode('utf-8'))
    except KeyError as exc:
        raise ValueError(f'Missing package file: {normalized}') from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f'Invalid JSON in {normalized}: {exc}') from exc


def _read_package_text(package: zipfile.ZipFile, path: str) -> str:
    normalized = _normalize_package_path(path)
    try:
        with package.open(normalized) as handle:
            return handle.read().decode('utf-8')
    except KeyError as exc:
        raise ValueError(f'Missing package file: {normalized}') from exc


def _ensure_list(value: Any, field_name: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f'{field_name} must be a list')
    return value


def _build_default_toc(chapters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            'id': chapter['id'],
            'title': chapter['title'],
            'chapter_id': chapter['id'],
            'level': 1,
            'order': chapter['order'],
        }
        for chapter in chapters
    ]


def _rewrite_package_assets(
    markdown_text: str,
    chapter_path: str,
    uploaded_assets: dict[str, dict[str, str]],
) -> str:
    rewritten = markdown_text
    chapter_dir = posixpath.dirname(chapter_path)
    for asset_path, asset in uploaded_assets.items():
        candidates = {asset_path, './' + asset_path}
        relative = posixpath.relpath(asset_path, chapter_dir) if chapter_dir else asset_path
        candidates.update({relative, './' + relative})
        basename = posixpath.basename(asset_path)
        candidates.update({basename, './' + basename})
        for original in sorted(candidates, key=len, reverse=True):
            rewritten = rewritten.replace(f'({original})', f'({asset["url"]})')
    return rewritten


def parse_source_import_package(notebook_id: str, source_id: str, package_bytes: bytes) -> dict[str, Any]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(package_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError('Import package must be a valid zip archive') from exc

    with archive:
        manifest = _read_package_json(archive, PACKAGE_MANIFEST_NAME)
        if not isinstance(manifest, dict):
            raise ValueError('manifest.json must be an object')

        schema_version = str(manifest.get('schema_version') or '').strip()
        if not schema_version:
            raise ValueError('manifest.json is missing schema_version')

        title = str(manifest.get('title') or '').strip()
        if not title:
            raise ValueError('manifest.json is missing title')

        chapter_entries = _ensure_list(manifest.get('chapters'), 'chapters')
        if not chapter_entries:
            raise ValueError('manifest.json must include at least one chapter')

        annotations: list[dict[str, Any]] = []
        inline_annotations = manifest.get('annotations')
        if inline_annotations is not None:
            annotations.extend(_ensure_list(inline_annotations, 'annotations'))

        annotation_files = _ensure_list(manifest.get('annotation_files'), 'annotation_files')
        for annotation_path in annotation_files:
            annotations.extend(_ensure_list(_read_package_json(archive, str(annotation_path)), str(annotation_path)))

        uploaded_assets: dict[str, dict[str, str]] = {}
        for asset_entry in _ensure_list(manifest.get('assets'), 'assets'):
            if not isinstance(asset_entry, dict):
                raise ValueError('assets entries must be objects')
            raw_path = str(asset_entry.get('path') or '').strip()
            if not raw_path:
                raise ValueError('assets entries must include path')
            asset_path = _normalize_package_path(raw_path)
            filename = asset_entry.get('name') or posixpath.basename(asset_path)
            content_type = asset_entry.get('content_type') or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
            try:
                with archive.open(asset_path) as handle:
                    uploaded_assets[asset_path] = {
                        **upload_source_asset(notebook_id, source_id, str(filename), handle.read(), str(content_type)),
                        'path': asset_path,
                        'content_type': str(content_type),
                        'label': str(asset_entry.get('label') or filename),
                    }
            except KeyError as exc:
                raise ValueError(f'Missing package asset: {asset_path}') from exc

        chapters: list[dict[str, Any]] = []
        aggregated_parts: list[str] = []
        for index, chapter_entry in enumerate(chapter_entries, start=1):
            if not isinstance(chapter_entry, dict):
                raise ValueError('chapters entries must be objects')
            raw_path = str(chapter_entry.get('path') or '').strip()
            if not raw_path:
                raise ValueError('chapters entries must include path')
            chapter_path = _normalize_package_path(raw_path)
            chapter_id = str(chapter_entry.get('id') or f'chapter-{index}').strip()
            chapter_title = str(chapter_entry.get('title') or '').strip() or chapter_id
            markdown_text = _read_package_text(archive, chapter_path)
            rewritten = _rewrite_package_assets(markdown_text, chapter_path, uploaded_assets)
            normalized = normalize_markdown(rewritten, title=chapter_title)
            chapter_asset_manifest = []
            for asset_path, asset in uploaded_assets.items():
                if asset_path in markdown_text or posixpath.basename(asset_path) in markdown_text:
                    chapter_asset_manifest.append(asset)
            chapters.append({
                'id': chapter_id,
                'title': chapter_title,
                'order': int(chapter_entry.get('order') or index),
                'summary': str(chapter_entry.get('summary') or ''),
                'path': chapter_path,
                'text': normalized,
                'asset_manifest': chapter_asset_manifest,
            })
            aggregated_parts.append(normalized.strip())

        chapters.sort(key=lambda item: (item['order'], item['title']))
        toc = manifest.get('toc')
        toc_entries = _ensure_list(toc, 'toc') if toc is not None else _build_default_toc(chapters)
        reader_config = manifest.get('reader_config') if isinstance(manifest.get('reader_config'), dict) else {}
        aggregated_markdown = '\n\n'.join(part for part in aggregated_parts if part).strip() + '\n'
        asset_manifest = list(uploaded_assets.values())

        return {
            'schema_version': schema_version,
            'title': title,
            'description': str(manifest.get('description') or ''),
            'package_manifest': manifest,
            'toc': toc_entries,
            'chapters': chapters,
            'annotations': annotations,
            'reader_config': reader_config,
            'asset_manifest': asset_manifest,
            'aggregated_markdown': aggregated_markdown,
            'document_mode': 'import_package',
        }


def bind_source_import_package(
    notebook_id: str,
    source_id: str,
    package_bytes: bytes,
) -> dict[str, Any]:
    parsed = parse_source_import_package(notebook_id, source_id, package_bytes)
    profile = bind_source_document(
        notebook_id=notebook_id,
        source_id=source_id,
        markdown_text=parsed['aggregated_markdown'],
        asset_manifest=parsed['asset_manifest'],
    )
    merged = {
        **profile,
        'display_title': parsed['title'] or profile.get('display_title', ''),
        'description': parsed['description'] or profile.get('description', ''),
        'package_manifest': parsed['package_manifest'],
        'toc': parsed['toc'],
        'chapters': parsed['chapters'],
        'annotations': parsed['annotations'],
        'reader_config': parsed['reader_config'],
        'document_status': 'ready',
    }
    SourceProfileManager.save(merged)
    return SourceProfileManager.get(notebook_id, source_id) or merged


def get_source_chapter_text(notebook_id: str, source_id: str, chapter_id: str) -> dict[str, Any]:
    profile = SourceProfileManager.get(notebook_id, source_id)
    if not profile:
        raise ValueError('Source profile not found')
    for chapter in profile.get('chapters', []):
        if str(chapter.get('id')) == chapter_id:
            return {
                'id': chapter_id,
                'title': str(chapter.get('title') or chapter_id),
                'text': str(chapter.get('text') or ''),
                'order': chapter.get('order', 0),
                'summary': chapter.get('summary') or '',
            }
    raise ValueError('Chapter not found')


def normalize_markdown(markdown_text: str, title: str | None = None) -> str:
    """Apply minimal formatting-only normalization for reader-friendly markdown."""
    text = markdown_text.replace('\r\n', '\n').replace('\r', '\n')
    lines = [line.rstrip() for line in text.split('\n')]
    normalized: list[str] = []
    saw_title = False

    for raw_line in lines:
        line = raw_line
        heading_match = re.match(r'^(#{1,6})(\S)', line)
        if heading_match:
            line = f"{heading_match.group(1)} {heading_match.group(2)}{line[heading_match.end():]}"

        if line.startswith('# '):
            saw_title = True
        normalized.append(line)

    while normalized and not normalized[0].strip():
        normalized.pop(0)

    if title and not saw_title:
        normalized.insert(0, f'# {title.strip()}')
        normalized.insert(1, '')

    cleaned = '\n'.join(normalized)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip() + '\n'


def replace_asset_urls(markdown_text: str, asset_manifest: Iterable[dict[str, Any]]) -> str:
    replaced = markdown_text
    for asset in asset_manifest:
        original = asset.get('original_url') or asset.get('original') or asset.get('source_url')
        url = asset.get('url')
        if original and url:
            replaced = replaced.replace(original, url)
    return replaced


def build_analysis_cache_key(parts: Iterable[str]) -> str:
    normalized = '||'.join(WHITESPACE_RE.sub(' ', part or '').strip() for part in parts)
    return hashlib.sha1(normalized.encode('utf-8')).hexdigest()


def parse_json_payload(text: str, required_key: str | None = None) -> dict[str, Any]:
    candidate = text.strip()
    block_match = JSON_BLOCK_RE.search(candidate)
    if block_match:
        candidate = block_match.group(1)
    else:
        object_match = JSON_OBJECT_RE.search(candidate)
        if object_match:
            candidate = object_match.group(1)

    payload = json.loads(candidate)
    if required_key and required_key not in payload:
        raise ValueError(f'Missing required key: {required_key}')
    return payload


def ask_source(notebook_id: str, source_id: str, prompt: str) -> dict[str, Any]:
    async def fetch():
        async with await get_client_for_notebook_async(notebook_id) as client:
            result = await client.chat.ask(
                notebook_id=notebook_id,
                question=prompt,
                source_ids=[source_id],
            )
            return {
                'answer': result.answer,
                'references': [{
                    'source_id': ref.source_id,
                    'citation_number': ref.citation_number,
                    'cited_text': ref.cited_text,
                    'start_char': ref.start_char,
                    'end_char': ref.end_char,
                } for ref in result.references] if result.references else [],
            }

    return run_async(fetch())


def get_or_generate_analysis(
    *,
    notebook_id: str,
    source_id: str,
    analysis_type: str,
    cache_parts: Iterable[str],
    prompt_builder: Callable[[], str],
    required_key: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    cache_key = build_analysis_cache_key(cache_parts)
    if not force:
        cached = AnalysisCacheManager.get(notebook_id, source_id, analysis_type, cache_key)
        if cached is not None:
            return cached

    prompt = prompt_builder()
    result = ask_source(notebook_id, source_id, prompt)
    payload = parse_json_payload(result['answer'], required_key=required_key)
    payload['_references'] = result.get('references', [])
    AnalysisCacheManager.save(notebook_id, source_id, analysis_type, cache_key, payload)
    return payload
