from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest

from scf.notebook_service import bind_source_import_package, get_source_chapter_text, parse_source_import_package


FIXTURE_DIR = Path(__file__).parent / 'fixtures' / 'import-package'


def build_fixture_zip(overrides: dict[str, bytes | str | None] | None = None) -> bytes:
    overrides = overrides or {}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in FIXTURE_DIR.rglob('*'):
            if not path.is_file():
                continue
            relative_path = path.relative_to(FIXTURE_DIR).as_posix()
            if overrides.get(relative_path) is None and relative_path in overrides:
                continue
            archive.writestr(relative_path, overrides.get(relative_path, path.read_bytes()))

        for relative_path, content in overrides.items():
            if content is not None and not (FIXTURE_DIR / relative_path).exists():
                archive.writestr(relative_path, content)
    return buffer.getvalue()


def test_parse_source_import_package(monkeypatch):
    uploaded = []

    def fake_upload_source_asset(notebook_id, source_id, filename, data, content_type):
        uploaded.append((notebook_id, source_id, filename, content_type, len(data)))
        return {
            'filename': filename,
            'key': f'mock/{filename}',
            'url': f'https://example.test/{filename}',
        }

    monkeypatch.setattr('scf.notebook_service.upload_source_asset', fake_upload_source_asset)

    parsed = parse_source_import_package('nb-1', 'src-1', build_fixture_zip())

    assert parsed['schema_version'] == '1.0'
    assert parsed['title'] == '毛泽东文稿示例'
    assert len(parsed['chapters']) == 2
    assert parsed['toc'][0]['chapter_id'] == 'preface'
    assert parsed['annotations'][0]['chapter_id'] == 'preface'
    assert parsed['reader_config']['font_size'] == 18
    assert 'https://example.test/cover.png' in parsed['aggregated_markdown']
    assert uploaded and uploaded[0][2] == 'cover.png'


def test_fixture_manifest_is_valid_json():
    manifest = json.loads((FIXTURE_DIR / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['schema_version'] == '1.0'
    assert len(manifest['chapters']) >= 1


def test_parse_source_import_package_requires_manifest():
    with pytest.raises(ValueError, match='Missing package file: manifest.json'):
        parse_source_import_package('nb-1', 'src-1', build_fixture_zip({'manifest.json': None}))


def test_parse_source_import_package_rejects_invalid_manifest_json():
    with pytest.raises(ValueError, match='Invalid JSON in manifest.json'):
        parse_source_import_package('nb-1', 'src-1', build_fixture_zip({'manifest.json': '{bad'}))


def test_parse_source_import_package_requires_chapter_path(monkeypatch):
    monkeypatch.setattr('scf.notebook_service.upload_source_asset', lambda *args: {
        'filename': args[2],
        'key': f'mock/{args[2]}',
        'url': f'https://example.test/{args[2]}',
    })
    manifest = json.loads((FIXTURE_DIR / 'manifest.json').read_text(encoding='utf-8'))
    manifest['chapters'][0].pop('path')

    with pytest.raises(ValueError, match='chapters entries must include path'):
        parse_source_import_package('nb-1', 'src-1', build_fixture_zip({'manifest.json': json.dumps(manifest)}))


def test_parse_source_import_package_requires_existing_chapter_file(monkeypatch):
    monkeypatch.setattr('scf.notebook_service.upload_source_asset', lambda *args: {
        'filename': args[2],
        'key': f'mock/{args[2]}',
        'url': f'https://example.test/{args[2]}',
    })
    manifest = json.loads((FIXTURE_DIR / 'manifest.json').read_text(encoding='utf-8'))
    manifest['chapters'][0]['path'] = 'chapters/missing.md'

    with pytest.raises(ValueError, match='Missing package file: chapters/missing.md'):
        parse_source_import_package('nb-1', 'src-1', build_fixture_zip({'manifest.json': json.dumps(manifest)}))


def test_bind_source_import_package_saves_structured_profile(monkeypatch):
    saved_profiles = []
    base_profile = {
        'notebook_id': 'nb-1',
        'source_id': 'src-1',
        'source_title': 'Source',
        'display_title': 'Source',
        'markdown_url': '',
        'asset_manifest': [],
        'document_status': 'missing',
    }

    monkeypatch.setattr('scf.notebook_service.upload_source_asset', lambda *args: {
        'filename': args[2],
        'key': f'mock/{args[2]}',
        'url': f'https://example.test/{args[2]}',
    })
    monkeypatch.setattr('scf.notebook_service.cos_manager.upload_file', lambda *args, **kwargs: 'file:///tmp/source.md')
    monkeypatch.setattr('scf.notebook_service.SourceProfileManager.get', lambda notebook_id, source_id: saved_profiles[-1] if saved_profiles else base_profile)
    monkeypatch.setattr('scf.notebook_service.SourceProfileManager.save', lambda profile: saved_profiles.append(profile) or True)

    profile = bind_source_import_package('nb-1', 'src-1', build_fixture_zip())

    assert profile['document_status'] == 'ready'
    assert profile['package_manifest']['schema_version'] == '1.0'
    assert profile['chapters'][0]['id'] == 'preface'
    assert profile['toc'][0]['chapter_id'] == 'preface'
    assert profile['annotations'][0]['chapter_id'] == 'preface'
    assert profile['reader_config']['font_size'] == 18


def test_get_source_chapter_text_returns_selected_chapter(monkeypatch):
    monkeypatch.setattr('scf.notebook_service.SourceProfileManager.get', lambda notebook_id, source_id: {
        'chapters': [
            {'id': 'preface', 'title': '前言', 'text': '# 前言', 'order': 1, 'summary': '导言'},
            {'id': 'chapter-1', 'title': '第一章', 'text': '# 第一章', 'order': 2},
        ],
    })

    chapter = get_source_chapter_text('nb-1', 'src-1', 'chapter-1')

    assert chapter == {
        'id': 'chapter-1',
        'title': '第一章',
        'text': '# 第一章',
        'order': 2,
        'summary': '',
    }


def test_get_source_chapter_text_reports_missing_chapter(monkeypatch):
    monkeypatch.setattr('scf.notebook_service.SourceProfileManager.get', lambda notebook_id, source_id: {'chapters': []})

    with pytest.raises(ValueError, match='Chapter not found'):
        get_source_chapter_text('nb-1', 'src-1', 'missing')
