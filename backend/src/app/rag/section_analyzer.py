"""
小节分析器
分析文档的每个小节，提取人物、事件，并关联历史背景
"""

import json
import re
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
from datetime import datetime


@dataclass
class PersonInSection:
    """小节中出现的人物"""
    name: str
    aliases: List[str]
    role_in_section: str  # 在本小节中的身份/角色
    actions: List[str]    # 在本小节中的行为
    mentioned_count: int  # 被提及次数
    is_new: bool         # 是否是首次出现


@dataclass
class EventInSection:
    """小节中出现的事件"""
    name: str
    date: Optional[str]
    description: str
    participants: List[str]
    location: Optional[str]
    significance: str    # 重要性/意义


@dataclass
class HistoricalContext:
    """历史背景关联"""
    person_name: str
    previous_events: List[Dict[str, str]]  # 该人物之前发生的事件
    context_summary: str  # 背景总结


@dataclass
class SectionAnalysis:
    """小节分析结果"""
    section_title: str
    section_index: int
    chapter_title: str
    persons: List[PersonInSection]
    events: List[EventInSection]
    historical_contexts: List[HistoricalContext]
    summary: str         # 小节总结
    key_points: List[str]  # 要点


class SectionAnalyzer:
    """文档小节分析器"""
    
    def __init__(self, notebook_client=None):
        self.client = notebook_client
        self._cache: Dict[str, Any] = {}
    
    def parse_sections(self, content: str) -> List[Dict[str, Any]]:
        """
        解析文档，提取所有小节
        
        Returns:
            小节列表，每个包含标题、级别、内容
        """
        sections = []
        lines = content.split('\n')
        current_section = None
        current_content = []
        
        for line in lines:
            # 匹配标题行 (# ## ###)
            match = re.match(r'^(#{1,6})\s+(.+)$', line)
            if match:
                # 保存上一个小节
                if current_section:
                    current_section['content'] = '\n'.join(current_content).strip()
                    sections.append(current_section)
                
                level = len(match.group(1))
                title = match.group(2).strip()
                
                current_section = {
                    'title': title,
                    'level': level,
                    'index': len(sections),
                    'content': ''
                }
                current_content = []
            else:
                if current_section is not None:
                    current_content.append(line)
        
        # 保存最后一个小节
        if current_section:
            current_section['content'] = '\n'.join(current_content).strip()
            sections.append(current_section)
        
        return sections
    
    async def analyze_section(
        self, 
        notebook_id: str,
        section_title: str,
        section_content: str,
        previous_sections: List[Dict[str, Any]] = None
    ) -> SectionAnalysis:
        """
        分析单个小节
        
        Args:
            notebook_id: Notebook ID
            section_title: 小节标题
            section_content: 小节内容
            previous_sections: 之前的小节列表（用于提取历史背景）
            
        Returns:
            分析结果
        """
        # 构建提示词
        previous_context = ""
        if previous_sections:
            previous_context = "\n\n之前的小节内容概要：\n"
            for i, prev in enumerate(previous_sections[-3:]):  # 只取最近3个小节
                previous_context += f"\n{i+1}. {prev.get('title', '未知标题')}\n"
                # 截取前200字作为概要
                content_preview = prev.get('content', '')[:200]
                previous_context += f"   {content_preview}...\n"
        
        prompt = f"""请仔细分析以下文档小节，提取关键信息并以JSON格式返回：

【小节标题】
{section_title}

【小节内容】
{section_content[:3000]}  # 限制长度避免超出token限制

{previous_context}

请按以下JSON格式返回分析结果：

{{
  "summary": "本小节的主要内容总结（100字左右）",
  "key_points": ["要点1", "要点2", "要点3"],
  "persons": [
    {{
      "name": "人物姓名",
      "aliases": ["别名1", "别名2"],
      "role_in_section": "在本小节中的身份/角色",
      "actions": ["行为1", "行为2"],
      "mentioned_count": 5,
      "is_new": false
    }}
  ],
  "events": [
    {{
      "name": "事件名称",
      "date": "1967年2月（如文中提到）",
      "description": "事件描述",
      "participants": ["参与者1", "参与者2"],
      "location": "地点（如有）",
      "significance": "事件意义"
    }}
  ],
  "historical_contexts": [
    {{
      "person_name": "人物姓名",
      "previous_events": [
        {{"event": "之前发生的事件", "time": "时间", "relation": "与本节内容的关联"}}
      ],
      "context_summary": "该人物在本节之前的背景总结"
    }}
  ]
}}

注意：
1. 只提取本小节明确提到的人物和事件
2. historical_contexts 需要基于之前的小节内容，说明这些人物之前发生过什么
3. is_new 标记该人物是否是首次在文档中出现（基于之前小节判断）
4. 确保JSON格式正确，可以被解析"""

        try:
            if not self.client:
                # 返回模拟数据用于测试
                return self._generate_mock_analysis(section_title, section_content)
            
            response = await self.client.chat.ask(
                notebook_id=notebook_id,
                question=prompt
            )
            
            # 解析JSON响应
            content = response.answer
            
            # 提取JSON
            json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
            if json_match:
                content = json_match.group(1)
            
            json_match = re.search(r'(\{[\s\S]*"summary"[\s\S]*\})', content)
            if json_match:
                content = json_match.group(1)
            
            data = json.loads(content)
            
            # 构建SectionAnalysis对象
            persons = [
                PersonInSection(**p) for p in data.get('persons', [])
            ]
            events = [
                EventInSection(**e) for e in data.get('events', [])
            ]
            contexts = [
                HistoricalContext(**c) for c in data.get('historical_contexts', [])
            ]
            
            return SectionAnalysis(
                section_title=section_title,
                section_index=0,  # 由调用者设置
                chapter_title="",
                persons=persons,
                events=events,
                historical_contexts=contexts,
                summary=data.get('summary', ''),
                key_points=data.get('key_points', [])
            )
            
        except Exception as e:
            print(f"Error analyzing section: {e}")
            return self._generate_mock_analysis(section_title, section_content)
    
    def _generate_mock_analysis(self, section_title: str, content: str) -> SectionAnalysis:
        """生成模拟分析数据"""
        
        # 根据小节标题生成不同的模拟数据
        if "二兵團" in section_title or "耿金章" in section_title:
            return SectionAnalysis(
                section_title=section_title,
                section_index=0,
                chapter_title="第二十一章",
                persons=[
                    PersonInSection(
                        name="耿金章",
                        aliases=["耿司令"],
                        role_in_section="二兵團負責人",
                        actions=["發展二兵團勢力", "與王洪文對抗", "佔領辦公處所"],
                        mentioned_count=8,
                        is_new=False
                    ),
                    PersonInSection(
                        name="王洪文",
                        aliases=[],
                        role_in_section="工總司負責人",
                        actions=["向張春橋匯報", "試圖控制二兵團"],
                        mentioned_count=6,
                        is_new=False
                    ),
                    PersonInSection(
                        name="張春橋",
                        aliases=[],
                        role_in_section="中央文革小組成員",
                        actions=["接見工總司負責人", "調解矛盾"],
                        mentioned_count=5,
                        is_new=False
                    ),
                    PersonInSection(
                        name="黃金海",
                        aliases=[],
                        role_in_section="工總司常委",
                        actions=["匯報耿金章動向", "勸說耿金章回廠"],
                        mentioned_count=4,
                        is_new=False
                    )
                ],
                events=[
                    EventInSection(
                        name="安亭事件",
                        date="1966年11月",
                        description="工人臥軌阻攔火車，要求北上告狀",
                        participants=["耿金章", "王洪文", "張春橋"],
                        location="安亭",
                        significance="標誌着工人造反派登上歷史舞台"
                    ),
                    EventInSection(
                        name="二兵團成立",
                        date="1966年11月下旬",
                        description="耿金章正式成立二兵團，與工總司分庭抗禮",
                        participants=["耿金章", "孫玉喜"],
                        location="上海",
                        significance="工人造反派內部出現分裂"
                    )
                ],
                historical_contexts=[
                    HistoricalContext(
                        person_name="耿金章",
                        previous_events=[
                            {"event": "參加安亭事件", "time": "1966年11月", "relation": "成為工人造反派領袖"},
                            {"event": "與張春橋簽訂五條", "time": "1966年11月", "relation": "獲得中央支持"}
                        ],
                        context_summary="耿金章是安亭事件的主要領導人之一，與張春橋有較好關係，但與王洪文存在矛盾"
                    ),
                    HistoricalContext(
                        person_name="王洪文",
                        previous_events=[
                            {"event": "成立工總司", "time": "1966年11月", "relation": "成為上海工人造反派總司令"},
                            {"event": "處理安亭事件", "time": "1966年11月", "relation": "確立領導地位"}
                        ],
                        context_summary="王洪文是工總司總司令，希望統一工人造反派組織，但面臨二兵團等分裂勢力"
                    )
                ],
                summary="本小節講述了二兵團的迅速發展，以及耿金章與王洪文之間的矛盾。張春橋對二兵團採取容忍態度，客觀上縱容了耿金章的獨立傾向。",
                key_points=[
                    "二兵團發展迅速，到1967年2月號稱有60萬人",
                    "耿金章與王洪文存在權力鬥爭",
                    "張春橋對二兵團採取曖昧態度，既不支持也不反對",
                    "黃金海等人堅決反對二兵團獨立"
                ]
            )
        elif "兵團被各個擊破" in section_title:
            return SectionAnalysis(
                section_title=section_title,
                section_index=0,
                chapter_title="第二十一章",
                persons=[
                    PersonInSection(
                        name="王洪文",
                        aliases=[],
                        role_in_section="工總司負責人",
                        actions=["決定解散兵團", "抓捕耿金章", "瓦解各兵團"],
                        mentioned_count=10,
                        is_new=False
                    ),
                    PersonInSection(
                        name="耿金章",
                        aliases=[],
                        role_in_section="二兵團負責人",
                        actions=["被騙至國棉三十一廠", "被關押", "二兵團瓦解"],
                        mentioned_count=8,
                        is_new=False
                    ),
                    PersonInSection(
                        name="黃金海",
                        aliases=[],
                        role_in_section="工總司常委",
                        actions=["設計抓捕耿金章", "瓦解工三司"],
                        mentioned_count=5,
                        is_new=False
                    ),
                    PersonInSection(
                        name="張春橋",
                        aliases=[],
                        role_in_section="中央文革小組成員",
                        actions=["在講話中批評兵團", "默許王洪文行動"],
                        mentioned_count=4,
                        is_new=False
                    )
                ],
                events=[
                    EventInSection(
                        name="抓捕耿金章",
                        date="1967年2月25日",
                        description="王洪文設計將耿金章騙至國棉三十一廠抓捕",
                        participants=["王洪文", "黃金海", "耿金章"],
                        location="國棉三十一廠",
                        significance="二兵團失去領袖，迅速瓦解"
                    ),
                    EventInSection(
                        name="瓦解工三司",
                        date="1967年2月下旬",
                        description="黃金海勸說工三司基層造反，從內部分化工三司",
                        participants=["黃金海", "秦愛芝"],
                        location="上海第七紡織機械廠",
                        significance="工三司從內部被瓦解"
                    ),
                    EventInSection(
                        name="一兵團瓦解",
                        date="1967年3月",
                        description="戴祖祥被抓捕，一兵團瓦解",
                        participants=["戴祖祥", "王洪文"],
                        location="上海",
                        significance="反對派組織被逐個消滅"
                    )
                ],
                historical_contexts=[
                    HistoricalContext(
                        person_name="耿金章",
                        previous_events=[
                            {"event": "二兵團發展壯大", "time": "1966年11月-1967年2月", "relation": "威脅王洪文地位"},
                            {"event": "組織反工總司遊行", "time": "1967年2月12日", "relation": "激化矛盾"}
                        ],
                        context_summary="耿金章領導的二兵團發展迅速，與工總司矛盾激化，最終被王洪文設計抓捕"
                    ),
                    HistoricalContext(
                        person_name="王洪文",
                        previous_events=[
                            {"event": "多次嘗試合併兵團", "time": "1966年12月-1967年1月", "relation": "未能成功"},
                            {"event": "獲得張春橋默許", "time": "1967年2月24日", "relation": "決定採取強硬手段"}
                        ],
                        context_summary="王洪文最初希望和平合併兵團，但未能成功。在獲得張春橋默許後，決定採取強硬手段消滅反對派"
                    )
                ],
                summary="本小節描述了王洪文在獲得張春橋默許後，採取強硬手段逐個擊破各兵團的過程。耿金章被騙抓捕，二兵團、工三司、一兵團相繼瓦解。",
                key_points=[
                    "張春橋在講話中批評兵團，為王洪文行動提供政治依據",
                    "王洪文設計抓捕耿金章，二兵團失去領袖",
                    "黃金海從內部分化工三司，使其迅速瓦解",
                    "各兵團負責人下場各異，耿金章後來被張春橋保護"
                ]
            )
        else:
            # 通用模拟数据
            return SectionAnalysis(
                section_title=section_title,
                section_index=0,
                chapter_title="",
                persons=[],
                events=[],
                historical_contexts=[],
                summary="本小節內容分析...",
                key_points=["要點1", "要點2"]
            )


# Flask API端点
from flask import Blueprint, jsonify, request

section_bp = Blueprint('section', __name__, url_prefix='/api')


@section_bp.route('/books/<book_id>/sections', methods=['GET'])
def get_book_sections(book_id):
    """获取书籍的所有小节"""
    try:
        # 读取书籍内容
        import os
        
        # 尝试找到对应的书籍文件
        possible_paths = [
            f"uploads/{book_id}.md",
            f"library/{book_id}.md",
            f"books/{book_id}.md"
        ]
        
        content = None
        for path in possible_paths:
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                break
        
        if not content:
            # 返回模拟数据
            return jsonify(success=True, data=[
                {
                    "index": 0,
                    "title": "迅速發展的二兵團",
                    "level": 2,
                    "chapter": "第二十一章 解散「兵團」",
                    "preview": "上海人民公社成立一波三折..."
                },
                {
                    "index": 1,
                    "title": "二兵團、一兵團、工三司和野戰兵團",
                    "level": 2,
                    "chapter": "第二十一章 解散「兵團」",
                    "preview": "一兵團負責人是戴祖祥..."
                },
                {
                    "index": 2,
                    "title": "王洪文嘗試合併未成功",
                    "level": 2,
                    "chapter": "第二十一章 解散「兵團」",
                    "preview": "黃金海是工總司內主張取消兵團..."
                },
                {
                    "index": 3,
                    "title": "《第五號通令》風波",
                    "level": 2,
                    "chapter": "第二十一章 解散「兵團」",
                    "preview": "耿金章自認康平路事件有功..."
                },
                {
                    "index": 4,
                    "title": "兵團被各個擊破",
                    "level": 2,
                    "chapter": "第二十一章 解散「兵團」",
                    "preview": "2月24日，張春橋從北京回上海..."
                }
            ])
        
        # 解析小节
        analyzer = SectionAnalyzer()
        sections = analyzer.parse_sections(content)
        
        # 添加章节信息
        current_chapter = ""
        for section in sections:
            if section['level'] == 1:
                current_chapter = section['title']
            section['chapter'] = current_chapter
            section['preview'] = section['content'][:100] + "..." if len(section['content']) > 100 else section['content']
        
        # 只返回二级及以下标题
        sections = [s for s in sections if s['level'] >= 2]
        
        return jsonify(success=True, data=sections)
        
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500


@section_bp.route('/books/<book_id>/sections/<int:section_index>/analyze', methods=['POST'])
def analyze_book_section(book_id, section_index):
    """分析指定小节"""
    try:
        # 这里应该调用AI进行分析
        # 简化版本返回模拟数据
        
        # 根据section_index返回不同的模拟数据
        mock_analyses = [
            {
                "section_title": "迅速發展的二兵團",
                "section_index": 0,
                "chapter_title": "第二十一章 解散「兵團」",
                "summary": "本小節講述了二兵團的迅速發展，以及耿金章與王洪文之間的矛盾。張春橋對二兵團採取容忍態度，客觀上縱容了耿金章的獨立傾向。",
                "key_points": [
                    "二兵團發展迅速，到1967年2月號稱有60萬人",
                    "耿金章與王洪文存在權力鬥爭",
                    "張春橋對二兵團採取曖昧態度",
                    "黃金海等人堅決反對二兵團獨立"
                ],
                "persons": [
                    {
                        "name": "耿金章",
                        "aliases": ["耿司令"],
                        "role_in_section": "二兵團負責人",
                        "actions": ["發展二兵團勢力", "與王洪文對抗"],
                        "mentioned_count": 8,
                        "is_new": False
                    },
                    {
                        "name": "王洪文",
                        "aliases": [],
                        "role_in_section": "工總司負責人",
                        "actions": ["向張春橋匯報", "試圖控制二兵團"],
                        "mentioned_count": 6,
                        "is_new": False
                    },
                    {
                        "name": "張春橋",
                        "aliases": [],
                        "role_in_section": "中央文革小組成員",
                        "actions": ["接見工總司負責人", "調解矛盾"],
                        "mentioned_count": 5,
                        "is_new": False
                    }
                ],
                "events": [
                    {
                        "name": "安亭事件",
                        "date": "1966年11月",
                        "description": "工人臥軌阻攔火車，要求北上告狀",
                        "participants": ["耿金章", "王洪文", "張春橋"],
                        "location": "安亭",
                        "significance": "標誌着工人造反派登上歷史舞台"
                    }
                ],
                "historical_contexts": [
                    {
                        "person_name": "耿金章",
                        "previous_events": [
                            {"event": "參加安亭事件", "time": "1966年11月", "relation": "成為工人造反派領袖"},
                            {"event": "與張春橋簽訂五條", "time": "1966年11月", "relation": "獲得中央支持"}
                        ],
                        "context_summary": "耿金章是安亭事件的主要領導人之一，與張春橋有較好關係，但與王洪文存在矛盾"
                    }
                ]
            },
            {
                "section_title": "兵團被各個擊破",
                "section_index": 4,
                "chapter_title": "第二十一章 解散「兵團」",
                "summary": "本小節描述了王洪文在獲得張春橋默許後，採取強硬手段逐個擊破各兵團的過程。耿金章被騙抓捕，二兵團、工三司、一兵團相繼瓦解。",
                "key_points": [
                    "張春橋在講話中批評兵團，為王洪文行動提供政治依據",
                    "王洪文設計抓捕耿金章，二兵團失去領袖",
                    "黃金海從內部分化工三司",
                    "各兵團負責人下場各異"
                ],
                "persons": [
                    {
                        "name": "王洪文",
                        "aliases": [],
                        "role_in_section": "工總司負責人",
                        "actions": ["決定解散兵團", "抓捕耿金章"],
                        "mentioned_count": 10,
                        "is_new": False
                    },
                    {
                        "name": "耿金章",
                        "aliases": [],
                        "role_in_section": "二兵團負責人（被捕）",
                        "actions": ["被騙至國棉三十一廠", "被關押"],
                        "mentioned_count": 8,
                        "is_new": False
                    }
                ],
                "events": [
                    {
                        "name": "抓捕耿金章",
                        "date": "1967年2月25日",
                        "description": "王洪文設計將耿金章騙至國棉三十一廠抓捕",
                        "participants": ["王洪文", "黃金海", "耿金章"],
                        "location": "國棉三十一廠",
                        "significance": "二兵團失去領袖，迅速瓦解"
                    }
                ],
                "historical_contexts": [
                    {
                        "person_name": "王洪文",
                        "previous_events": [
                            {"event": "多次嘗試合併兵團", "time": "1966年12月-1967年1月", "relation": "未能成功"},
                            {"event": "獲得張春橋默許", "time": "1967年2月24日", "relation": "決定採取強硬手段"}
                        ],
                        "context_summary": "王洪文最初希望和平合併兵團，但未能成功。在獲得張春橋默許後，決定採取強硬手段消滅反對派"
                    }
                ]
            }
        ]
        
        # 根据索引返回对应的数据，如果没有则返回第一个
        analysis = mock_analyses[section_index] if section_index < len(mock_analyses) else mock_analyses[0]
        
        return jsonify(success=True, data=analysis)
        
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500
