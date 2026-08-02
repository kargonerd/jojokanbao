"""Catalog APIs for notebook-backed libraries and source-bound documents."""

from __future__ import annotations

import json
from flask import Blueprint, jsonify, request

try:
    from admin import require_auth
    from notebook_service import (
        bind_source_document,
        bind_source_import_package,
        get_catalog_notebook,
        get_or_generate_analysis,
        get_source_chapter_text,
        get_source_document_text,
        get_source_record,
        list_catalog_notebooks,
        notebook_publish_readiness,
        parse_json_payload,
        replace_asset_urls,
        normalize_markdown,
        source_publish_readiness,
        sync_notebook_sources,
        upload_notebook_cover,
        upload_source_cover,
    )
    from database import NotebookProfileManager, SourceProfileManager
except ImportError:  # pragma: no cover
    from app.rag.admin import require_auth
    from app.rag.notebook_service import (
        bind_source_document,
        bind_source_import_package,
        get_catalog_notebook,
        get_or_generate_analysis,
        get_source_chapter_text,
        get_source_document_text,
        get_source_record,
        list_catalog_notebooks,
        notebook_publish_readiness,
        normalize_markdown,
        replace_asset_urls,
        source_publish_readiness,
        sync_notebook_sources,
        upload_notebook_cover,
        upload_source_cover,
    )
    from app.rag.database import NotebookProfileManager, SourceProfileManager


catalog_bp = Blueprint('catalog', __name__)


def _json_body():
    return request.get_json(silent=True) or {}


@catalog_bp.route('/api/catalog/notebooks', methods=['GET'])
def list_public_notebooks():
    return jsonify(success=True, data=list_catalog_notebooks(include_unpublished=False))


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>', methods=['GET'])
def get_public_notebook(notebook_id: str):
    notebook = get_catalog_notebook(notebook_id, include_unpublished=False)
    if not notebook:
        return jsonify(success=False, error='Notebook not found'), 404
    sources = sync_notebook_sources(notebook_id, include_unpublished=False)
    return jsonify(success=True, data={**notebook, 'sources': sources})


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources', methods=['GET'])
def list_public_sources(notebook_id: str):
    notebook = get_catalog_notebook(notebook_id, include_unpublished=False)
    if not notebook:
        return jsonify(success=False, error='Notebook not found'), 404
    return jsonify(success=True, data=sync_notebook_sources(notebook_id, include_unpublished=False))


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>', methods=['GET'])
def get_public_source(notebook_id: str, source_id: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404
    notebook = get_catalog_notebook(notebook_id, include_unpublished=False)
    return jsonify(success=True, data={**source, 'notebook': notebook})


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/document', methods=['GET'])
def get_public_source_document(notebook_id: str, source_id: str):
    try:
        payload = get_source_document_text(notebook_id, source_id)
        notebook = get_catalog_notebook(notebook_id, include_unpublished=False)
        source = get_source_record(notebook_id, source_id, include_unpublished=False)
        if not source or not notebook:
            return jsonify(success=False, error='Source not published'), 404
        return jsonify(success=True, data={
            'notebook': notebook,
            'source': source,
            **payload,
        })
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/chapters/<chapter_id>', methods=['GET'])
def get_public_source_chapter(notebook_id: str, source_id: str, chapter_id: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404
    try:
        payload = get_source_chapter_text(notebook_id, source_id, chapter_id)
        return jsonify(success=True, data=payload)
    except ValueError as exc:
        return jsonify(success=False, error=str(exc)), 404
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/analysis/persons', methods=['GET'])
def analyze_source_persons(notebook_id: str, source_id: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404

    try:
        payload = get_or_generate_analysis(
            notebook_id=notebook_id,
            source_id=source_id,
            analysis_type='persons',
            cache_parts=['persons', notebook_id, source_id, source['title']],
            required_key='persons',
            prompt_builder=lambda: f'''请只基于 source《{source["title"]}》的内容，提取文中重要人物并返回 JSON。

要求：
1. 只能依据当前 source，不要综合其他 source。
2. 不要输出 markdown，只输出 JSON。
3. 如果信息不足，返回空数组。

JSON 格式：
{{
  "persons": [
    {{
      "id": "唯一标识，建议英文或拼音",
      "name": "人物姓名",
      "aliases": ["别名1", "别名2"],
      "first_appearance": "首次出现的段落或章节描述",
      "importance": 1,
      "mention_count": 1,
      "role_summary": "人物角色概述"
    }}
  ]
}}'''
        )
        return jsonify(success=True, data=payload.get('persons', []))
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/analysis/persons/<person_name>/events', methods=['GET'])
def analyze_source_person_events(notebook_id: str, source_id: str, person_name: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404

    try:
        payload = get_or_generate_analysis(
            notebook_id=notebook_id,
            source_id=source_id,
            analysis_type='person_events',
            cache_parts=['person_events', notebook_id, source_id, person_name],
            required_key='events',
            prompt_builder=lambda: f'''请只基于 source《{source["title"]}》的内容，分析人物“{person_name}”并返回 JSON。

要求：
1. 只使用当前 source，禁止引用其他 source。
2. 不要输出 markdown，只输出 JSON。
3. 如无明确信息，字段可为空数组或空字符串。

JSON 格式：
{{
  "person": "{person_name}",
  "full_profile": "人物简介",
  "events": [
    {{
      "name": "事件名称",
      "date": "时间",
      "location": "地点",
      "description": "事件描述",
      "significance": "事件意义",
      "related_persons": ["相关人物"],
      "source_section": "来源章节"
    }}
  ],
  "role_changes": [
    {{
      "period": "时期",
      "role": "角色",
      "position": "职位"
    }}
  ],
  "relationships": [
    {{
      "person": "关联人物",
      "relationship": "关系类型",
      "description": "关系说明"
    }}
  ]
}}'''
        )
        return jsonify(success=True, data=payload)
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/analysis/timeline', methods=['POST'])
def analyze_source_timeline(notebook_id: str, source_id: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404

    query = _json_body().get('query', '').strip()
    try:
        payload = get_or_generate_analysis(
            notebook_id=notebook_id,
            source_id=source_id,
            analysis_type='timeline',
            cache_parts=['timeline', notebook_id, source_id, query],
            required_key='timeline',
            prompt_builder=lambda: f'''请只基于 source《{source["title"]}》的内容生成时间线。
{query or "提取文中出现的关键历史事件，按时间顺序整理。"}

要求：
1. 只使用当前 source。
2. 不要输出 markdown，只输出 JSON。
3. 时间可以是 YYYY、YYYY-MM 或 YYYY-MM-DD。

JSON 格式：
{{
  "timeline": [
    {{
      "date": "YYYY-MM-DD",
      "title": "事件标题",
      "description": "事件描述",
      "sources": ["来自当前 source 的证据摘录或章节"]
    }}
  ]
}}'''
        )
        return jsonify(success=True, data=payload)
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/api/catalog/notebooks/<notebook_id>/sources/<source_id>/analysis/relations', methods=['POST'])
def analyze_source_relations(notebook_id: str, source_id: str):
    source = get_source_record(notebook_id, source_id, include_unpublished=False)
    if not source:
        return jsonify(success=False, error='Source not found'), 404

    query = _json_body().get('query', '').strip()
    try:
        payload = get_or_generate_analysis(
            notebook_id=notebook_id,
            source_id=source_id,
            analysis_type='relations',
            cache_parts=['relations', notebook_id, source_id, query],
            required_key='nodes',
            prompt_builder=lambda: f'''请只基于 source《{source["title"]}》的内容，提取人物关系图数据。
{query or "分析文中重要人物及其关系。"}

要求：
1. 只使用当前 source。
2. 不要输出 markdown，只输出 JSON。

JSON 格式：
{{
  "nodes": [
    {{
      "id": "唯一标识",
      "name": "人物姓名",
      "role": "角色/职位",
      "group": "所属群体",
      "importance": 5
    }}
  ],
  "links": [
    {{
      "source": "人物id",
      "target": "人物id",
      "relation": "关系类型",
      "strength": 5
    }}
  ]
}}'''
        )
        return jsonify(success=True, data=payload)
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/admin/notebooks', methods=['GET'])
@require_auth
def list_admin_notebooks():
    return jsonify(success=True, data=list_catalog_notebooks(include_unpublished=True))


@catalog_bp.route('/admin/notebooks/<notebook_id>', methods=['PUT'])
@require_auth
def update_admin_notebook(notebook_id: str):
    profile = NotebookProfileManager.get_by_id(notebook_id)
    if not profile:
        return jsonify(success=False, error='Notebook not found'), 404

    data = _json_body()
    payload = {
        **profile,
        'display_title': data.get('display_title', profile.get('display_title', '')),
        'description': data.get('description', profile.get('description', '')),
        'is_published': data.get('is_published', profile.get('is_published', False)),
        'sort_order': data.get('sort_order', profile.get('sort_order', 0)),
    }
    if payload['is_published']:
        readiness = notebook_publish_readiness(notebook_id)
        if not readiness['ready']:
            return jsonify(success=False, error='Notebook is not ready to publish', details=readiness), 400
    NotebookProfileManager.save(payload)
    return jsonify(success=True, data=get_catalog_notebook(notebook_id, include_unpublished=True))


@catalog_bp.route('/admin/notebooks/<notebook_id>/cover', methods=['POST'])
@require_auth
def upload_admin_notebook_cover(notebook_id: str):
    if 'file' not in request.files:
        return jsonify(success=False, error='No file provided'), 400
    try:
        url = upload_notebook_cover(notebook_id, request.files['file'])
        return jsonify(success=True, cover_url=url)
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/admin/notebooks/<notebook_id>/sources', methods=['GET'])
@require_auth
def list_admin_sources(notebook_id: str):
    try:
        return jsonify(success=True, data=sync_notebook_sources(notebook_id, include_unpublished=True))
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/admin/notebooks/<notebook_id>/sources/<source_id>', methods=['PUT'])
@require_auth
def update_admin_source(notebook_id: str, source_id: str):
    profile = SourceProfileManager.get(notebook_id, source_id)
    if not profile:
        return jsonify(success=False, error='Source not found'), 404

    data = _json_body()
    payload = {
        **profile,
        'display_title': data.get('display_title', profile.get('display_title', '')),
        'description': data.get('description', profile.get('description', '')),
        'is_published': data.get('is_published', profile.get('is_published', False)),
        'sort_order': data.get('sort_order', profile.get('sort_order', 0)),
        'document_status': data.get('document_status', profile.get('document_status', 'missing')),
    }
    if payload['is_published']:
        readiness = source_publish_readiness(notebook_id, source_id)
        if not readiness['ready']:
            return jsonify(success=False, error='Source is not ready to publish', details=readiness), 400
    SourceProfileManager.save(payload)
    updated = get_source_record(notebook_id, source_id, include_unpublished=True)
    return jsonify(success=True, data=updated)


@catalog_bp.route('/admin/notebooks/<notebook_id>/sources/<source_id>/cover', methods=['POST'])
@require_auth
def upload_admin_source_cover(notebook_id: str, source_id: str):
    if 'file' not in request.files:
        return jsonify(success=False, error='No file provided'), 400
    try:
        url = upload_source_cover(notebook_id, source_id, request.files['file'])
        return jsonify(success=True, cover_url=url)
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/admin/notebooks/<notebook_id>/sources/<source_id>/document', methods=['POST'])
@require_auth
def upload_admin_source_document(notebook_id: str, source_id: str):
    if 'markdown' not in request.files:
        return jsonify(success=False, error='markdown file is required'), 400
    if 'pdf' in request.files:
        return jsonify(success=False, error='Only markdown upload is supported'), 400

    markdown_file = request.files['markdown']
    markdown_text = markdown_file.read().decode('utf-8')

    asset_manifest = []
    raw_manifest = request.form.get('asset_manifest')
    if raw_manifest:
        asset_manifest = json.loads(raw_manifest)

    normalized = normalize_markdown(
        replace_asset_urls(markdown_text, asset_manifest),
        title=request.form.get('title')
    )

    try:
        profile = bind_source_document(
            notebook_id=notebook_id,
            source_id=source_id,
            markdown_text=normalized,
            asset_manifest=asset_manifest,
        )
        updated = get_source_record(notebook_id, source_id, include_unpublished=True)
        return jsonify(success=True, data={**(updated or {}), 'profile': profile})
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500


@catalog_bp.route('/admin/notebooks/<notebook_id>/sources/<source_id>/import-package', methods=['POST'])
@require_auth
def import_admin_source_package(notebook_id: str, source_id: str):
    package_file = request.files.get('package')
    if not package_file:
        return jsonify(success=False, error='package file is required'), 400
    try:
        profile = bind_source_import_package(
            notebook_id=notebook_id,
            source_id=source_id,
            package_bytes=package_file.read(),
        )
        updated = get_source_record(notebook_id, source_id, include_unpublished=True)
        return jsonify(success=True, data={**(updated or {}), 'profile': profile})
    except ValueError as exc:
        return jsonify(success=False, error=str(exc)), 400
    except Exception as exc:
        return jsonify(success=False, error=str(exc)), 500
