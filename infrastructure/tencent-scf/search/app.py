import os
from pathlib import Path
from flask import Flask, jsonify, request
from elasticsearch import Elasticsearch
import re
from flask_cors import CORS
from search_overlay import build_search_query, load_patch_state_file, merge_search_hits
from migration_exclusions import build_active_query, hit_to_active_result, load_excluded_ids

def create_elasticsearch_client():
  url = os.environ.get('ELASTICSEARCH_URL')
  username = os.environ.get('ELASTICSEARCH_USERNAME')
  password = os.environ.get('ELASTICSEARCH_PASSWORD')

  if not url:
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
content_index_name = os.environ.get('ELASTICSEARCH_CONTENT_INDEX', 'jojo-content-v1')
overlay_enabled = os.environ.get('SEARCH_OVERLAY', '').lower() in ('1', 'true', 'yes', 'on')
base_index_name = os.environ.get('ELASTICSEARCH_BASE_INDEX')
delta_index_name = os.environ.get('ELASTICSEARCH_DELTA_INDEX')
patch_state_path = os.environ.get('SEARCH_PATCH_STATE_FILE')
overfetch_multiplier = int(os.environ.get('SEARCH_OVERFETCH_MULTIPLIER', '5'))
migrations_dir = Path(os.environ.get(
  'SEARCH_MIGRATIONS_DIR',
  Path(__file__).resolve().parents[3] / 'tools' / 'jojo-admin' / 'server' / 'es_migrations',
))
        
IS_SERVERLESS = bool(os.environ.get('SERVERLESS'))

app = Flask(__name__)
app.config['DEFAULT_CONTENT_TYPE'] = 'application/json'  
app.config['DEFAULT_CHARSET'] = 'utf-8'  
CORS(app, origins=['https://jojokanbao.cn', 'https://reader.jojokanbao.cn', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8080', 'http://localhost:8080'])


@app.route("/health")
def health():
  return jsonify({
    'status': 'ok',
    'elasticsearch': 'configured' if es else 'not_configured',
    'overlay': 'enabled' if overlay_enabled else 'disabled',
    'revisionFiltering': 'enabled'
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
  """Match IDs on both the intended keyword mapping and old dynamic text mappings."""
  return {'bool': {
    'should': [
      {'terms': {field: values}},
      *({'match_phrase': {field: value}} for value in values),
    ],
    'minimum_should_match': 1,
  }}


@app.route("/content/search", methods=["POST"])
def content_search():
  """Search the unified JOJO content index for both readers and Agent tools."""
  if es is None:
    return jsonify({'error': 'search backend is not configured'}), 503
  payload = request.get_json(silent=True) or {}
  query_text = str(payload.get('query') or '').strip()
  if not query_text:
    return jsonify({'error': '搜索词为空'}), 400
  try:
    size = max(1, min(int(payload.get('size') or 8), 20))
  except (TypeError, ValueError):
    return jsonify({'error': 'size 参数错误'}), 400
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
    filters.append({'bool': {
      'should': [{'match_phrase': {'source': value}} for value in sources],
      'minimum_should_match': 1,
    }})
  query = {
    'bool': {
      'must': [{
        'multi_match': {
          'query': query_text,
          'fields': [
            'title^4', 'content',
            'datasetTitle^4', 'itemTitle^4', 'targetTitle^3', 'text',
          ],
          'type': 'best_fields',
          'operator': 'and',
        }
      }],
      'should': [
        {'match_phrase': {'content': {'query': query_text, 'boost': 8}}},
        {'match_phrase': {'text': {'query': query_text, 'boost': 8}}},
      ],
      'filter': filters,
    }
  }
  excluded = load_excluded_ids(migrations_dir, content_index_name)
  if excluded:
    query = build_active_query(query, excluded)
  body = {
    # A long chapter can produce several ES chunks. Overfetch so the API can
    # return distinct source fragments instead of spending every slot on one.
    'size': min(size * 5, 100),
    '_source': [
      'type', 'title', 'content', 'date', 'source', 'metadata',
      'datasetId', 'datasetTitle', 'itemId', 'itemTitle', 'itemType',
      'targetId', 'targetTitle', 'chunkId', 'order', 'text', 'authors',
      'publishedDate', 'manifestObject', 'fragmentObject'
    ],
    'query': query,
    'highlight': {
      'fields': {
        'content': {'fragment_size': 260, 'number_of_fragments': 2},
        'text': {'fragment_size': 260, 'number_of_fragments': 2},
      },
      'pre_tags': ['<mark>'],
      'post_tags': ['</mark>'],
    },
  }
  try:
    data = es.search(index=content_index_name, body=body)
  except Exception as exc:
    app.logger.exception('unified content search failed')
    return jsonify({'error': str(exc)}), 502
  hits = (data.get('hits') or {})
  results = []
  seen_fragments = set()
  for hit in hits.get('hits') or []:
    source = hit.get('_source') or {}
    if dataset_ids and source.get('datasetId') not in dataset_ids:
      continue
    if item_ids and source.get('itemId') not in item_ids:
      continue
    fragment_object = source.get('fragmentObject')
    if fragment_object and fragment_object in seen_fragments:
      continue
    if fragment_object:
      seen_fragments.add(fragment_object)
    highlights = (hit.get('highlight') or {}).get('text') or []
    results.append({
      **source,
      'documentId': hit.get('_id'),
      'score': hit.get('_score'),
      'highlights': ((hit.get('highlight') or {}).get('content') or highlights),
    })
    if len(results) >= size:
      break
  total = hits.get('total') or 0
  if isinstance(total, dict):
    total = total.get('value', 0)
  return jsonify({'data': {'total': total, 'results': results}})


def is_quoted_only_query(query):
  pattern = r'^"[^"]+"$'
  return bool(re.match(pattern, query))


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
          if is_quoted_only_query(query_str):
              quoted_text = query_str[1:-1]
              query = {
                  "query": {
                      "bool": {
                          "should": [
                              {
                                  "wildcard": {
                                      "title.keyword": f"*{quoted_text}*"
                                  }
                              },
                              {
                                  "wildcard": {
                                      "content.keyword": f"*{quoted_text}*"
                                  }
                              }
                          ],
                          "minimum_should_match": 1
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
                      "bool": {
                          "must": [
                              {
                                  "query_string": {
                                    "query": query_str,
                                    "fields": ["title^2", "content"]
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
          if is_quoted_only_query(query_str):
              quoted_text = query_str[1:-1]
              query = {
                  "query": {
                      "bool": {
                          "should": [
                              {
                                  "wildcard": {
                                      "title.keyword": f"*{quoted_text}*"
                                  }
                              },
                              {
                                  "wildcard": {
                                      "content.keyword": f"*{quoted_text}*"
                                  }
                              }
                          ],
                          "minimum_should_match": 1
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
                            "fields": ["title^2", "content"]                      
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
        load_excluded_ids(migrations_dir, index_name),
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
    except Exception as e:
      app.logger.error("search from ES error:", e)
      return jsonify({"error": "服务端错误"})


if __name__ == '__main__':
  # 启动服务，监听 9000 端口，监听地址为 0.0.0.0
  app.run(debug=IS_SERVERLESS != True, port=9000, host='0.0.0.0')
