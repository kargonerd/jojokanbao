import json
import os
from pathlib import Path
from flask import Flask, jsonify, request
from elasticsearch import Elasticsearch
import re
from flask_cors import CORS
from search_overlay import build_search_query, load_patch_state_file, merge_search_hits
from migration_exclusions import build_active_query, hit_to_active_result
from search_state import CosSearchState, SearchStateUnavailable

def create_elasticsearch_client(prefix='ELASTICSEARCH', require_auth=False):
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


es = create_elasticsearch_client()
index_name = os.environ.get('ELASTICSEARCH_INDEX', 'jojo-67f10bu8')
content_es = create_elasticsearch_client('CONTENT_ELASTICSEARCH', require_auth=True)
content_index_name = os.environ.get('CONTENT_ELASTICSEARCH_INDEX', '').strip()
overlay_enabled = os.environ.get('SEARCH_OVERLAY', '').lower() in ('1', 'true', 'yes', 'on')
base_index_name = os.environ.get('ELASTICSEARCH_BASE_INDEX')
delta_index_name = os.environ.get('ELASTICSEARCH_DELTA_INDEX')
patch_state_path = os.environ.get('SEARCH_PATCH_STATE_FILE')
overfetch_multiplier = int(os.environ.get('SEARCH_OVERFETCH_MULTIPLIER', '5'))
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
CORS(app, origins=['https://jojokanbao.cn', 'https://reader.jojokanbao.cn', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8080', 'http://localhost:8080'])


@app.route("/health")
def health():
  return jsonify({
    'status': 'ok',
    'build': build_info,
    'elasticsearch': 'configured' if es else 'not_configured',
    'contentElasticsearch': (
      'configured' if content_es and content_index_name else 'not_configured'
    ),
    'overlay': 'enabled' if overlay_enabled else 'disabled',
    'revisionFiltering': search_state.status(),
  })

def processKeyword(keyword):
  keyword = re.sub(r'\band\b', 'AND', keyword, flags=re.IGNORECASE)
  keyword = re.sub(r'\bor\b', 'OR', keyword, flags=re.IGNORECASE)
  keyword = re.sub(r'\bnot\b', 'NOT', keyword, flags=re.IGNORECASE)
  keyword = keyword.replace("“", "\"").replace("”", "\"").replace("‘", "\"").replace("’", "\"")
  return keyword


def _string_list(value, limit=100):
  if not isinstance(value, list):
    return []
  return [item for item in value[:limit] if isinstance(item, str) and item]


def _identity_filter(field, values):
  return {'terms': {field: values}}


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
  if bool(start_date) != bool(end_date):
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


def get_sort_query(sort_order):
  if sort_order == 'timeAsc':
    return {
      "date": {
        "order": "asc" 
      }
    }
  elif sort_order == 'timeDesc':
    return {
      "date": {
        "order": "desc" 
      }
    }
  else:
    return None


def search_overlay_response():
  if not base_index_name or not delta_index_name:
    return jsonify({'error': 'overlay search index is not configured'}), 503

  keyword = request.args.get('keyword')
  if not keyword:
    return jsonify({'error': '搜索词为空'})

  page = request.args.get('page') or "1"
  if page.isdigit():
    page = int(page)
  else:
    return jsonify({"error": "参数错误"})

  size = request.args.get('size') or "10"
  if size.isdigit():
    size = int(size)
  else:
    return jsonify({"error": "参数错误"})

  from_num = (page - 1) * size
  if from_num + size > 10000 or size > 50:
    return jsonify({"error": "参数错误"})

  fetch_size = min(max(page * size * overfetch_multiplier, size), 500)
  query = build_search_query(
    keyword,
    from_num=0,
    size=fetch_size,
    source=request.args.get('source'),
    start_date=request.args.get('startDate'),
    end_date=request.args.get('endDate'),
    sort_order=request.args.get('sort'),
  )

  base_data = es.search(index=base_index_name, body=query)
  delta_data = es.search(index=delta_index_name, body=query)
  if base_data.get('timed_out') or delta_data.get('timed_out'):
    app.logger.error("overlay search timeout, base: %s, delta: %s", base_data, delta_data)
    return jsonify({'error': '请求超时'})

  base_hits = ((base_data.get('hits') or {}).get('hits')) or []
  delta_hits = ((delta_data.get('hits') or {}).get('hits')) or []
  patch_state = load_patch_state_file(patch_state_path)
  total, results = merge_search_hits(base_hits, delta_hits, patch_state, offset=from_num, size=size)
  return jsonify({'data': {'total': total, 'totalApproximate': True, 'results': results}})

  
@app.route("/search")
def search():
    try:
      if es is None:
        return jsonify({'error': 'search backend is not configured'}), 503
      if overlay_enabled:
        return search_overlay_response()

      keyword = request.args.get('keyword')
      if not keyword:
        return jsonify({'error': '搜索词为空'})
      keyword = processKeyword(keyword)
      page = request.args.get('page')
      if not page:
        page = "1"
      if page.isdigit():  
        page = int(page)  
      else:  
        return jsonify({"error": "参数错误"})
      size = request.args.get('size')
      if not size:
        size = "10"
      if size.isdigit():  
        size = int(size)  
      else:  
        return jsonify({"error": "参数错误"})
      from_num = (page-1) * size
      if from_num + size > 10000 or size > 50:
        return jsonify({"error": "参数错误"})
      source = request.args.get('source')
      query_str = keyword
      if source:
        query_str += ' AND source:' + source
      
      startDate = request.args.get('startDate')
      endDate = request.args.get('endDate')
      if startDate and endDate:
          date_range_query = {
              "range": {
                  "date": {
                      "gte": startDate,
                      "lte": endDate
                  }
              }
          }
          query = {
              "query": {
                  "bool": {
                      "must": [
                          {
                              "query_string": {
                                "query": query_str,
                                "fields": ["title^2", "content"],
                                "default_operator": "OR",
                                "minimum_should_match": "60%",
                                "analyzer": "ik_smart"
                              }
                          },
                          date_range_query
                      ]
                  }
              },
              "highlight": {
                  "fields": {
                      "title": {},
                      "content": {}
                  },
                  "fragment_size": 2147483647,
                  "pre_tags": "@highlight@",
                  "post_tags": "@/highlight@"
              },
              "from": from_num,
              "size": size,
          }
      else:
          query = {
              "query": {
                   "query_string": {
                        "query": query_str,
                        "fields": ["title^2", "content"],
                        "default_operator": "OR",
                        "minimum_should_match": "60%",
                        "analyzer": "ik_smart"
                    }
              },
              "highlight": {
                  "fields": {
                      "title": {},
                      "content": {}
                  },
                  "fragment_size": 2147483647,
                  "pre_tags": "@highlight@",
                  "post_tags": "@/highlight@"
              },
              "from": from_num,
              "size": size,
          }

      sort_order = request.args.get('sort')
      sort_query = get_sort_query(sort_order)
      
      if sort_query:
        query['sort'] = sort_query
      query['query'] = build_active_query(
        query['query'],
        search_state.excluded_ids(index_name),
      )
      data = es.search(index=index_name, body=query)
      if not data:
        app.logger.error("search from ES return no data, ret: %s", data)
        return jsonify({"error": "服务端错误"})
      timeout = data.get('timed_out')
      if timeout:
        app.logger.error("search from ES timeout, ret: %s", data)
        return jsonify({'error': '请求超时'})
      empty_res = {'data': {'total': 0, 'results': []}}
      hits = data.get('hits')
      if not hits:
        app.logger.warn("search from ES no hits, ret: %s", data)
        return jsonify(empty_res)
      total = hits.get('total')
      if not total:
        app.logger.warn("search from ES no total, ret: %s", data)
        return jsonify(empty_res)
      total_num = total.get('value')
      if not total_num:
        app.logger.warn("search from ES no total number, ret: %s", data)
        return jsonify(empty_res)
      hits_list = hits.get('hits')
      if not hits_list:
        app.logger.warn("search from ES no hit list, ret: %s", data)
        return jsonify(empty_res)
      results = []
      for hit in hits_list:
        if not hit.get('_source'):
          app.logger.warn("search from ES hit empty, hits list: %s", hits_list)
          continue
        results.append(hit_to_active_result(hit))
      return jsonify({'data': {'total': total_num, 'results': results}})
    except SearchStateUnavailable as e:
      app.logger.error("search state unavailable: %s", e)
      return jsonify({"error": "搜索修订状态暂时不可用"}), 503
    except Exception as e:
      app.logger.error("search from ES error: %s", e)
      return jsonify({"error": "服务端错误"})


if __name__ == '__main__':
  # 启动服务，监听 9000 端口，监听地址为 0.0.0.0
  app.run(debug=IS_SERVERLESS != True, port=9000, host='0.0.0.0')
