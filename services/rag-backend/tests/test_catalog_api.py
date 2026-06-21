from __future__ import annotations

import io

import pytest
from flask import Flask

import scf.admin as admin
import scf.catalog_api as catalog_api


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(admin, 'verify_token', lambda token: (True, None))

    app = Flask(__name__)
    app.register_blueprint(catalog_api.catalog_bp)
    return app.test_client()


@pytest.fixture
def published_source(monkeypatch):
    notebook = {'id': 'nb-1', 'title': '文库'}
    source = {'id': 'src-1', 'title': '文稿', 'kind': 'document'}

    monkeypatch.setattr(catalog_api, 'get_catalog_notebook', lambda notebook_id, include_unpublished=False: notebook)
    monkeypatch.setattr(catalog_api, 'get_source_record', lambda notebook_id, source_id, include_unpublished=False: source)
    return notebook, source


def test_public_source_document_returns_envelope(client, published_source, monkeypatch):
    monkeypatch.setattr(catalog_api, 'get_source_document_text', lambda notebook_id, source_id: {
        'id': source_id,
        'title': '文稿',
        'text': '# 正文',
        'chapters': [],
    })

    response = client.get('/api/catalog/notebooks/nb-1/sources/src-1/document')
    payload = response.get_json()

    assert response.status_code == 200
    assert payload['success'] is True
    assert payload['data']['notebook']['id'] == 'nb-1'
    assert payload['data']['source']['id'] == 'src-1'
    assert payload['data']['text'] == '# 正文'


def test_public_source_chapter_returns_404_for_missing_chapter(client, published_source, monkeypatch):
    def fail(*args):
        raise ValueError('Chapter not found')

    monkeypatch.setattr(catalog_api, 'get_source_chapter_text', fail)

    response = client.get('/api/catalog/notebooks/nb-1/sources/src-1/chapters/missing')
    payload = response.get_json()

    assert response.status_code == 404
    assert payload == {'success': False, 'error': 'Chapter not found'}


def test_public_source_chapter_returns_data(client, published_source, monkeypatch):
    monkeypatch.setattr(catalog_api, 'get_source_chapter_text', lambda notebook_id, source_id, chapter_id: {
        'id': chapter_id,
        'title': '第一章',
        'text': '# 第一章',
    })

    response = client.get('/api/catalog/notebooks/nb-1/sources/src-1/chapters/chapter-1')
    payload = response.get_json()

    assert response.status_code == 200
    assert payload['success'] is True
    assert payload['data']['id'] == 'chapter-1'


def test_admin_import_package_requires_file(client):
    response = client.post('/admin/notebooks/nb-1/sources/src-1/import-package', headers={'Authorization': 'Bearer test'})
    payload = response.get_json()

    assert response.status_code == 400
    assert payload == {'success': False, 'error': 'package file is required'}


def test_admin_import_package_returns_profile(client, monkeypatch):
    monkeypatch.setattr(catalog_api, 'bind_source_import_package', lambda notebook_id, source_id, package_bytes: {
        'notebook_id': notebook_id,
        'source_id': source_id,
        'document_status': 'ready',
    })
    monkeypatch.setattr(catalog_api, 'get_source_record', lambda notebook_id, source_id, include_unpublished=True: {
        'id': source_id,
        'title': '文稿',
    })

    response = client.post(
        '/admin/notebooks/nb-1/sources/src-1/import-package',
        headers={'Authorization': 'Bearer test'},
        data={'package': (io.BytesIO(b'zip'), 'package.zip')},
        content_type='multipart/form-data',
    )
    payload = response.get_json()

    assert response.status_code == 200
    assert payload['success'] is True
    assert payload['data']['profile']['document_status'] == 'ready'


def test_analysis_error_returns_json_envelope(client, published_source, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError('analysis failed')

    monkeypatch.setattr(catalog_api, 'get_or_generate_analysis', fail)

    response = client.get('/api/catalog/notebooks/nb-1/sources/src-1/analysis/persons')
    payload = response.get_json()

    assert response.status_code == 500
    assert payload == {'success': False, 'error': 'analysis failed'}
