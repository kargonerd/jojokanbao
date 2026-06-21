#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Vue文件生成器 - 基于处理后的PDF文件生成Vue代码
支持多文件diff和GitLab风格的代码审查
"""
import os
import json
import difflib
import re


def extract_doc_viewer_attributes(vue_code):
    """
    从现有 Vue 代码中提取 doc-viewer 的属性
    
    Args:
        vue_code: Vue 代码字符串
        
    Returns:
        属性字典，如 {'name': 'rmrb', ':resolution-control': 'true'}
    """
    attributes = {}
    
    # 匹配 <doc-viewer ...> 标签
    pattern = r'<doc-viewer\s+([^>]*)>'
    match = re.search(pattern, vue_code)
    
    if match:
        attrs_str = match.group(1)
        # 提取所有属性
        attr_pattern = r'(\S+)=["\']([^"\']*)["\']'
        for attr_match in re.finditer(attr_pattern, attrs_str):
            attr_name = attr_match.group(1)
            attr_value = attr_match.group(2)
            attributes[attr_name] = attr_value
    
    return attributes


def extract_shortcuts(vue_code):
    """
    从现有 Vue 代码中提取 shortcuts
    
    Args:
        vue_code: Vue 代码字符串
        
    Returns:
        shortcuts 数组，如 [{'text': '开国大典', 'onClick': '...'}]
    """
    shortcuts = []
    
    # 匹配 shortcuts 数组
    pattern = r'shortcuts:\s*\[(.*?)\]'
    match = re.search(pattern, vue_code, re.DOTALL)
    
    if match:
        shortcuts_str = match.group(1)
        print(f"[Shortcuts提取] 原始 shortcuts 字符串长度: {len(shortcuts_str)}")
        
        # 使用更简单的方法：逐个提取 text 和对应的 onClick
        # 先找到所有的 text
        text_pattern = r"text:\s*['\"]([^'\"]+)['\"]"
        text_matches = list(re.finditer(text_pattern, shortcuts_str))
        
        for text_match in text_matches:
            text = text_match.group(1)
            # 从 text 位置开始，找到对应的 onClick
            start_pos = text_match.end()
            
            # 查找 onClick(picker) {
            onclick_pattern = r"onClick\(picker\)\s*\{"
            onclick_match = re.search(onclick_pattern, shortcuts_str[start_pos:start_pos+500])
            
            if onclick_match:
                # 从 onClick 开始，找到对应的闭合 }
                onclick_start = start_pos + onclick_match.end()
                brace_count = 1
                i = onclick_start
                while i < len(shortcuts_str) and brace_count > 0:
                    if shortcuts_str[i] == '{':
                        brace_count += 1
                    elif shortcuts_str[i] == '}':
                        brace_count -= 1
                    i += 1
                
                # 提取 onClick 内容
                onclick_content = shortcuts_str[onclick_start:i-1]
                print(f"[Shortcuts提取] onClick内容: {onclick_content}")
                
                # 提取 picker.$emit 中的日期表达式
                # 匹配 new Date(...) 或其他表达式
                emit_match = re.search(r"picker\.\$emit\(['\"]pick['\"]\s*,\s*(new Date\([^)]+\))", onclick_content, re.DOTALL)
                if emit_match:
                    date_expr = emit_match.group(1).strip()
                    shortcuts.append({'text': text, 'date_expr': date_expr})
                    print(f"[Shortcuts提取] 提取到: {text} -> {date_expr}")
    
    print(f"[Shortcuts提取] 共提取到 {len(shortcuts)} 个 shortcuts")
    return shortcuts


def generate_missing_dates(processed_path):
    """
    生成缺失的日期信息
    
    返回：
    - missing_years: 整年没有的年份列表 [1946, 1947, ...]
    - missing_year_months: 整月没有的年月列表 [194606, 194607, ...] (yyyymm)
    - missing_dates: 单天没有的日期列表 [19460628, 19460629, ...]
    - min_date, max_date: 日期范围
    """
    if not os.path.exists(processed_path):
        return {
            'missing_years': [],
            'missing_year_months': [],
            'missing_dates': [],
            'min_date': None,
            'max_date': None
        }
    
    # 收集所有存在的日期
    existing_dates = set()
    year_folders = [f for f in os.listdir(processed_path) 
                   if os.path.isdir(os.path.join(processed_path, f)) and f.isdigit()]
    
    for year in year_folders:
        year_path = os.path.join(processed_path, year)
        for pdf_file in os.listdir(year_path):
            if pdf_file.endswith('.pdf'):
                date_part = pdf_file[:-4]  # 去掉.pdf
                if len(date_part) == 8 and date_part.isdigit():
                    existing_dates.add(int(date_part))
    
    if not existing_dates:
        return {
            'missing_years': [],
            'missing_year_months': [],
            'missing_dates': [],
            'min_date': None,
            'max_date': None
        }
    
    # 确定日期范围
    min_date = min(existing_dates)
    max_date = max(existing_dates)
    min_year = min_date // 10000
    max_year = max_date // 10000
    
    print(f"[日期收集] 日期范围: {min_date} - {max_date}")
    print(f"[日期收集] 年份范围: {min_year} - {max_year}")
    print(f"[日期收集] 共 {len(existing_dates)} 个文件")
    
    # 1. 检查整年没有的
    missing_years = []
    existing_years = set(d // 10000 for d in existing_dates)
    for year in range(min_year, max_year + 1):
        if year not in existing_years:
            missing_years.append(year)
            print(f"[缺失年份] {year} 整年没有")
    
    # 2. 检查整月没有的
    missing_year_months = []
    # 计算最小和最大年月（用于过滤）
    min_year_month = min_date // 100  # yyyymm
    max_year_month = max_date // 100  # yyyymm
    print(f"[缺失月份] 年月范围: {min_year_month} - {max_year_month}")
    
    for year in range(min_year, max_year + 1):
        if year in existing_years:
            # 该年有文件，检查每个月
            existing_months = set((d % 10000) // 100 for d in existing_dates if d // 10000 == year)
            print(f"[缺失月份] {year}年存在的月份: {sorted(existing_months)}")
            for month in range(1, 13):
                year_month = year * 100 + month
                # 只添加在日期范围内的缺失月份
                if month not in existing_months:
                    if min_year_month <= year_month <= max_year_month:
                        missing_year_months.append(year_month)
                        print(f"[缺失月份] {year}-{month:02d} 整月没有")
                    else:
                        print(f"[缺失月份] {year}-{month:02d} 跳过（超出范围）")
    
    # 3. 检查单天没有的
    missing_dates = []
    for year in range(min_year, max_year + 1):
        if year in existing_years:
            existing_months = set((d % 10000) // 100 for d in existing_dates if d // 10000 == year)
            for month in existing_months:
                # 该月有文件，检查每一天
                days_in_month = [31, 29 if year % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
                for day in range(1, days_in_month + 1):
                    date = year * 10000 + month * 100 + day
                    if date not in existing_dates and min_date <= date <= max_date:
                        missing_dates.append(date)
                        # 只打印前几个，避免日志太多
                        if len(missing_dates) <= 10:
                            print(f"[缺失日期] {date}")
    
    print(f"[日期收集] 缺失年份: {len(missing_years)} 个")
    print(f"[日期收集] 缺失月份: {len(missing_year_months)} 个")
    print(f"[日期收集] 缺失日期: {len(missing_dates)} 个")
    
    return {
        'missing_years': missing_years,
        'missing_year_months': missing_year_months,
        'missing_dates': missing_dates,
        'min_date': min_date,
        'max_date': max_date
    }


def generate_vue_code(pub_code, processed_path):
    """
    生成Vue代码
    
    Args:
        pub_code: 报刊代码（如 SJZS）
        processed_path: 完整PDF的路径（不是拆分后的）
        
    Returns:
        生成的Vue代码字符串
    """
    # 加载配置
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    pub_info = config['publications'][pub_code]
    vue_name = pub_info['vue_name']
    pub_name = pub_info['name']
    pub_type = pub_info['type']
    
    # 读取原有 Vue 文件，提取属性和 shortcuts
    existing_attributes = {}
    existing_shortcuts = []
    views_dir = config['paths']['views']
    vue_filename = f"{vue_name.upper()}View.vue"
    vue_file_path = os.path.join(views_dir, vue_filename)
    
    if os.path.exists(vue_file_path):
        with open(vue_file_path, 'r', encoding='utf-8') as f:
            old_vue_code = f.read()
            existing_attributes = extract_doc_viewer_attributes(old_vue_code)
            existing_shortcuts = extract_shortcuts(old_vue_code)
            print(f"[Vue生成] 从原有文件中提取到属性: {list(existing_attributes.keys())}")
            print(f"[Vue生成] 从原有文件中提取到 {len(existing_shortcuts)} 个 shortcuts")
    
    # 收集年份和期数信息（仅期刊需要）
    year_seq_dict = {}
    missing_dates_info = None
    
    if pub_type == 'journal':
        print(f"[Vue生成] 开始扫描目录: {processed_path}")
        print(f"[Vue生成] 目录存在: {os.path.exists(processed_path)}")
        
        if os.path.exists(processed_path):
            # 扫描年份文件夹：processed_path/YYYY/
            year_folders = [f for f in os.listdir(processed_path) 
                           if os.path.isdir(os.path.join(processed_path, f)) and f.isdigit()]
            print(f"[Vue生成] 找到 {len(year_folders)} 个年份文件夹")
            
            for year in year_folders:
                year_path = os.path.join(processed_path, year)
                year_seq_dict[year] = []
                
                # 扫描该年份下的PDF文件：yyyyNN.pdf
                for pdf_file in os.listdir(year_path):
                    if pdf_file.endswith('.pdf'):
                        # 格式：yyyyNN.pdf
                        date_part = pdf_file[:-4]  # 去掉.pdf
                        if len(date_part) >= 6:
                            seq = int(date_part[4:6])
                            if seq not in year_seq_dict[year]:
                                year_seq_dict[year].append(seq)
            
            print(f"[Vue生成] 收集到的年份: {sorted(year_seq_dict.keys())}")
            for year in sorted(year_seq_dict.keys())[-3:]:  # 打印最近3个年份
                seqs = sorted(year_seq_dict[year])
                print(f"[Vue生成] {year}年: {seqs} (共{len(seqs)}期)")
    else:
        print(f"[Vue生成] 报纸类型，生成缺失日期信息")
        missing_dates_info = generate_missing_dates(processed_path)
    
    # 简化期数配置
    simplified_year_seq_dict = simplify_seq_config(year_seq_dict)
    
    # 生成Vue代码
    vue_content = generate_vue_template(vue_name, pub_type, simplified_year_seq_dict, existing_attributes, existing_shortcuts, missing_dates_info)
    
    return vue_content


def simplify_seq_config(year_seq_dict):
    """简化期数配置"""
    simplified_dict = {}
    for year, seqs in year_seq_dict.items():
        seqs.sort()
        if len(seqs) == 0:
            continue
        simplified_dict[year] = seqs
    return simplified_dict


def generate_js_seq_config(seqs):
    """生成JavaScript期数配置代码"""
    if len(seqs) == 0:
        return "[]"
    
    normal_seqs = [num for num in seqs if num < 90]
    extra_seqs = [num for num in seqs if num >= 90]
    
    if len(normal_seqs) == 0:
        return str(extra_seqs)
    
    if len(normal_seqs) == 1:
        if len(extra_seqs) == 0:
            return str(normal_seqs)
        else:
            return str(normal_seqs + extra_seqs)
    
    # 检查是否连续
    all_nums = list(range(min(normal_seqs), max(normal_seqs) + 1))
    missing_nums = [num for num in all_nums if num not in normal_seqs]
    
    if len(missing_nums) <= 5:
        # 使用filter表达式
        if len(missing_nums) == 0:
            if normal_seqs[0] == 1:
                normal_seq_str = f'[...Array({max(normal_seqs)}).keys()].map(i => i + 1)'
            else:
                normal_seq_str = f'[...Array({max(normal_seqs) - min(normal_seqs) + 1}).keys()].map(i => i + {min(normal_seqs)})'
        else:
            filter_condition = " && ".join([f"i!== {num}" for num in missing_nums])
            if normal_seqs[0] == 1:
                normal_seq_str = f'[...Array({max(normal_seqs)}).keys()].map(i => i + 1).filter(i => {filter_condition})'
            else:
                normal_seq_str = f'[...Array({max(normal_seqs) - min(normal_seqs) + 1}).keys()].map(i => i + {min(normal_seqs)}).filter(i => {filter_condition})'
        
        if len(extra_seqs) == 0:
            return normal_seq_str
        else:
            return f"{normal_seq_str}.concat({str(extra_seqs)})"
    else:
        # 直接列举
        if len(extra_seqs) == 0:
            return str(normal_seqs)
        else:
            return str(normal_seqs + extra_seqs)


def generate_vue_template(vue_name, pub_type, year_seq_dict, existing_attributes=None, existing_shortcuts=None, missing_dates_info=None):
    """生成Vue模板"""
    
    if existing_attributes is None:
        existing_attributes = {}
    if existing_shortcuts is None:
        existing_shortcuts = []
    if missing_dates_info is None:
        missing_dates_info = {
            'missing_years': [],
            'missing_year_months': [],
            'missing_dates': [],
            'min_date': None,
            'max_date': None
        }
    
    # 构建 doc-viewer 的属性字符串
    def build_attrs_string(attrs):
        if not attrs:
            return ''
        return ' ' + ' '.join([f'{k}="{v}"' for k, v in attrs.items()])
    
    # 构建 shortcuts 字符串
    def build_shortcuts_string(shortcuts):
        if not shortcuts:
            return ''
        shortcuts_str = ',\n        '.join([
            f'{{\n          text: \'{s["text"]}\',\n          onClick(picker) {{\n            picker.$emit("pick", {s["date_expr"]});\n          }}\n        }}'
            for s in shortcuts
        ])
        return f''',
        shortcuts: [{shortcuts_str}]'''
    
    # 构建 disabledDate 函数字符串（报纸类型）
    def build_disabled_date_string(missing_dates_info):
        missing_years = missing_dates_info.get('missing_years', [])
        missing_year_months = missing_dates_info.get('missing_year_months', [])
        missing_dates = missing_dates_info.get('missing_dates', [])
        min_date = missing_dates_info.get('min_date')
        max_date = missing_dates_info.get('max_date')
        
        if not min_date or not max_date:
            return '''disabledDate(time) {
          return false;
        }'''
        
        min_year = min_date // 10000
        max_year = max_date // 10000
        
        # 计算日期的各个部分（在 Python 中计算好）
        min_year_js = min_date // 10000
        min_month_js = (min_date % 10000) // 100 - 1  # JavaScript 月份从 0 开始
        min_day_js = min_date % 100
        
        max_year_js = max_date // 10000
        max_month_js = (max_date % 10000) // 100 - 1  # JavaScript 月份从 0 开始
        max_day_js = max_date % 100
        
        # 将缺失的数组转换为 JavaScript 数组
        missing_years_str = ', '.join(map(str, missing_years))
        missing_year_months_str = ', '.join(map(str, missing_year_months))
        missing_dates_str = ', '.join(map(str, missing_dates))
        
        return f'''disabledDate(time) {{
          // 1. 过滤掉最小日期和最大日期之外的
          const minDate = new Date({min_year_js}, {min_month_js}, {min_day_js});
          const maxDate = new Date({max_year_js}, {max_month_js}, {max_day_js});
          if (time.getTime() < minDate.getTime() || time.getTime() > maxDate.getTime()) {{
            return true;
          }}
          
          // 2. 检查整年没有的
          const year = time.getFullYear();
          const missingYears = [{missing_years_str}];
          if (missingYears.includes(year)) {{
            return true;
          }}
          
          // 3. 检查整月没有的
          const month = time.getMonth() + 1;
          const yearMonth = year * 100 + month;
          const missingYearMonths = [{missing_year_months_str}];
          if (missingYearMonths.includes(yearMonth)) {{
            return true;
          }}
          
          // 4. 检查单天没有的
          const day = time.getDate();
          const dateStr = year * 10000 + month * 100 + day;
          const missingDates = [{missing_dates_str}];
          return missingDates.includes(dateStr);
        }}'''
    
    if pub_type == 'newspaper':
        # 报纸类型：不使用 seq 相关属性，只使用 pickerOptions
        # 保留原有属性，但移除期刊特有的属性
        attrs_to_remove = ['type', ':fetch-seq-options', ':gen-seq-text', ':enable-text-layer']
        filtered_attrs = {k: v for k, v in existing_attributes.items() if k not in attrs_to_remove}
        
        # 确保有必要的属性
        if ':picker-options' not in filtered_attrs:
            filtered_attrs[':picker-options'] = 'pickerOptions'
        if 'name' not in filtered_attrs:
            filtered_attrs['name'] = vue_name
        
        attrs_str = build_attrs_string(filtered_attrs)
        shortcuts_str = build_shortcuts_string(existing_shortcuts)
        disabled_date_str = build_disabled_date_string(missing_dates_info)
        
        # 根据 shortcuts 是否为空来决定是否加逗号
        if shortcuts_str:
            picker_options_content = f'''{disabled_date_str}{shortcuts_str}'''
        else:
            picker_options_content = f'''{disabled_date_str}'''
        
        vue_content = f'''<template>
  <doc-viewer{attrs_str}></doc-viewer>
</template>

<style>
</style>

<script>
import DocViewer from "@/components/DocViewer.vue";

export default {{
  components: {{
    DocViewer,
  }},
  data() {{
    return {{
      pickerOptions: {{
        {picker_options_content}
      }},
    }};
  }},
}}
</script>'''
    else:
        # 期刊类型：使用 seq 相关属性
        available_years = sorted([int(year) for year in year_seq_dict.keys()])
        
        # 保留原有属性，但覆盖期刊特有的属性
        attrs_to_keep = {k: v for k, v in existing_attributes.items() 
                        if k not in ['type', ':fetch-seq-options', ':gen-seq-text', ':enable-text-layer']}
        
        # 添加期刊必需的属性
        attrs_to_keep[':picker-options'] = 'pickerOptions'
        attrs_to_keep['name'] = vue_name
        attrs_to_keep['type'] = 'magazine'
        attrs_to_keep[':fetch-seq-options'] = 'getSeqOptions'
        attrs_to_keep[':gen-seq-text'] = 'genSeqText'
        attrs_to_keep[':enable-text-layer'] = 'true'
        
        attrs_str = build_attrs_string(attrs_to_keep)
        
        vue_content = f'''<template>
  <doc-viewer{attrs_str}></doc-viewer>
</template>

<style>
</style>

<script>
import DocViewer from "@/components/DocViewer.vue";

export default {{
  components: {{DocViewer}},
  data() {{
    return {{
      pickerOptions: {{
        disabledDate(time) {{
          let availableYears = [];
          // 遍历年份文件夹，收集所有存在的年份
          availableYears = {available_years};
          const minYear = Math.min(...availableYears);
          const maxYear = Math.max(...availableYears);
          const minDate = new Date(minYear, 0, 0);
          const maxDate = new Date(maxYear, 11, 31);
          if (time.getTime() < minDate.getTime()) {{
            return true;
          }}
          if (time.getTime() > maxDate.getTime()) {{
            return true;
          }}
          return!availableYears.includes(time.getFullYear());
        }},
      }},
    }};
  }},
  methods: {{
    getSeqOptions(date) {{
      const config = {{'''
        
        # 添加每年的期数配置
        for year in sorted(year_seq_dict.keys()):
            seqs = year_seq_dict[year]
            js_config = generate_js_seq_config(seqs)
            vue_content += f'        "{year}": {js_config},\n'
        
        vue_content += '''      };
      return config[date]
    },
    genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },
  }}
</script>'''
    
    return vue_content


def generate_multi_file_diff(pub_code, new_vue_code):
    """
    生成多文件diff数据（支持GitLab风格的review）
    
    Args:
        pub_code: 报刊代码
        new_vue_code: 新生成的Vue代码
        
    Returns:
        {
            'files': [
                {
                    'filename': str,
                    'filepath': str,
                    'status': 'modified' | 'added' | 'deleted',
                    'old_code': str,
                    'new_code': str,
                    'additions': int,
                    'deletions': int,
                    'hunks': [...],  # 用于展开更多代码
                    'old_lines': [...],
                    'new_lines': [...]
                }
            ],
            'total_additions': int,
            'total_deletions': int,
            'total_files': int
        }
    """
    # 加载配置
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    pub_info = config['publications'][pub_code]
    vue_name = pub_info['vue_name']
    
    # Vue文件路径
    views_dir = config['paths']['views']
    vue_filename = f"{vue_name.upper()}View.vue"
    vue_file_path = os.path.join(views_dir, vue_filename)
    
    files = []
    total_additions = 0
    total_deletions = 0
    
    # 处理Vue文件
    exists = os.path.exists(vue_file_path)
    old_code = ""
    
    if exists:
        with open(vue_file_path, 'r', encoding='utf-8') as f:
            old_code = f.read()
    
    old_lines = old_code.splitlines() if old_code else []
    new_lines = new_vue_code.splitlines() if new_vue_code else []
    
    # 计算diff
    file_diff = compute_file_diff(
        filename=vue_filename,
        filepath=vue_file_path,
        old_lines=old_lines,
        new_lines=new_lines,
        exists=exists
    )
    
    files.append(file_diff)
    total_additions += file_diff['additions']
    total_deletions += file_diff['deletions']
    
    return {
        'files': files,
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'total_files': len(files)
    }


def compute_file_diff(filename, filepath, old_lines, new_lines, exists):
    """
    计算单个文件的diff，返回结构化数据
    """
    if not exists:
        # 新文件
        return {
            'filename': filename,
            'filepath': filepath,
            'status': 'added',
            'old_code': '',
            'new_code': '\n'.join(new_lines),
            'additions': len(new_lines),
            'deletions': 0,
            'hunks': [{
                'old_start': 0,
                'old_count': 0,
                'new_start': 1,
                'new_count': len(new_lines),
                'lines': [{'type': 'add', 'old_num': None, 'new_num': i+1, 'content': line} 
                         for i, line in enumerate(new_lines)]
            }],
            'old_lines': [],
            'new_lines': new_lines
        }
    
    # 使用SequenceMatcher进行更精细的diff
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
    
    hunks = []
    additions = 0
    deletions = 0
    
    # 获取操作码并分组为hunks
    opcodes = matcher.get_opcodes()
    
    current_hunk = None
    context_lines = 3  # 上下文行数
    
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == 'equal':
            # 相等的行，可能作为上下文
            if current_hunk is not None:
                # 添加后续上下文
                end_context = min(i2, i1 + context_lines)
                for i in range(i1, end_context):
                    current_hunk['lines'].append({
                        'type': 'context',
                        'old_num': i + 1,
                        'new_num': j1 + (i - i1) + 1,
                        'content': old_lines[i]
                    })
                
                # 如果剩余的相等行太多，结束当前hunk
                if i2 - i1 > context_lines * 2:
                    hunks.append(current_hunk)
                    current_hunk = None
                else:
                    # 继续添加剩余行
                    for i in range(end_context, i2):
                        current_hunk['lines'].append({
                            'type': 'context',
                            'old_num': i + 1,
                            'new_num': j1 + (i - i1) + 1,
                            'content': old_lines[i]
                        })
        else:
            # 非相等的行
            if current_hunk is None:
                # 开始新hunk，添加前置上下文
                current_hunk = {
                    'old_start': max(1, i1 - context_lines + 1),
                    'new_start': max(1, j1 - context_lines + 1),
                    'lines': []
                }
                # 添加前置上下文
                start_context = max(0, i1 - context_lines)
                for i in range(start_context, i1):
                    current_hunk['lines'].append({
                        'type': 'context',
                        'old_num': i + 1,
                        'new_num': j1 - (i1 - i) + 1,
                        'content': old_lines[i]
                    })
            
            if tag == 'delete':
                for i in range(i1, i2):
                    current_hunk['lines'].append({
                        'type': 'delete',
                        'old_num': i + 1,
                        'new_num': None,
                        'content': old_lines[i]
                    })
                    deletions += 1
            elif tag == 'insert':
                for j in range(j1, j2):
                    current_hunk['lines'].append({
                        'type': 'add',
                        'old_num': None,
                        'new_num': j + 1,
                        'content': new_lines[j]
                    })
                    additions += 1
            elif tag == 'replace':
                for i in range(i1, i2):
                    current_hunk['lines'].append({
                        'type': 'delete',
                        'old_num': i + 1,
                        'new_num': None,
                        'content': old_lines[i]
                    })
                    deletions += 1
                for j in range(j1, j2):
                    current_hunk['lines'].append({
                        'type': 'add',
                        'old_num': None,
                        'new_num': j + 1,
                        'content': new_lines[j]
                    })
                    additions += 1
    
    # 添加最后一个hunk
    if current_hunk is not None:
        hunks.append(current_hunk)
    
    # 计算每个hunk的count
    for hunk in hunks:
        old_count = sum(1 for l in hunk['lines'] if l['type'] in ['context', 'delete'])
        new_count = sum(1 for l in hunk['lines'] if l['type'] in ['context', 'add'])
        hunk['old_count'] = old_count
        hunk['new_count'] = new_count
    
    return {
        'filename': filename,
        'filepath': filepath,
        'status': 'modified' if old_lines != new_lines else 'unchanged',
        'old_code': '\n'.join(old_lines),
        'new_code': '\n'.join(new_lines),
        'additions': additions,
        'deletions': deletions,
        'hunks': hunks,
        'old_lines': old_lines,
        'new_lines': new_lines
    }


def generate_vue_diff(pub_code, new_vue_code):
    """
    生成Vue代码的diff（兼容旧API，同时返回新的多文件格式）
    """
    # 获取多文件diff数据
    multi_diff = generate_multi_file_diff(pub_code, new_vue_code)
    
    if len(multi_diff['files']) == 0:
        return {
            'exists': False,
            'old_code': '',
            'new_code': new_vue_code,
            'diff_html': '<div class="diff-new-file">📝 新建文件</div>',
            'vue_filename': 'Unknown.vue',
            'multi_file_diff': multi_diff
        }
    
    file_diff = multi_diff['files'][0]
    
    return {
        'exists': file_diff['status'] != 'added',
        'old_code': file_diff['old_code'],
        'new_code': file_diff['new_code'],
        'diff_html': '',  # 前端会自己渲染
        'vue_filename': file_diff['filename'],
        'vue_file_path': file_diff['filepath'],
        'multi_file_diff': multi_diff
    }


def escape_html(text):
    """转义HTML特殊字符"""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def apply_vue_changes(pub_code, new_vue_code):
    """
    应用Vue代码修改
    
    Args:
        pub_code: 报刊代码
        new_vue_code: 新Vue代码
        
    Returns:
        {'success': bool, 'message': str}
    """
    try:
        # 加载配置
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        pub_info = config['publications'][pub_code]
        vue_name = pub_info['vue_name']
        
        # Vue文件路径
        views_dir = config['paths']['views']
        vue_filename = f"{vue_name.upper()}View.vue"
        vue_file_path = os.path.join(views_dir, vue_filename)
        
        # 确保目录存在
        os.makedirs(os.path.dirname(vue_file_path), exist_ok=True)
        
        # 写入文件
        with open(vue_file_path, 'w', encoding='utf-8') as f:
            f.write(new_vue_code)
        
        return {
            'success': True,
            'message': f'Vue文件已成功更新: {vue_filename}',
            'vue_file_path': vue_file_path
        }
    except Exception as e:
        return {
            'success': False,
            'message': f'更新失败: {str(e)}'
        }


def apply_multi_file_changes(files_to_apply):
    """
    应用多个文件的修改
    
    Args:
        files_to_apply: [{'filepath': str, 'new_code': str}, ...]
        
    Returns:
        {'success': bool, 'message': str, 'applied': int, 'failed': int}
    """
    applied = 0
    failed = 0
    errors = []
    
    for file_info in files_to_apply:
        try:
            filepath = file_info['filepath']
            new_code = file_info['new_code']
            
            # 确保目录存在
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            
            # 写入文件
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_code)
            
            applied += 1
        except Exception as e:
            failed += 1
            errors.append(f"{file_info.get('filename', 'unknown')}: {str(e)}")
    
    return {
        'success': failed == 0,
        'message': f'已应用 {applied} 个文件' + (f'，{failed} 个失败' if failed > 0 else ''),
        'applied': applied,
        'failed': failed,
        'errors': errors
    }


def generate_new_publication_diff(pub_code, pub_info):
    """
    生成新报刊的所有Vue代码diff
    
    Args:
        pub_code: 报刊代码（如 NEWPUB）
        pub_info: 报刊信息字典 {name, type, vue_name, description, default_date, image_filename}
        
    Returns:
        多文件diff数据结构
    """
    # 加载配置
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    vue_name = pub_info.get('vue_name', pub_code.lower())
    pub_name = pub_info.get('name', '')
    pub_type = pub_info.get('type', 'journal')
    description = pub_info.get('description', '')
    default_date = pub_info.get('default_date', '')
    image_filename = pub_info.get('image_filename', f'{vue_name}.jpg')
    
    # 获取项目路径
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    views_dir = os.path.join(project_root, config['paths']['views'])
    router_path = os.path.join(project_root, 'src', 'router', 'index.js')
    navbar_path = os.path.join(project_root, 'src', 'components', 'NavBar.vue')
    homeview_path = os.path.join(project_root, 'src', 'views', 'HomeView.vue')
    
    files = []
    total_additions = 0
    total_deletions = 0
    
    # 1. 生成新的View组件
    new_view_code = generate_new_view_template(vue_name, pub_type, default_date)
    new_view_filename = f"{vue_name.upper()}View.vue"
    new_view_path = os.path.join(views_dir, new_view_filename)
    
    view_diff = compute_file_diff(
        filename=new_view_filename,
        filepath=new_view_path,
        old_lines=[],
        new_lines=new_view_code.splitlines(),
        exists=False
    )
    files.append(view_diff)
    total_additions += view_diff['additions']
    total_deletions += view_diff['deletions']
    
    # 2. 修改HomeView.vue（添加卡片）
    homeview_result = generate_homeview_modification(
        homeview_path, pub_name, vue_name, default_date, description, image_filename
    )
    if homeview_result:
        files.append(homeview_result)
        total_additions += homeview_result['additions']
        total_deletions += homeview_result['deletions']
    
    # 3. 修改router/index.js（添加路由）
    router_result = generate_router_modification(
        router_path, pub_code, vue_name, pub_type, default_date
    )
    if router_result:
        files.append(router_result)
        total_additions += router_result['additions']
        total_deletions += router_result['deletions']
    
    # 4. 修改NavBar.vue（添加菜单项）
    navbar_result = generate_navbar_modification(
        navbar_path, pub_name, vue_name, pub_type, default_date
    )
    if navbar_result:
        files.append(navbar_result)
        total_additions += navbar_result['additions']
        total_deletions += navbar_result['deletions']
    
    return {
        'files': files,
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'total_files': len(files)
    }


def generate_new_view_template(vue_name, pub_type, default_date):
    """生成新报刊的View组件模板"""
    # 从default_date提取年份
    year = default_date[:4] if default_date and len(default_date) >= 4 else '2024'
    
    # 根据类型设置默认期数
    if pub_type == 'newspaper':
        seq_config = f'        "{year}": [...Array(365).keys()].map(i => i + 1),'
        gen_seq_text = '''genSeqText(seq) {
      return '第' + seq + '版'
    },'''
    else:
        seq_config = f'        "{year}": [...Array(24).keys()].map(i => i + 1),'
        gen_seq_text = '''genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },'''
    
    return f'''<template>
  <doc-viewer :picker-options="pickerOptions" name="{vue_name}" type="magazine"
              :fetch-seq-options="getSeqOptions" :gen-seq-text="genSeqText" :enable-text-layer="true"></doc-viewer>
</template>

<style>
</style>

<script>
import DocViewer from "@/components/DocViewer.vue";

export default {{
  components: {{DocViewer}},
  data() {{
    return {{
      pickerOptions: {{
        disabledDate(time) {{
          let availableYears = [];
          // 遍历年份文件夹，收集所有存在的年份
          availableYears = [{year}];
          const minYear = Math.min(...availableYears);
          const maxYear = Math.max(...availableYears);
          const minDate = new Date(minYear, 0, 0);
          const maxDate = new Date(maxYear, 11, 31);
          if (time.getTime() < minDate.getTime()) {{
            return true;
          }}
          if (time.getTime() > maxDate.getTime()) {{
            return true;
          }}
          return!availableYears.includes(time.getFullYear());
        }},
      }},
    }};
  }},
  methods: {{
    getSeqOptions(date) {{
      const config = {{
{seq_config}
      }};
      return config[date]
    }},
    {gen_seq_text}
  }}
}}
</script>'''


def generate_homeview_modification(homeview_path, pub_name, vue_name, default_date, description, image_filename):
    """生成HomeView.vue的修改"""
    if not os.path.exists(homeview_path):
        return None
    
    with open(homeview_path, 'r', encoding='utf-8') as f:
        old_code = f.read()
    
    old_lines = old_code.splitlines()
    
    # 找到cards数组的结束位置（查找最后一个card对象的结束括号）
    # 模式：找到 "      ]" 这行（cards数组的结束）
    cards_end_pattern = re.compile(r'^(\s*)\]$')
    
    # 找到cards数组中最后一个对象
    insert_line = -1
    for i, line in enumerate(old_lines):
        # 找到 description: "..." 的行，后面跟着 }
        if 'description:' in line:
            # 检查下一行是否是 }
            if i + 1 < len(old_lines) and old_lines[i + 1].strip() == '},':
                insert_line = i + 1
            elif i + 1 < len(old_lines) and old_lines[i + 1].strip() == '}':
                insert_line = i + 1
    
    if insert_line == -1:
        # 备用方案：查找 cards: [ 然后找对应的 ]
        in_cards = False
        bracket_count = 0
        for i, line in enumerate(old_lines):
            if 'cards:' in line and '[' in line:
                in_cards = True
                bracket_count = line.count('[') - line.count(']')
            elif in_cards:
                bracket_count += line.count('[') - line.count(']')
                if bracket_count == 0:
                    insert_line = i - 1
                    break
    
    if insert_line == -1:
        return None
    
    # 获取现有卡片数量来确定新ID
    card_count = old_code.count('id:')
    new_id = card_count + 1
    
    # 构建新卡片代码
    # 确保前一个卡片末尾有逗号
    if old_lines[insert_line].strip() == '}':
        old_lines[insert_line] = old_lines[insert_line].rstrip() + ','
    
    new_card = f'''        {{
          id: {new_id},
          title: "{pub_name}",
          imageLink: require("../assets/{image_filename}"),
          route: "/{vue_name}/{default_date}",
          description: "{description}"
        }}'''
    
    # 插入新卡片
    new_lines = old_lines[:insert_line + 1] + [new_card] + old_lines[insert_line + 1:]
    
    return compute_file_diff(
        filename='HomeView.vue',
        filepath=homeview_path,
        old_lines=old_lines,
        new_lines=new_lines,
        exists=True
    )


def generate_router_modification(router_path, pub_code, vue_name, pub_type, default_date):
    """生成router/index.js的修改"""
    if not os.path.exists(router_path):
        return None
    
    with open(router_path, 'r', encoding='utf-8') as f:
        old_code = f.read()
    
    old_lines = old_code.splitlines()
    
    # 路由参数格式：报纸用8位数字，期刊用6位数字
    id_pattern = r'\\d{8}' if pub_type == 'newspaper' else r'\\d{6}'
    
    # 找到404路由之前的位置插入新路由
    insert_line = -1
    for i, line in enumerate(old_lines):
        if "path: '/:w+'" in line or 'name: \'404\'' in line:
            # 找到前面的 { 开始
            for j in range(i - 1, -1, -1):
                if '{' in old_lines[j] and 'path' not in old_lines[j]:
                    insert_line = j
                    break
            break
    
    if insert_line == -1:
        # 备用方案：在routes数组末尾插入
        for i, line in enumerate(old_lines):
            if line.strip() == ']' and 'routes' in ''.join(old_lines[max(0, i-20):i]):
                insert_line = i
                break
    
    if insert_line == -1:
        return None
    
    # 构建新路由代码
    new_routes = f'''  {{
    path: '/{vue_name}/:id({id_pattern})',
    name: '{vue_name}',
    component: () => import('../views/{vue_name.upper()}View.vue')
  }},
  {{
    path: '/{vue_name}',
    redirect: '/{vue_name}/{default_date}'
  }},'''
    
    # 插入新路由
    new_lines = old_lines[:insert_line] + new_routes.splitlines() + old_lines[insert_line:]
    
    return compute_file_diff(
        filename='index.js',
        filepath=router_path,
        old_lines=old_lines,
        new_lines=new_lines,
        exists=True
    )


def generate_navbar_modification(navbar_path, pub_name, vue_name, pub_type, default_date):
    """生成NavBar.vue的修改"""
    if not os.path.exists(navbar_path):
        return None
    
    with open(navbar_path, 'r', encoding='utf-8') as f:
        old_code = f.read()
    
    old_lines = old_code.splitlines()
    
    # 根据类型找到对应的submenu
    # 报纸在"报纸"submenu，期刊在"杂志"submenu
    target_submenu = '报纸' if pub_type == 'newspaper' else '杂志'
    
    # 找到目标submenu的结束位置（</el-submenu>）
    in_target_submenu = False
    insert_line = -1
    
    for i, line in enumerate(old_lines):
        if f'slot="title">{target_submenu}' in line or f"slot=\"title\">{target_submenu}" in line:
            in_target_submenu = True
        elif in_target_submenu and '</el-submenu>' in line:
            insert_line = i
            break
    
    if insert_line == -1:
        return None
    
    # 构建新菜单项
    new_menu_item = f'''      <el-menu-item index="{vue_name}" :route="{{name: '{vue_name}', params: {{id: '{default_date}'}}}}">
        {pub_name}
      </el-menu-item>'''
    
    # 插入新菜单项（在</el-submenu>之前）
    new_lines = old_lines[:insert_line] + new_menu_item.splitlines() + old_lines[insert_line:]
    
    return compute_file_diff(
        filename='NavBar.vue',
        filepath=navbar_path,
        old_lines=old_lines,
        new_lines=new_lines,
        exists=True
    )