import json
import os
from datetime import datetime
from pathlib import Path
from flask import Flask, jsonify, request
from elasticsearch import Elasticsearch
from flask_cors import CORS
from migration_exclusions import build_active_query
from search_state import CosSearchState, SearchStateUnavailable

def create_elasticsearch_client(prefix='CONTENT_ELASTICSEARCH', require_auth=True):
  url = os.environ.get(f'{prefix}_URL')
  username = os.environ.get(f'{prefix}_USERNAME')
  password = os.environ.get(f'{prefix}_PASSWORD')

  if not url or (require_auth and not (username and password)):
    return None

  kwargs = {
    'sniff_on_start': False,
    'sniff_on_connection_fail': False,
    'sniffer_timeout': None,
  }
  if username and password:
    kwargs['http_auth'] = (username, password)

  return Elasticsearch([url], **kwargs)


content_es = create_elasticsearch_client('CONTENT_ELASTICSEARCH', require_auth=True)
content_index_name = os.environ.get('CONTENT_ELASTICSEARCH_INDEX', '').strip()
search_state = CosSearchState.from_environment()


def _build_info():
  path = Path(__file__).with_name('build_info.json')
  try:
    payload = json.loads(path.read_text(encoding='utf-8'))
    return payload if isinstance(payload, dict) else {}
  except (OSError, ValueError):
    return {'gitCommit': 'development', 'sourceFingerprint': 'development'}


build_info = _build_info()
        
IS_SERVERLESS = bool(os.environ.get('SERVERLESS'))

app = Flask(__name__)
app.config['DEFAULT_CONTENT_TYPE'] = 'application/json'  
app.config['DEFAULT_CHARSET'] = 'utf-8'  
SEARCH_ALLOWED_ORIGINS = [
  'https://jojokanbao.cn',
  'https://reader.jojokanbao.cn',
  'https://beta.jojokanbao.cn',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
]
CORS(app, origins=SEARCH_ALLOWED_ORIGINS)


@app.route("/health")
def health():
  return jsonify({
    'status': 'ok',
    'build': build_info,
    'contentElasticsearch': (
      'configured' if content_es and content_index_name else 'not_configured'
    ),
    'revisionFiltering': search_state.status(),
  })


def _string_list(value, limit=100):
  if not isinstance(value, list):
    return []
  return [item for item in value[:limit] if isinstance(item, str) and item]


def _identity_filter(field, values):
  return {'terms': {field: values}}


def _valid_date_range(start_date, end_date):
  if bool(start_date) != bool(end_date):
    return False
  if not start_date:
    return True
  try:
    start = datetime.strptime(start_date, '%Y-%m-%d').date()
    end = datetime.strptime(end_date, '%Y-%m-%d').date()
  except ValueError:
    return False
  return start <= end


@app.route("/content/search", methods=["POST"])
def content_search():
  """Search the unified JOJO content index for both readers and Agent tools."""
  if content_es is None or not content_index_name:
    return jsonify({'error': 'search backend is not configured'}), 503
  payload = request.get_json(silent=True) or {}
  query_text = str(payload.get('query') or '').strip()
  if not query_text:
    return jsonify({'error': '搜索词为空'}), 400
  try:
    size = max(1, min(int(payload.get('size') or 8), 20))
  except (TypeError, ValueError):
    return jsonify({'error': 'size 参数错误'}), 400
  try:
    page = int(payload.get('page') or 1)
  except (TypeError, ValueError):
    return jsonify({'error': 'page 参数错误'}), 400
  if page < 1 or (page - 1) * size + size > 10000:
    return jsonify({'error': 'page 参数错误'}), 400
  sort_order = str(payload.get('sort') or '')
  if sort_order not in ('', 'match', 'timeAsc', 'timeDesc'):
    return jsonify({'error': 'sort 参数错误'}), 400
  start_date = str(payload.get('startDate') or '').strip()
  end_date = str(payload.get('endDate') or '').strip()
  if not _valid_date_range(start_date, end_date):
    return jsonify({'error': '日期范围参数错误'}), 400
  filters = []
  dataset_ids = _string_list(payload.get('datasetIds'))
  item_ids = _string_list(payload.get('itemIds'))
  document_types = _string_list(payload.get('types'))
  sources = _string_list(payload.get('sources'))
  if dataset_ids:
    filters.append(_identity_filter('datasetId', dataset_ids))
  if item_ids:
    filters.append(_identity_filter('itemId', item_ids))
  if document_types:
    filters.append({'terms': {'type': document_types}})
  if sources:
    filters.append({'terms': {'source': sources}})
  if start_date and end_date:
    filters.append({'range': {'date': {'gte': start_date, 'lte': end_date}}})
  query = {
    'bool': {
      'must': [{
        'multi_match': {
          'query': query_text,
          'fields': ['title^4', 'content'],
          'type': 'best_fields',
          'operator': 'and',
        }
      }],
      'should': [
        {'match_phrase': {'title': {'query': query_text, 'boost': 16}}},
        {'match_phrase': {'content': {'query': query_text, 'boost': 8}}},
      ],
      'filter': filters,
    }
  }
  try:
    excluded = search_state.excluded_ids(content_index_name)
  except SearchStateUnavailable as exc:
    app.logger.error('search state unavailable: %s', exc)
    return jsonify({'error': '搜索修订状态暂时不可用'}), 503
  if excluded:
    query = build_active_query(query, excluded)
  body = {
    'from': (page - 1) * size,
    'size': size,
    # The endpoint deliberately caps deep pagination at 10,000 results, so an
    # exact count beyond that window only adds cluster work without helping UI.
    'track_total_hits': 10000,
    '_source': ['type', 'datasetId', 'itemId', 'title', 'content', 'date', 'source', 'metadata'],
    'query': query,
    'highlight': {
      'fields': {
        'title': {'number_of_fragments': 0},
        'content': {'fragment_size': 260, 'number_of_fragments': 2},
      },
      'pre_tags': ['<mark>'],
      'post_tags': ['</mark>'],
    },
  }
  if sort_order in ('timeAsc', 'timeDesc'):
    body['sort'] = [
      {'date': {'order': 'asc' if sort_order == 'timeAsc' else 'desc', 'missing': '_last'}},
      {'_score': {'order': 'desc'}},
    ]
  try:
    data = content_es.search(index=content_index_name, body=body)
  except Exception:
    app.logger.exception('unified content search failed')
    return jsonify({'error': '搜索服务暂时不可用'}), 502
  hits = (data.get('hits') or {})
  results = []
  for hit in hits.get('hits') or []:
    source = hit.get('_source') or {}
    if dataset_ids and source.get('datasetId') not in dataset_ids:
      continue
    if item_ids and source.get('itemId') not in item_ids:
      continue
    results.append({
      **source,
      'documentId': hit.get('_id'),
      'score': hit.get('_score'),
      'titleHighlights': ((hit.get('highlight') or {}).get('title') or []),
      'highlights': ((hit.get('highlight') or {}).get('content') or []),
    })
    if len(results) >= size:
      break
  total = hits.get('total') or 0
  if isinstance(total, dict):
    total = total.get('value', 0)
  return jsonify({'data': {'total': total, 'results': results}})


if __name__ == '__main__':
  # 启动服务，监听 9000 端口，监听地址为 0.0.0.0
  app.run(debug=IS_SERVERLESS != True, port=9000, host='0.0.0.0')
