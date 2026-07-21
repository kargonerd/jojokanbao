#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件名匹配器 - 智能识别报刊文件名并提取日期/期数
"""
import re
import json
import os


# ============ 中文数字转换工具 ============
CHINESE_DIGITS = {
    '〇': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4',
    '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
    'O': '0', 'o': '0', '０': '0',  # 可能的变体
}

def chinese_year_to_arabic(chinese_year):
    """
    将中文年份转换为阿拉伯数字
    例如: 一九五二 → 1952, 二〇〇八 → 2008
    """
    result = ''
    for char in chinese_year:
        if char in CHINESE_DIGITS:
            result += CHINESE_DIGITS[char]
        elif char.isdigit():
            result += char
    return result if len(result) == 4 else None

def chinese_month_to_arabic(chinese_month):
    """
    将中文月份转换为阿拉伯数字
    例如: 一 → 01, 十 → 10, 十一 → 11, 十二 → 12
    """
    chinese_month = chinese_month.strip()
    
    # 直接映射
    month_map = {
        '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
        '七': 7, '八': 8, '九': 9, '十': 10,
        '十一': 11, '十二': 12,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
        '7': 7, '8': 8, '9': 9, '10': 10, '11': 11, '12': 12,
    }
    
    if chinese_month in month_map:
        return f"{month_map[chinese_month]:02d}"
    
    return None

def chinese_day_to_arabic(chinese_day):
    """
    将中文日期/期号转换为阿拉伯数字
    例如: 一 → 01, 十 → 10, 十五 → 15, 二十一 → 21, 三十一 → 31
    也支持简写: 二一 → 21, 二四 → 24
    """
    chinese_day = chinese_day.strip()
    
    # 单字映射
    single_map = {
        '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
        '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    }
    
    # 纯数字
    if chinese_day.isdigit():
        return f"{int(chinese_day):02d}"
    
    # 单字
    if chinese_day in single_map:
        return f"{single_map[chinese_day]:02d}"
    
    # 十一到十九
    if chinese_day.startswith('十') and len(chinese_day) == 2:
        second = chinese_day[1]
        if second in single_map:
            return f"{10 + single_map[second]:02d}"
    
    # 二十、三十
    if chinese_day in ['二十', '廿']:
        return '20'
    if chinese_day == '三十':
        return '30'
    
    # 二十一到二十九 (也支持"廿一"等)
    if chinese_day.startswith('二十') or chinese_day.startswith('廿'):
        prefix = '二十' if chinese_day.startswith('二十') else '廿'
        rest = chinese_day[len(prefix):]
        if rest in single_map:
            return f"{20 + single_map[rest]:02d}"
    
    # 简写格式: "二一" → 21, "二四" → 24 (二十X的简写)
    if len(chinese_day) == 2 and chinese_day[0] == '二' and chinese_day[1] in single_map:
        return f"{20 + single_map[chinese_day[1]]:02d}"
    
    # 简写格式: "三一" → 31 (三十X的简写)
    if len(chinese_day) == 2 and chinese_day[0] == '三' and chinese_day[1] in single_map:
        return f"{30 + single_map[chinese_day[1]]:02d}"
    
    # 三十一
    if chinese_day.startswith('三十'):
        rest = chinese_day[2:]
        if rest in single_map:
            return f"{30 + single_map[rest]:02d}"
    
    return None


class FileNameMatcher:
    """文件名匹配器"""
    
    # 报纸匹配规则（目标格式：YYYYMMDD）
    NEWSPAPER_PATTERNS = [
        # 阿拉伯数字格式
        {
            'pattern': r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日',
            'extractor': lambda m: f"{m.group(1)}{int(m.group(2)):02d}{int(m.group(3)):02d}",
            'example': '人民日报2008年1月1日.pdf → 20080101.pdf'
        },
        {
            'pattern': r'(\d{4})\s*[-_年]\s*(\d{1,2})\s*[-_月]\s*(\d{1,2})',
            'extractor': lambda m: f"{m.group(1)}{int(m.group(2)):02d}{int(m.group(3)):02d}",
            'example': '2008-01-01.pdf → 20080101.pdf'
        },
        {
            'pattern': r'(\d{8})',
            'extractor': lambda m: m.group(1),
            'example': '20080101.pdf → 20080101.pdf'
        },
        # 中文数字格式（年月日完整）- 使用精确的月份/日期匹配
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*(十[一二]|[一二三四五六七八九十])月\s*(三十[一]?|二十[一二三四五六七八九]?|十[一二三四五六七八九]?|[一二三四五六七八九])日',
            'extractor': lambda m: (
                lambda y, mo, d: f"{y}{mo}{d}" if y and mo and d else None
            )(chinese_year_to_arabic(m.group(1)), chinese_month_to_arabic(m.group(2)), chinese_day_to_arabic(m.group(3))),
            'example': '一九五二年一月一日.pdf → 19520101.pdf'
        },
        # 中文年份 + 阿拉伯月日
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*(\d{1,2})月\s*(\d{1,2})日',
            'extractor': lambda m: (
                lambda y: f"{y}{int(m.group(2)):02d}{int(m.group(3)):02d}" if y else None
            )(chinese_year_to_arabic(m.group(1))),
            'example': '一九五二年1月1日.pdf → 19520101.pdf'
        },
        # 中文年份 + 中文月份 + 阿拉伯日
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*(十[一二]|[一二三四五六七八九十])月\s*(\d{1,2})日',
            'extractor': lambda m: (
                lambda y, mo: f"{y}{mo}{int(m.group(3)):02d}" if y and mo else None
            )(chinese_year_to_arabic(m.group(1)), chinese_month_to_arabic(m.group(2))),
            'example': '一九五二年一月1日.pdf → 19520101.pdf'
        },
    ]
    
    # 期刊匹配规则（目标格式：YYYYNN）
    JOURNAL_PATTERNS = [
        # 阿拉伯数字格式
        {
            'pattern': r'(\d{4})年\s*第?\s*(\d{1,2})\s*期',
            'extractor': lambda m: f"{m.group(1)}{int(m.group(2)):02d}",
            'example': '2008年第9期.pdf → 200809.pdf'
        },
        {
            'pattern': r'(\d{4})年\s*(\d{1,2})月',
            'extractor': lambda m: f"{m.group(1)}{int(m.group(2)):02d}",
            'example': '2008年09月.pdf → 200809.pdf'
        },
        {
            'pattern': r'(\d{4})\s*[-_]\s*(\d{1,2})',
            'extractor': lambda m: f"{m.group(1)}{int(m.group(2)):02d}",
            'example': '2008-09.pdf → 200809.pdf'
        },
        {
            'pattern': r'(\d{6})',
            'extractor': lambda m: m.group(1),
            'example': '200809.pdf → 200809.pdf'
        },
        # 中文数字格式
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*第?(十[一二]|[一二三四五六七八九十])期',
            'extractor': lambda m: (
                lambda y, p: f"{y}{p}" if y and p else None
            )(chinese_year_to_arabic(m.group(1)), chinese_month_to_arabic(m.group(2))),
            'example': '一九五二年第一期.pdf → 195201.pdf'
        },
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*(十[一二]|[一二三四五六七八九十])月',
            'extractor': lambda m: (
                lambda y, mo: f"{y}{mo}" if y and mo else None
            )(chinese_year_to_arabic(m.group(1)), chinese_month_to_arabic(m.group(2))),
            'example': '一九五二年一月.pdf → 195201.pdf'
        },
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*第(三[一二三四五六七八九]|二[一二三四五六七八九十]|十[一二三四五六七八九]|[一二三四五六七八九十]|二十|三十)号',
            'extractor': lambda m: (
                lambda y, n: f"{y}{n}" if y and n else None
            )(chinese_year_to_arabic(m.group(1)), chinese_day_to_arabic(m.group(2))),
            'example': '一九五七年第一号.pdf → 195701.pdf'
        },
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*第?(\d{1,2})期',
            'extractor': lambda m: (
                lambda y: f"{y}{int(m.group(2)):02d}" if y else None
            )(chinese_year_to_arabic(m.group(1))),
            'example': '一九五二年第1期.pdf → 195201.pdf'
        },
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*(\d{1,2})月',
            'extractor': lambda m: (
                lambda y: f"{y}{int(m.group(2)):02d}" if y else None
            )(chinese_year_to_arabic(m.group(1))),
            'example': '一九五二年1月.pdf → 195201.pdf'
        },
        {
            'pattern': r'([一二三四五六七八九〇零O]+)年\s*第(\d{1,2})号',
            'extractor': lambda m: (
                lambda y: f"{y}{int(m.group(2)):02d}" if y else None
            )(chinese_year_to_arabic(m.group(1))),
            'example': '一九五七年第1号.pdf → 195701.pdf'
        },
        {
            'pattern': r'(\d{4})年\s*第?(十[一二]|[一二三四五六七八九十])期',
            'extractor': lambda m: (
                lambda mo: f"{m.group(1)}{mo}" if mo else None
            )(chinese_month_to_arabic(m.group(2))),
            'example': '2008年第一期.pdf → 200801.pdf'
        },
        {
            'pattern': r'(\d{4})年\s*(十[一二]|[一二三四五六七八九十])月',
            'extractor': lambda m: (
                lambda mo: f"{m.group(1)}{mo}" if mo else None
            )(chinese_month_to_arabic(m.group(2))),
            'example': '2008年一月.pdf → 200801.pdf'
        },
        {
            'pattern': r'(\d{4})年\s*第(三[一二三四五六七八九]|二[一二三四五六七八九十]|十[一二三四五六七八九]|[一二三四五六七八九十]|二十|三十)号',
            'extractor': lambda m: (
                lambda n: f"{m.group(1)}{n}" if n else None
            )(chinese_day_to_arabic(m.group(2))),
            'example': '2008年第一号.pdf → 200801.pdf'
        },
    ]
    
    def __init__(self, config_path='config.json'):
        self.config_path = config_path
        self.custom_rules = self.load_custom_rules()
        self.session_cache = {}  # 会话级缓存（不保存到文件）
    
    def load_custom_rules(self):
        """加载自定义规则"""
        if not os.path.exists(self.config_path):
            return {}
        
        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        return config.get('custom_rules', {})
    
    def save_custom_rule(self, pub_code, rule):
        """保存自定义规则到配置文件"""
        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        if 'custom_rules' not in config:
            config['custom_rules'] = {}
        
        if pub_code not in config['custom_rules']:
            config['custom_rules'][pub_code] = []
        
        # 添加规则
        config['custom_rules'][pub_code].append(rule)
        
        with open(self.config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        
        # 重新加载
        self.custom_rules = config['custom_rules']
    
    def add_to_session_cache(self, pub_code, rule):
        """添加到会话缓存（临时，不保存）"""
        if pub_code not in self.session_cache:
            self.session_cache[pub_code] = []
        self.session_cache[pub_code].append(rule)
    
    def apply_rule(self, filename, pattern, extractor_code, pub_type='journal'):
        """应用单个规则
        Args:
            filename: 文件名（不含扩展名）
            pattern: 正则表达式
            extractor_code: 提取代码
            pub_type: 报刊类型 ('newspaper' 或 'journal')
        """
        try:
            match = re.search(pattern, filename)
            if match:
                # 动态执行提取代码，暴露中文转换函数
                try:
                    eval_context = {
                        'match': match,
                        'chinese_year_to_arabic': chinese_year_to_arabic,
                        'chinese_month_to_arabic': chinese_month_to_arabic,
                        'chinese_day_to_arabic': chinese_day_to_arabic,
                        'int': int,
                        're': re,
                    }
                    result = eval(extractor_code, eval_context)
                    
                    # 验证结果：不能是 None，不能包含 "None"，必须是有效格式
                    if result is None:
                        return None, "转换结果为空"
                    result_str = str(result)
                    if 'None' in result_str:
                        return None, "转换结果包含无效值"
                    
                    # 根据类型检查格式：报纸8位，期刊6位
                    expected_len = 8 if pub_type == 'newspaper' else 6
                    if not result_str.isdigit():
                        return None, f"格式不正确: {result_str} (应为纯数字)"
                    if len(result_str) != expected_len:
                        return None, f"格式不正确: {result_str} (应为{expected_len}位，实际{len(result_str)}位)"
                    
                    return result_str
                except SyntaxError as e:
                    return None, f"语法错误: {str(e)}"
                except Exception as e:
                    return None, f"执行错误: {str(e)}"
        except re.error as e:
            return None, f"正则表达式错误: {str(e)}"
        
        return None
    
    def match_file(self, filename, pub_type, pub_code):
        """
        匹配单个文件名
        返回: (success, renamed, reason)
        """
        # 移除扩展名
        base_name = os.path.splitext(filename)[0]
        extension = os.path.splitext(filename)[1]
        
        # 1. 尝试会话缓存的规则
        if pub_code in self.session_cache:
            for rule in self.session_cache[pub_code]:
                result = self.apply_rule(base_name, rule['pattern'], rule['extractor_code'], pub_type)
                if result and not isinstance(result, tuple):
                    return (True, result + extension, '会话规则匹配')
        
        # 2. 尝试自定义规则
        if pub_code in self.custom_rules:
            for rule in self.custom_rules[pub_code]:
                result = self.apply_rule(base_name, rule['pattern'], rule['extractor_code'], pub_type)
                if result and not isinstance(result, tuple):
                    return (True, result + extension, '自定义规则匹配')
        
        # 3. 尝试内置规则
        patterns = self.NEWSPAPER_PATTERNS if pub_type == 'newspaper' else self.JOURNAL_PATTERNS
        
        for rule in patterns:
            match = re.search(rule['pattern'], base_name)
            if match:
                try:
                    result = rule['extractor'](match)
                    return (True, result + extension, '内置规则匹配')
                except Exception as e:
                    continue
        
        return (False, filename, '未找到匹配规则')
    
    def batch_match(self, files, pub_type, pub_code):
        """
        批量匹配文件
        返回: [{
            'original': 原文件名,
            'renamed': 新文件名,
            'success': True/False,
            'reason': 原因
        }]
        """
        results = []
        
        for filename in files:
            success, renamed, reason = self.match_file(filename, pub_type, pub_code)
            results.append({
                'original': filename,
                'renamed': renamed,
                'success': success,
                'reason': reason
            })
        
        return results
    
    def generate_ai_prompt(self, all_files_with_results, failed_files, pub_type, pub_name):
        """
        生成AI提示词
        all_files_with_results: 所有文件的匹配结果
        failed_files: 失败的文件列表
        """
        target_format = 'YYYYMMDD (例: 20080101)' if pub_type == 'newspaper' else 'YYYYNN (例: 198009, 增刊用9: 198091)'
        
        prompt = f"""分析以下文件名，生成Python正则匹配规则。

报刊：{pub_name}
目标格式：{target_format}

文件名示例：
"""
        
        # 展示成功和失败的文件
        success_files = [f for f in all_files_with_results if f['success']]
        failed_files_list = [f for f in all_files_with_results if not f['success']]
        
        # 展示几个成功示例作为参考
        if success_files:
            prompt += "已成功匹配的示例：\n"
            for item in success_files[:5]:
                prompt += f"  {item['original']} → {item['renamed']}\n"
            prompt += "\n"
        
        # 失败文件处理：阈值100，超过则均匀采样
        MAX_FAILED_IN_PROMPT = 100
        prompt += "需要匹配的文件：\n"
        
        if len(failed_files_list) <= MAX_FAILED_IN_PROMPT:
            # 全部展示
            for item in failed_files_list:
                prompt += f"  {item['original']}\n"
        else:
            # 均匀采样：确保覆盖不同位置的文件（可能有不同格式）
            step = len(failed_files_list) / MAX_FAILED_IN_PROMPT
            sampled = [failed_files_list[int(i * step)] for i in range(MAX_FAILED_IN_PROMPT)]
            for item in sampled:
                prompt += f"  {item['original']}\n"
            prompt += f"\n（已从 {len(failed_files_list)} 个失败文件中均匀采样 {MAX_FAILED_IN_PROMPT} 个）\n"
        
        prompt += f"""
【重要】你可以使用以下内置函数处理中文数字：
- chinese_year_to_arabic(str): 中文年份转阿拉伯数字，如 "一九五二" → "1952"
- chinese_month_to_arabic(str): 中文月份转阿拉伯数字，如 "一" → "01", "十一" → "11"
- chinese_day_to_arabic(str): 中文日期转阿拉伯数字，如 "二十一" → "21"

请只返回一个JSON对象，不要有任何其他文字：
{{
  "pattern": "Python正则表达式（匹配文件名，不含.pdf扩展名）",
  "extractor_code": "单行Python表达式（使用match对象和上述函数）",
  "example": "转换示例"
}}

【重要注意事项】
1. pattern 不要包含 .pdf 扩展名，系统会自动处理
2. 中文数字年份字符集必须完整：[一二三四五六七八九〇零] （注意包含所有数字）
3. extractor_code 必须是单行表达式，不能是函数定义

【示例1】阿拉伯数字日期：
{{"pattern": "(\\\\d{{4}})年(\\\\d{{1,2}})月(\\\\d{{1,2}})日", "extractor_code": "f\\"{{match.group(1)}}{{int(match.group(2)):02d}}{{int(match.group(3)):02d}}\\"", "example": "2008年1月1日 → 20080101"}}

【示例2】中文数字年月（期刊）：
{{"pattern": "([一二三四五六七八九〇零]+)年\\\\s*(十[一二]|[一二三四五六七八九十])月", "extractor_code": "f\\"{{chinese_year_to_arabic(match.group(1))}}{{chinese_month_to_arabic(match.group(2))}}\\"", "example": "一九五二年一月 → 195201"}}

只返回JSON，不要解释！"""
        
        return prompt
    
    def test_custom_rule(self, rule, failed_files, pub_type='journal'):
        """
        测试自定义规则
        返回: {
            'success': True/False,
            'results': [{...}],
            'message': ''
        }
        Args:
            rule: 规则字典 {'pattern': ..., 'extractor_code': ...}
            failed_files: 失败文件列表
            pub_type: 报刊类型 ('newspaper' 或 'journal')
        """
        pattern = rule.get('pattern', '')
        extractor_code = rule.get('extractor_code', '')
        
        if not pattern or not extractor_code:
            return {
                'success': False,
                'message': '规则不完整'
            }
        
        results = []
        success_count = 0
        
        for filename in failed_files:
            base_name = os.path.splitext(filename)[0]
            extension = os.path.splitext(filename)[1]
            
            result = self.apply_rule(base_name, pattern, extractor_code, pub_type)
            
            if result and not isinstance(result, tuple):
                results.append({
                    'original': filename,
                    'renamed': result + extension,
                    'success': True
                })
                success_count += 1
            elif isinstance(result, tuple):
                # 有错误信息
                results.append({
                    'original': filename,
                    'renamed': filename,
                    'success': False,
                    'error': result[1]
                })
            else:
                results.append({
                    'original': filename,
                    'renamed': filename,
                    'success': False
                })
        
        return {
            'success': success_count > 0,
            'results': results,
            'matched_count': success_count,
            'total_count': len(failed_files),
            'message': f'匹配成功 {success_count}/{len(failed_files)} 个文件'
        }

