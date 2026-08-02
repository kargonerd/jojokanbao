"""
人物信息提取API
利用NotebookLM API从文献中实时提取人物信息
"""

import json
import re
import os
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
from collections import defaultdict
from flask import Blueprint, jsonify, request, current_app

# Import NotebookLM client
try:
    from notebooklm import NotebookLMClient
    from notebooklm.auth import fetch_tokens, AuthTokens
except ImportError:
    pass

# Import admin functions for notebook access
try:
    from admin import get_selected_notebooks, get_accounts
except ImportError:
    from app.rag.admin import get_selected_notebooks, get_accounts


person_bp = Blueprint('person', __name__, url_prefix='/api')


def _load_env_file():
    """Load .env file if not already loaded"""
    import os
    if 'SELECTED_NOTEBOOKS' in os.environ:
        return
    
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
    if not os.path.exists(env_path):
        env_path = os.path.join(os.getcwd(), '.env')
    
    if os.path.exists(env_path):
        print(f"[DEBUG] Loading .env from: {env_path}")
        with open(env_path, 'r', encoding='utf-8') as f:
            content = f.read()
            i = 0
            while i < len(content):
                line_start = i
                while i < len(content) and content[i] != '\n':
                    i += 1
                line = content[line_start:i].strip()
                i += 1
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    key, value = line.split('=', 1)
                    key = key.strip()
                    value = value.strip()
                    if value.startswith('[') or value.startswith('{'):
                        brace_count = 0
                        in_string = False
                        string_char = None
                        json_start = line_start + line.index('=') + 1
                        j = json_start
                        while j < len(content):
                            c = content[j]
                            if not in_string:
                                if c in '"\'':
                                    in_string = True
                                    string_char = c
                                elif c == '[' or c == '{':
                                    brace_count += 1
                                elif c == ']' or c == '}':
                                    brace_count -= 1
                                    if brace_count == 0:
                                        value = content[json_start:j+1].strip()
                                        i = j + 1
                                        break
                            else:
                                if c == string_char and content[j-1] != '\\':
                                    in_string = False
                            j += 1
                    os.environ[key] = value
        print(f"[DEBUG] .env loaded, SELECTED_NOTEBOOKS: {'SELECTED_NOTEBOOKS' in os.environ}")


def get_notebook_client(notebook_id: str) -> Optional[Any]:
    """获取NotebookLM客户端实例"""
    try:
        print(f"[DEBUG] Getting notebook client for: {notebook_id}")
        
        # Ensure env vars are loaded
        _load_env_file()
        
        selected = get_selected_notebooks()
        print(f"[DEBUG] Selected notebooks: {selected}")
        
        account_name = next((sn['accountName'] for sn in selected if sn['id'] == notebook_id), None)
        print(f"[DEBUG] Account name: {account_name}")
        
        if not account_name:
            print(f"[DEBUG] No account name found for notebook_id: {notebook_id}")
            return None
            
        accounts = get_accounts()
        print(f"[DEBUG] Available accounts: {[acc['name'] for acc in accounts]}")
        
        account = next((acc for acc in accounts if acc['name'] == account_name), None)
        print(f"[DEBUG] Found account: {account is not None}")
        
        if not account:
            print(f"[DEBUG] Account not found: {account_name}")
            return None
            
        if 'cookie' not in account:
            print(f"[DEBUG] No cookie in account: {account.keys()}")
            return None
            
        cookie_str = account['cookie']
        print(f"[DEBUG] Cookie string length: {len(cookie_str)}")
        
        cookies_dict = {}
        try:
            cookie_list = json.loads(cookie_str)
            print(f"[DEBUG] Cookie list type: {type(cookie_list)}, length: {len(cookie_list) if isinstance(cookie_list, list) else 'N/A'}")
            if isinstance(cookie_list, list):
                for item in cookie_list:
                    if isinstance(item, dict) and 'name' in item and 'value' in item:
                        cookies_dict[item['name']] = item['value']
        except Exception as e:
            print(f"[DEBUG] Error parsing cookies: {e}")
            import traceback
            traceback.print_exc()
            return None
            
        print(f"[DEBUG] Parsed cookies: {list(cookies_dict.keys())}")
        
        if not cookies_dict:
            print(f"[DEBUG] No cookies parsed")
            return None
            
        # Fetch tokens with timeout using thread pool
        print(f"[DEBUG] Fetching tokens...")
        import asyncio
        from concurrent.futures import ThreadPoolExecutor
        
        def fetch_in_thread():
            try:
                print(f"[DEBUG] Starting fetch_tokens in thread...")
                result = asyncio.run(fetch_tokens(cookies_dict))
                print(f"[DEBUG] fetch_tokens completed: {result is not None}")
                return result
            except Exception as e:
                print(f"[ERROR] fetch_tokens failed: {type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
                return None, None
        
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fetch_in_thread)
            try:
                csrf_token, session_id = future.result(timeout=30.0)
                print(f"[DEBUG] Tokens fetched: csrf={csrf_token is not None}, session={session_id is not None}")
            except Exception as e:
                print(f"[ERROR] fetch_tokens timed out or failed: {e}")
                import traceback
                traceback.print_exc()
                return None
        
        if not csrf_token or not session_id:
            print(f"[DEBUG] Missing tokens: csrf={csrf_token is not None}, session={session_id is not None}")
            return None
        
        # Create AuthTokens
        auth = AuthTokens(cookies=cookies_dict, csrf_token=csrf_token, session_id=session_id)
        print(f"[DEBUG] AuthTokens created")
            
        # Create client
        client = NotebookLMClient(auth=auth)
        print(f"[DEBUG] NotebookLM client created successfully")
        return client
    except Exception as e:
        print(f"[ERROR] Error creating notebook client: {e}")
        import traceback
        traceback.print_exc()
        return None


@person_bp.route('/books/<book_id>/persons', methods=['GET'])
def get_book_persons(book_id):
    """
    从书籍中提取所有重要人物
    实时调用NotebookLM API
    """
    try:
        print(f"[DEBUG] get_book_persons called for book: {book_id}")
        
        # Get notebook_id from query params
        notebook_id = request.args.get('notebook_id')
        print(f"[DEBUG] notebook_id from params: {notebook_id}")
        
        # If no notebook_id provided, use default for Shanghai CR book
        if not notebook_id and book_id == 'book_shanghai_cr':
            notebook_id = 'f6e95018-87cd-42f3-8a76-8f4c955ebc4a'
        
        if not notebook_id:
            print(f"[DEBUG] No notebook_id provided, returning mock data")
            return _get_mock_persons()
        
        # Get NotebookLM client
        print(f"[DEBUG] Getting NotebookLM client...")
        client = get_notebook_client(notebook_id)
        
        if not client:
            print(f"[DEBUG] Failed to get client, returning mock data")
            return _get_mock_persons()
        
        # Call NotebookLM to extract persons
        print(f"[DEBUG] Calling NotebookLM to extract persons...")
        prompt = """请分析这个文档，提取所有重要人物，返回JSON格式：
{
  "persons": [
    {
      "id": "唯一标识",
      "name": "人物姓名",
      "aliases": ["别名1", "别名2"],
      "first_appearance": "首次出现的章节",
      "importance": 1-10,
      "mention_count": 提及次数,
      "role_summary": "角色简介"
    }
  ]
}"""
        
        # Call NotebookLM (async method with context)
        import asyncio
        
        async def call_notebooklm():
            async with client:
                return await client.chat.ask(
                    notebook_id=notebook_id,
                    question=prompt
                )
        
        response = asyncio.run(call_notebooklm())
        
        print(f"[DEBUG] NotebookLM response received")
        
        # Parse JSON response
        content = response.answer
        
        # Extract JSON
        json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
        if json_match:
            content = json_match.group(1)
        
        data = json.loads(content)
        
        print(f"[DEBUG] Successfully extracted {len(data.get('persons', []))} persons")
        
        return jsonify(success=True, data=data.get('persons', []))
        
    except Exception as e:
        print(f"[ERROR] Error extracting persons: {e}")
        import traceback
        traceback.print_exc()
        return _get_mock_persons()


def _get_mock_persons():
    """返回模拟人物数据（用于测试）"""
    print(f"[DEBUG] Returning mock persons data")
    
    mock_persons = [
        {
            "id": "wanghongwen",
            "name": "王洪文",
            "aliases": [],
            "first_appearance": "第二十一章",
            "importance": 10,
            "mention_count": 45,
            "role_summary": "工总司负责人，后成为四人帮成员"
        },
        {
            "id": "gengjinzhang",
            "name": "耿金章",
            "aliases": ["耿司令"],
            "first_appearance": "第二十一章",
            "importance": 9,
            "mention_count": 38,
            "role_summary": "二兵团负责人，工人造反派领袖"
        },
        {
            "id": "zhangchunqiao",
            "name": "张春桥",
            "aliases": [],
            "first_appearance": "第二十一章",
            "importance": 9,
            "mention_count": 32,
            "role_summary": "中央文革小组成员，上海市革委会主任"
        },
        {
            "id": "huangjinhai",
            "name": "黄金海",
            "aliases": [],
            "first_appearance": "第二十一章",
            "importance": 7,
            "mention_count": 18,
            "role_summary": "工总司常委"
        },
        {
            "id": "panguoping",
            "name": "潘国平",
            "aliases": [],
            "first_appearance": "第二十一章",
            "importance": 7,
            "mention_count": 15,
            "role_summary": "工总司副司令"
        },
        {
            "id": "daizuxiang",
            "name": "戴祖祥",
            "aliases": [],
            "first_appearance": "第二十一章",
            "importance": 6,
            "mention_count": 12,
            "role_summary": "一兵团负责人"
        }
    ]
    
    return jsonify(success=True, data=mock_persons)


@person_bp.route('/books/<book_id>/persons/<person_name>/events', methods=['GET'])
def get_person_events(book_id, person_name):
    """
    获取特定人物在书籍中的所有事件
    """
    try:
        notebook_id = request.args.get('notebook_id')
        
        if not notebook_id and book_id == 'book_shanghai_cr':
            notebook_id = 'f6e95018-87cd-42f3-8a76-8f4c955ebc4a'
        
        if not notebook_id:
            return _get_mock_person_events(person_name)
        
        client = get_notebook_client(notebook_id)
        
        if not client:
            return _get_mock_person_events(person_name)
        
        # Call NotebookLM to extract person events
        prompt = f"""请分析这个文档，提取人物"{person_name}"的所有重要事件，返回JSON格式：
{{
  "person": "人物姓名",
  "full_profile": "完整人物简介",
  "events": [
    {{
      "name": "事件名称",
      "date": "发生时间",
      "location": "地点",
      "description": "事件描述",
      "significance": "历史意义",
      "related_persons": ["相关人物1", "相关人物2"],
      "source_chapter": "来源章节"
    }}
  ],
  "role_changes": [
    {{
      "period": "时间段",
      "role": "担任角色",
      "position": "职位"
    }}
  ],
  "relationships": [
    {{
      "person": "关系人",
      "relationship": "关系类型",
      "description": "关系描述"
    }}
  ]
}}"""
        
        response = client.chat.ask(
            notebook_id=notebook_id,
            question=prompt
        )
        
        print(f"[DEBUG] NotebookLM response received for person events")
        
        # Parse JSON response
        content = response.answer
        
        # Extract JSON
        json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
        if json_match:
            content = json_match.group(1)
        
        data = json.loads(content)
        
        print(f"[DEBUG] Successfully extracted person events")
        
        return jsonify(success=True, data=data)
        
    except Exception as e:
        print(f"[ERROR] Error getting person events: {e}")
        import traceback
        traceback.print_exc()
        return _get_mock_person_events(person_name)


def _get_mock_person_events(person_name):
    """返回模拟人物事件数据（用于测试）"""
    print(f"[DEBUG] Returning mock person events for: {person_name}")
    
    events_map = {
        "王洪文": {
            "person": "王洪文",
            "full_profile": "工总司负责人，后成为四人帮成员，曾任中共中央副主席",
            "events": [
                {
                    "name": "成立工总司",
                    "date": "1966年11月",
                    "location": "上海",
                    "description": "组织成立上海工人造反总司令部",
                    "significance": "成为上海工人造反派领袖",
                    "related_persons": ["潘国平", "黄金海"],
                    "source_chapter": "第二十一章"
                },
                {
                    "name": "安亭事件",
                    "date": "1966年11月",
                    "location": "安亭火车站",
                    "description": "率众卧轨拦车，要求北上告状",
                    "significance": "获得张春桥支持，确立造反派地位",
                    "related_persons": ["张春桥"],
                    "source_chapter": "第二十一章"
                }
            ],
            "role_changes": [
                {"period": "1966-1967", "role": "工总司负责人", "position": "工人造反派领袖"},
                {"period": "1972-1976", "role": "中共中央副主席", "position": "党和国家领导人"}
            ],
            "relationships": [
                {"person": "张春桥", "relationship": "政治盟友", "description": "得到张春桥的大力支持和提拔"},
                {"person": "江青", "relationship": "政治盟友", "description": "四人帮成员之一"}
            ]
        }
    }
    
    data = events_map.get(person_name, {
        "person": person_name,
        "full_profile": f"{person_name}是本书中的重要人物",
        "events": [],
        "role_changes": [],
        "relationships": []
    })
    
    return jsonify(success=True, data=data)
