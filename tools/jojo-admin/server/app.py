#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Flask Web应用 - 报刊处理系统
"""
from flask import Flask, request, jsonify, Response, send_from_directory
from pathlib import Path
import os
import json
import threading
import time
import warnings
import logging
import re
import shutil
import base64
from file_name_matcher import FileNameMatcher
from processor import generate_vue_file, load_config, stage_files, commit_staged_files, cancel_staged_files, cleanup_old_staging_dirs, count_staged_commit_objects, FILE_WORKERS, PAGE_WORKERS
from storage import (
    check_storage_health,
    describe_publication_storage,
    ensure_publication_storage,
    make_publication_storage_config,
    processed_tree_for_scan,
    validate_config,
)
from vue_generator import generate_vue_code, generate_vue_diff, apply_vue_changes, generate_new_publication_diff, apply_multi_file_changes
from progress_manager import progress_manager
from es_repair_routes import es_repair_blueprint
from content_routes import content_blueprint
from feature_flag_routes import feature_flags_blueprint
from agent_admin_routes import agent_admin_blueprint
import tkinter as tk
from tkinter import filedialog
import requests
from bs4 import BeautifulSoup
import urllib.parse
import zhconv  # 繁简转换

# 抑制警告
warnings.filterwarnings('ignore', category=UserWarning)
warnings.filterwarnings('ignore', category=DeprecationWarning)

app = Flask(__name__)
app.register_blueprint(es_repair_blueprint)
app.register_blueprint(content_blueprint)
app.register_blueprint(feature_flags_blueprint)
app.register_blueprint(agent_admin_blueprint)
matcher = FileNameMatcher('config.json')

# 启动时清理过期的临时目录（清理1小时以上未修改的）
print("[startup] 检查并清理临时目录...")
cleanup_old_staging_dirs(max_age_hours=1)

# 显示并发配置
print(f"[startup] 并发配置: 文件并发={FILE_WORKERS}, 页面并发={PAGE_WORKERS}")

# 记录服务器启动时间
SERVER_START_TIME = time.time()

@app.route('/api/health')
def health_check():
    """服务器健康检查接口"""
    uptime = time.time() - SERVER_START_TIME
    return jsonify({
        'status': 'ok',
        'uptime': uptime,
        'uptime_formatted': format_uptime(uptime)
    })


@app.route('/api/config/validate')
def validate_config_api():
    """校验配置文件"""
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        return jsonify(validate_config(config))
    except Exception as e:
        return jsonify({'success': False, 'errors': [str(e)], 'warnings': []})


@app.route('/api/storage/health')
def storage_health_check():
    """检查存储配置和后端连通性"""
    try:
        write = request.args.get('write', '0') in {'1', 'true', 'yes'}
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        return jsonify(check_storage_health(config, write=write))
    except Exception as e:
        return jsonify({'success': False, 'errors': [str(e)], 'warnings': [], 'backends': {}})

def format_uptime(seconds):
    """格式化运行时长"""
    if seconds < 60:
        return f"{int(seconds)}秒"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}分{secs}秒"
    elif seconds < 86400:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"{hours}小时{minutes}分"
    else:
        days = int(seconds // 86400)
        hours = int((seconds % 86400) // 3600)
        return f"{days}天{hours}小时"

@app.route('/api/fetch-baike', methods=['POST'])
def fetch_baike():
    """从中文维基百科获取报刊简介（第一句话）"""
    try:
        data = request.json
        name = data.get('name', '').strip()
        
        if not name:
            return jsonify({'success': False, 'message': '请提供报刊名称'})
        
        # 使用维基百科API获取摘要
        # 先搜索词条
        search_url = f'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch={urllib.parse.quote(name)}&format=json&utf8=1'
        
        headers = {
            'User-Agent': 'JOJO-Magazine-Tool/1.0 (https://example.com; contact@example.com)',
            'Accept': 'application/json',
        }
        
        response = requests.get(search_url, headers=headers, timeout=10)
        print(f"[fetch_baike] 搜索URL: {search_url}, 状态码: {response.status_code}")
        
        if response.status_code != 200:
            return jsonify({'success': False, 'message': '维基百科搜索失败'})
        
        search_data = response.json()
        search_results = search_data.get('query', {}).get('search', [])
        
        if not search_results:
            return jsonify({'success': False, 'message': '未找到相关词条，请手动输入'})
        
        # 获取第一个搜索结果的标题
        page_title = search_results[0].get('title', '')
        print(f"[fetch_baike] 找到词条: {page_title}")
        
        # 获取词条摘要
        summary_url = f'https://zh.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(page_title)}'
        summary_response = requests.get(summary_url, headers=headers, timeout=10)
        
        if summary_response.status_code != 200:
            # 如果获取失败，尝试使用搜索结果中的snippet
            snippet = search_results[0].get('snippet', '')
            if snippet:
                # 清理HTML标签
                snippet = re.sub(r'<[^>]+>', '', snippet)
                # 转换为简体中文
                snippet = zhconv.convert(snippet, 'zh-hans')
                return jsonify({
                    'success': True,
                    'description': snippet[:100] + '...' if len(snippet) > 100 else snippet,
                    'source': 'wikipedia.org'
                })
            return jsonify({'success': False, 'message': '获取词条详情失败'})
        
        summary_data = summary_response.json()
        extract = summary_data.get('extract', '')
        
        if not extract:
            return jsonify({'success': False, 'message': '未找到词条摘要'})
        
        # 提取第一句话
        sentences = re.split(r'[。！？]', extract)
        first_sentence = sentences[0].strip() if sentences else extract
        
        if first_sentence:
            first_sentence = first_sentence + '。'
            # 转换为简体中文
            first_sentence = zhconv.convert(first_sentence, 'zh-hans')
            # 限制长度
            if len(first_sentence) > 100:
                first_sentence = first_sentence[:97] + '...'
        
        return jsonify({
            'success': True,
            'description': first_sentence,
            'source': 'wikipedia.org'
        })
        
    except requests.Timeout:
        return jsonify({'success': False, 'message': '请求超时，请重试'})
    except Exception as e:
        print(f"[fetch_baike] 获取失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'获取失败，请手动输入'})

@app.route('/api/publications')
def get_publications():
    """获取所有报刊列表"""
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        publications = config.get('publications', {})
        
        # 转换为列表格式
        pub_list = []
        for code, info in publications.items():
            storage_info = describe_publication_storage(code, info, config)
            pub_list.append({
                'code': code,
                'name': info['name'],
                'type': info['type'],
                'vue_name': info.get('vue_name', ''),
                'source_path': info.get('source_path', ''),
                **storage_info
            })
        
        return jsonify({'success': True, 'publications': pub_list})
    
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/publications', methods=['POST'])
def create_publication():
    """创建新报刊配置"""
    try:
        data = request.json
        code = data.get('code', '').strip().upper()
        name = data.get('name', '').strip()
        pub_type = data.get('type', '').strip()
        description = data.get('description', '').strip()
        default_date = data.get('default_date', '').strip()
        
        # 验证必填字段
        if not code or not name or not pub_type:
            return jsonify({'success': False, 'message': '报刊代码、名称和类型为必填项'})
        
        # 验证代码格式（只允许大写字母和数字）
        if not re.match(r'^[A-Z][A-Z0-9]*$', code):
            return jsonify({'success': False, 'message': '报刊代码必须以大写字母开头，只能包含大写字母和数字'})
        
        # 验证类型
        if pub_type not in ['newspaper', 'journal']:
            return jsonify({'success': False, 'message': '类型必须是 newspaper 或 journal'})
        
        # 加载现有配置
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        # 检查是否已存在
        if code in config['publications']:
            return jsonify({'success': False, 'message': f'报刊代码 {code} 已存在'})
        
        # 生成vue_name（小写）
        vue_name = code.lower()
        
        # 检查vue_name是否冲突
        existing_vue_names = [p.get('vue_name', '') for p in config['publications'].values()]
        if vue_name in existing_vue_names:
            return jsonify({'success': False, 'message': f'Vue名称 {vue_name} 已被使用'})
        
        # 生成日期格式
        date_format = 'yyyyMMdd' if pub_type == 'newspaper' else 'yyyyNN'
        
        # 创建新报刊配置
        new_pub = {
            'name': name,
            'type': pub_type,
            'vue_name': vue_name,
            'date_format': date_format,
        }
        new_pub.update(make_publication_storage_config(config, code, new_pub))
        storage_info = describe_publication_storage(code, new_pub, config)
        
        # 保存到配置（临时保存，供后续流程使用）
        # 注意：这里先不写入config.json，等所有文件都准备好再一起保存
        
        return jsonify({
            'success': True,
            'publication': {
                'code': code,
                'name': name,
                'type': pub_type,
                'vue_name': vue_name,
                'date_format': date_format,
                'description': description,
                'default_date': default_date,
                **make_publication_storage_config(config, code, new_pub),
                **storage_info
            }
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/publications/<code>/image', methods=['POST'])
def upload_publication_image(code):
    """上传报刊封面图片（支持裁切和缩放）"""
    try:
        from PIL import Image
        import io
        import base64
        
        # 目标尺寸（与现有封面一致）
        TARGET_WIDTH = 625
        TARGET_HEIGHT = 250
        
        # 检查是否是base64格式的裁切图片
        if request.is_json:
            data = request.json
            image_data = data.get('image_data', '')
            
            if not image_data:
                return jsonify({'success': False, 'message': '没有图片数据'})
            
            # 解析base64图片
            if ',' in image_data:
                image_data = image_data.split(',')[1]
            
            image_bytes = base64.b64decode(image_data)
            img = Image.open(io.BytesIO(image_bytes))
            
        else:
            # 传统文件上传方式
            if 'image' not in request.files:
                return jsonify({'success': False, 'message': '没有找到图片文件'})
            
            file = request.files['image']
            
            if file.filename == '':
                return jsonify({'success': False, 'message': '没有选择文件'})
            
            # 验证文件类型
            allowed_extensions = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
            ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
            
            if ext not in allowed_extensions:
                return jsonify({'success': False, 'message': f'不支持的图片格式，请使用: {", ".join(allowed_extensions)}'})
            
            img = Image.open(file.stream)
        
        # 转换为RGB模式（处理PNG透明背景等）
        if img.mode in ('RGBA', 'P'):
            # 创建白色背景
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        
        # 调整图片尺寸到目标大小
        img = img.resize((TARGET_WIDTH, TARGET_HEIGHT), Image.Resampling.LANCZOS)
        
        # 生成目标文件名（统一使用jpg格式）
        vue_name = code.lower()
        target_filename = f"{vue_name}.jpg"
        
        # 目标路径（src/assets/）
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        assets_dir = os.path.join(project_root, 'src', 'assets')
        target_path = os.path.join(assets_dir, target_filename)
        
        # 确保目录存在
        os.makedirs(assets_dir, exist_ok=True)
        
        # 保存为JPEG（质量90）
        img.save(target_path, 'JPEG', quality=90, optimize=True)
        
        return jsonify({
            'success': True,
            'message': '图片上传成功',
            'filename': target_filename,
            'path': target_path,
            'size': {'width': TARGET_WIDTH, 'height': TARGET_HEIGHT}
        })
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/publications/<code>/generate-vue', methods=['POST'])
def generate_new_publication_vue(code):
    """生成新报刊的所有Vue代码（多文件diff预览）"""
    try:
        data = request.json
        pub_info = data.get('pub_info', {})
        
        if not pub_info:
            return jsonify({'success': False, 'message': '缺少报刊信息'})
        
        # 生成多文件diff
        result = generate_new_publication_diff(code, pub_info)
        
        return jsonify({
            'success': True,
            'multi_file_diff': result
        })
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)})


@app.route('/api/publications/<code>/apply-changes', methods=['POST'])
def apply_new_publication_changes(code):
    """应用新报刊的所有文件变更"""
    try:
        data = request.json
        files_to_apply = data.get('files', [])
        pub_info = data.get('pub_info', {})
        image_data = data.get('image_data')  # base64编码的封面图
        
        if not files_to_apply:
            return jsonify({'success': False, 'message': '没有要应用的文件'})
        
        # 应用所有文件修改
        result = apply_multi_file_changes(files_to_apply)
        
        if not result['success']:
            return jsonify(result)
        
        # 保存封面图到仓库
        if image_data:
            try:
                # 解析base64图片数据
                if ',' in image_data:
                    image_data = image_data.split(',')[1]
                
                image_bytes = base64.b64decode(image_data)
                
                # 保存到Vue项目的assets目录
                vue_assets_path = os.path.join('..', 'src', 'assets')
                os.makedirs(vue_assets_path, exist_ok=True)
                
                image_filename = f"{code.lower()}.jpg"
                image_path = os.path.join(vue_assets_path, image_filename)
                
                # 使用PIL处理图片（确保尺寸正确）
                from PIL import Image
                from io import BytesIO
                
                img = Image.open(BytesIO(image_bytes))
                # 转换为RGB（去除alpha通道）
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                
                # 确保尺寸为625x250
                if img.size != (625, 250):
                    img = img.resize((625, 250), Image.LANCZOS)
                
                img.save(image_path, 'JPEG', quality=90)
                result['image_saved'] = True
                result['image_path'] = image_path
                print(f"[apply_changes] 封面图已保存到: {image_path}")
            except Exception as img_error:
                print(f"[警告] 保存封面图失败: {img_error}")
                result['image_error'] = str(img_error)
        
        # 更新config.json（添加新报刊配置）
        with open('config.json', 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        # 添加新报刊
        new_pub = {
            'name': pub_info.get('name', ''),
            'type': pub_info.get('type', 'journal'),
            'vue_name': pub_info.get('vue_name', code.lower()),
            'date_format': pub_info.get('date_format', 'yyyyNN'),
        }
        new_pub.update(make_publication_storage_config(config, code, pub_info))
        config['publications'][code] = new_pub
        
        # 保存配置
        with open('config.json', 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        
        # 创建本地存储目录；R2/rclone 后端不需要预建目录
        try:
            ensure_publication_storage(code, config['publications'][code], config)
        except Exception as dir_error:
            print(f"[警告] 初始化存储目标失败（可能需要检查配置）: {dir_error}")
        
        result['config_updated'] = True
        return jsonify(result)
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)})

@app.route('/api/generate-vue-preview', methods=['POST'])
def generate_vue_preview():
    """生成Vue代码预览"""
    try:
        data = request.json
        pub_code = data.get('pub_code', '')
        
        print(f"[Vue生成] 开始生成Vue代码预览: {pub_code}")
        
        if not pub_code:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 加载配置 - load_config返回的是字典，直接用pub_code索引
        pubs = load_config()
        pub_info = pubs.get(pub_code)
        
        if not pub_info:
            return jsonify({'success': False, 'message': '报刊不存在'})
        
        # 生成Vue代码（基于完整PDF目录；R2/rclone 后端会临时生成文件名索引目录）
        with processed_tree_for_scan(pub_code, pub_info) as processed_path:
            print(f"[Vue生成] Processed索引路径: {processed_path}")
            print(f"[Vue生成] 目录是否存在: {os.path.exists(processed_path)}")
            new_vue_code = generate_vue_code(pub_code, processed_path)
        print(f"[Vue生成] Vue代码已生成，长度: {len(new_vue_code)}")
        
        # 生成diff
        diff_result = generate_vue_diff(pub_code, new_vue_code)
        
        return jsonify({
            'success': True,
            'exists': diff_result['exists'],
            'old_code': diff_result['old_code'],
            'new_code': diff_result['new_code'],
            'diff_html': diff_result.get('diff_html', ''),
            'vue_filename': diff_result['vue_filename'],
            'multi_file_diff': diff_result.get('multi_file_diff', None)
        })
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'生成失败: {str(e)}'})

@app.route('/api/apply-vue-changes', methods=['POST'])
def apply_vue_changes_api():
    """应用Vue代码修改"""
    try:
        data = request.json
        pub_code = data.get('pub_code', '')
        new_vue_code = data.get('new_vue_code', '')
        
        if not pub_code or not new_vue_code:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 应用修改
        result = apply_vue_changes(pub_code, new_vue_code)
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'应用失败: {str(e)}'})

@app.route('/api/browse-folder', methods=['POST'])
def browse_folder():
    """打开文件夹选择对话框"""
    try:
        # 每次创建新的tkinter窗口，避免状态问题
        root = tk.Tk()
        root.withdraw()
        
        # 强制窗口置顶
        root.wm_attributes('-topmost', 1)
        root.lift()
        root.focus_force()
        
        # 打开文件夹选择对话框
        folder_path = filedialog.askdirectory(
            parent=root,
            title='选择包含PDF文件的文件夹'
        )
        
        # 销毁窗口
        root.destroy()
        
        if folder_path:
            # 转换为正斜杠
            folder_path = folder_path.replace('\\', '/')
            return jsonify({'success': True, 'path': folder_path})
        else:
            return jsonify({'success': False, 'message': '未选择文件夹'})
    
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@app.route('/api/scan-files', methods=['POST'])
def scan_files():
    """扫描源目录并生成文件名映射（递归扫描子目录）"""
    try:
        data = request.json
        source_dir = data.get('source_dir', '')
        pub_code = data.get('pub_code', '')
        pub_type = data.get('pub_type', '')
        pub_name = data.get('pub_name', '')  # 新报刊流程会传递这个参数
        
        if not source_dir or not pub_code:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        if not os.path.exists(source_dir):
            return jsonify({'success': False, 'message': '源目录不存在'})
        
        # 递归获取所有PDF文件（包括子目录）
        files = []
        file_paths = {}  # 记录文件名到相对路径的映射
        for root, dirs, filenames in os.walk(source_dir):
            for filename in filenames:
                if filename.lower().endswith('.pdf'):
                    files.append(filename)
                    # 保存相对路径，用于后续处理
                    rel_path = os.path.relpath(os.path.join(root, filename), source_dir)
                    file_paths[filename] = rel_path
        
        if not files:
            return jsonify({'success': False, 'message': '目录及子目录中没有PDF文件'})
        
        # 使用matcher批量匹配
        results = matcher.batch_match(files, pub_type, pub_code)
        
        # 为每个结果添加相对路径信息
        for r in results:
            r['rel_path'] = file_paths.get(r['original'], r['original'])
        
        # 统计
        success_count = sum(1 for r in results if r['success'])
        failed_count = len(results) - success_count
        
        # 如果有失败的，生成AI提示
        ai_prompt = None
        if failed_count > 0:
            failed_files = [r['original'] for r in results if not r['success']]
            # 优先使用传递的pub_name（新报刊流程），否则从config读取
            if not pub_name:
                try:
                    with open('config.json', 'r', encoding='utf-8') as f:
                        config = json.load(f)
                    pub_name = config['publications'][pub_code]['name']
                except KeyError:
                    pub_name = pub_code  # 如果都没有，使用代码作为名称
            ai_prompt = matcher.generate_ai_prompt(results, failed_files, pub_type, pub_name)
        
        return jsonify({
            'success': True,
            'mapping': results,
            'stats': {
                'total': len(results),
                'success': success_count,
                'failed': failed_count
            },
            'ai_prompt': ai_prompt
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'扫描失败: {str(e)}'})

@app.route('/api/apply-custom-rule', methods=['POST'])
def apply_custom_rule():
    """应用自定义规则到失败的文件"""
    try:
        data = request.json
        rule = data.get('rule', {})
        failed_files = data.get('failed_files', [])
        pub_type = data.get('pub_type', 'journal')  # 报刊类型，默认期刊
        
        if not rule or not failed_files:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 测试规则，传递报刊类型用于格式校验
        result = matcher.test_custom_rule(rule, failed_files, pub_type)
        
        return jsonify(result)
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'测试失败: {str(e)}'})

@app.route('/api/generate-iteration-prompt', methods=['POST'])
def generate_iteration_prompt():
    """为剩余失败文件生成新的AI提示词（迭代处理）"""
    try:
        data = request.json
        pub_type = data.get('pub_type', '')
        pub_name = data.get('pub_name', '')
        success_samples = data.get('success_samples', [])  # 已成功匹配的示例
        remaining_failed = data.get('remaining_failed', [])  # 仍然失败的文件
        
        if not remaining_failed:
            return jsonify({'success': False, 'message': '没有失败的文件'})
        
        # 构建 all_files_with_results 格式
        all_files = []
        for item in success_samples:
            all_files.append({
                'original': item['original'],
                'renamed': item['renamed'],
                'success': True
            })
        for filename in remaining_failed:
            all_files.append({
                'original': filename,
                'renamed': filename,
                'success': False
            })
        
        # 生成新的 prompt
        prompt = matcher.generate_ai_prompt(all_files, remaining_failed, pub_type, pub_name)
        
        return jsonify({
            'success': True,
            'ai_prompt': prompt,
            'remaining_count': len(remaining_failed)
        })
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'生成失败: {str(e)}'})

@app.route('/api/save-custom-rule', methods=['POST'])
def save_custom_rule():
    """保存自定义规则（临时缓存到会话）"""
    try:
        data = request.json
        pub_code = data.get('pub_code', '')
        rule = data.get('rule', {})
        
        if not pub_code or not rule:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 添加到会话缓存（不保存到文件）
        matcher.add_to_session_cache(pub_code, rule)
        
        return jsonify({'success': True, 'message': '规则已应用到当前会话'})
    
    except Exception as e:
        return jsonify({'success': False, 'message': f'保存失败: {str(e)}'})

@app.route('/api/start-staging', methods=['POST'])
def start_staging():
    """启动预处理任务（异步）"""
    try:
        data = request.json
        source_dir = data.get('source_dir', '')
        pub_code = data.get('pub_code', '')
        mapping = data.get('mapping', [])
        new_pub_config = data.get('new_pub_config', None)  # 新报刊配置（用于新报刊onboard流程）
        
        if not source_dir or not pub_code or not mapping:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 生成任务ID和staging_id（立即生成，以便前端保存）
        task_id = f"{pub_code}_{int(time.time() * 1000)}"
        staging_id = str(__import__('uuid').uuid4())
        
        # 预扫描：统计总页数（用于精确进度计算）
        files_to_process = [m for m in mapping if m.get('success')]
        total_files = len(files_to_process)
        total_pages = 0
        for item in files_to_process:
            # 使用 rel_path（相对路径）如果存在，否则使用 original
            rel_path = item.get('rel_path', item['original'])
            source_file = os.path.join(source_dir, rel_path)
            try:
                import pikepdf
                with pikepdf.open(source_file) as pdf:
                    total_pages += len(pdf.pages)
            except Exception as e:
                print(f"[预扫描] 无法打开文件 {source_file}: {e}")
                pass
        
        # 创建进度任务（同时跟踪文件数和页数）
        progress_manager.create_task(task_id, total_files, total_pages)
        
        # 在后台线程执行处理
        def run_staging():
            def progress_callback(completed_files, current_page, processing_files):
                progress_manager.update(task_id, completed_files, current_page, processing_files)
            
            def is_cancelled_callback():
                return progress_manager.is_cancelled(task_id)
            
            try:
                results = stage_files(source_dir, pub_code, mapping, progress_callback, staging_id, is_cancelled_callback, new_pub_config)
                
                # 检查是否被取消
                if progress_manager.is_cancelled(task_id):
                    print(f"[任务取消] 任务已被用户取消: {task_id}")
                    return
                
                # 将结果存储到任务中
                progress_manager.set_result(task_id, results)
                progress_manager.complete(task_id)
            except Exception as e:
                if not progress_manager.is_cancelled(task_id):
                    progress_manager.fail(task_id, str(e))
        
        thread = threading.Thread(target=run_staging, daemon=True)
        thread.start()
        
        return jsonify({'success': True, 'task_id': task_id, 'staging_id': staging_id})
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'启动失败: {str(e)}'})

@app.route('/api/progress/<task_id>')
def get_progress(task_id):
    """获取任务进度（SSE流）"""
    def generate():
        while True:
            progress = progress_manager.get_progress(task_id)
            
            if not progress:
                yield f"data: {json.dumps({'status': 'not_found'})}\n\n"
                break
            
            status = progress['status']
            
            # 发送进度数据
            yield f"data: {json.dumps(progress)}\n\n"
            
            # 如果任务完成或失败，结束流
            if status in ['completed', 'failed', 'cancelled']:
                break
            
            time.sleep(0.1)  # 每0.1秒更新一次（更流畅）
    
    return Response(generate(), mimetype='text/event-stream')

@app.route('/api/commit-files', methods=['POST'])
def commit_files():
    """阶段2：确认后提交文件到目标存储"""
    try:
        data = request.json
        staging_id = data.get('staging_id', '')
        pub_code = data.get('pub_code', '')
        new_pub_config = data.get('new_pub_config', None)
        
        if not staging_id or not pub_code:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        counts = count_staged_commit_objects(staging_id)
        if not counts['success']:
            return jsonify(counts)

        task_id = f"{pub_code}_commit_{int(time.time() * 1000)}"
        progress_manager.create_task(
            task_id,
            counts['total'],
            counts['total'],
            task_type='commit',
            unit_label='对象'
        )

        def run_commit():
            def progress_callback(completed_files, current_object, processing_files):
                progress_manager.update(task_id, completed_files, current_object, processing_files)

            def is_cancelled_callback():
                return progress_manager.is_cancelled(task_id)

            try:
                result = commit_staged_files(
                    staging_id,
                    pub_code,
                    new_pub_config,
                    progress_callback,
                    is_cancelled_callback
                )

                if progress_manager.is_cancelled(task_id):
                    print(f"[提交取消] 任务已被用户取消: {task_id}")
                    return

                if result['success']:
                    progress_manager.set_result(task_id, result)
                    progress_manager.complete(task_id)
                else:
                    progress_manager.set_result(task_id, result)
                    progress_manager.fail(task_id, result.get('message', '提交失败'))
            except Exception as e:
                if not progress_manager.is_cancelled(task_id):
                    progress_manager.fail(task_id, str(e))

        thread = threading.Thread(target=run_commit, daemon=True)
        thread.start()

        return jsonify({'success': True, 'task_id': task_id, 'counts': counts})
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'提交失败: {str(e)}'})

@app.route('/api/cancel-staging', methods=['POST'])
def cancel_staging():
    """取消预处理"""
    try:
        data = request.json
        staging_id = data.get('staging_id', '')
        task_id = data.get('task_id', '')  # 可选的task_id
        force_wait = data.get('force_wait', False)  # 是否等待任务完全停止
        
        if not staging_id:
            return jsonify({'success': False, 'message': '参数不完整'})
        
        # 如果提供了task_id，立即标记任务为取消
        if task_id:
            print(f"[取消任务] 立即停止任务: {task_id}")
            progress_manager.cancel(task_id)
            
            if force_wait:
                # 等待任务停止（最多等待3秒）
                for i in range(6):
                    time.sleep(0.5)
                    task_status = progress_manager.get_progress(task_id)
                    if not task_status or task_status.get('status') == 'cancelled':
                        print(f"[取消任务] 任务已停止")
                        break
        
        # 尝试删除临时文件
        result = cancel_staged_files(staging_id)
        
        # 如果删除失败但任务已取消，启动后台清理任务
        if not result['success'] and task_id:
            # 异步清理其他旧的临时目录
            def async_cleanup():
                time.sleep(2)  # 等待2秒让文件句柄释放
                print(f"[后台清理] 开始清理临时目录...")
                cleanup_old_staging_dirs(max_age_hours=0.1)  # 清理6分钟以上未修改的
            
            cleanup_thread = threading.Thread(target=async_cleanup, daemon=True)
            cleanup_thread.start()
            
            return jsonify({
                'success': True, 
                'message': '任务已取消，临时文件将在几秒后清理。',
                'partial': True
            })
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'success': False, 'message': f'取消失败: {str(e)}'})

@app.route('/api/project-info', methods=['GET'])
def get_project_info():
    """获取项目信息"""
    try:
        # 获取项目根目录（JoJoPipe的父目录）
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        # 转换为正斜杠（用于URI）
        project_root = project_root.replace('\\', '/')
        
        return jsonify({
            'success': True,
            'project_root': project_root
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@app.route('/api/open-in-ide', methods=['POST'])
def open_in_ide():
    """在IDE中打开文件"""
    try:
        import subprocess
        import glob
        
        data = request.get_json() or {}
        file_path = data.get('file_path', '')
        
        # 获取项目根目录
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
        # 如果提供了相对路径，转换为绝对路径
        if file_path and not os.path.isabs(file_path):
            file_path = os.path.join(project_root, file_path)
        
        # 查找WebStorm安装路径
        webstorm_paths = [
            # 标准安装路径（Program Files）
            r'C:\Program Files\JetBrains\WebStorm 2023.3.4\bin\webstorm64.exe',
            r'C:\Program Files\JetBrains\WebStorm*\bin\webstorm64.exe',
            # JetBrains Toolbox 安装路径
            os.path.expandvars(r'%LOCALAPPDATA%\JetBrains\Toolbox\apps\WebStorm\ch-0\*\bin\webstorm64.exe'),
            # 其他可能的路径
            os.path.expandvars(r'%LOCALAPPDATA%\Programs\WebStorm\bin\webstorm64.exe'),
            os.path.expandvars(r'%PROGRAMFILES%\JetBrains\WebStorm*\bin\webstorm64.exe'),
        ]
        
        webstorm_exe = None
        for pattern in webstorm_paths:
            matches = glob.glob(pattern)
            if matches:
                # 取最新版本（按路径排序取最后一个）
                webstorm_exe = sorted(matches)[-1]
                break
        
        if not webstorm_exe:
            return jsonify({
                'success': False, 
                'message': '未找到WebStorm，请确保已安装'
            })
        
        # 构建命令
        if file_path and os.path.exists(file_path):
            # 打开特定文件
            cmd = [webstorm_exe, project_root, file_path]
        else:
            # 只打开项目
            cmd = [webstorm_exe, project_root]
        
        print(f"[IDE] 执行命令: {cmd}")
        
        # 启动WebStorm（不等待）
        subprocess.Popen(cmd, shell=False)
        
        return jsonify({
            'success': True,
            'message': '已打开WebStorm'
        })
        
    except Exception as e:
        print(f"[IDE] 打开失败: {e}")
        return jsonify({'success': False, 'message': f'打开失败: {str(e)}'})

FRONTEND_DIST = Path(__file__).resolve().parent.parent / 'web' / 'dist'


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_admin_console(path):
    """托管 React JOJO 管理台，并把客户端路由回退到 index.html。"""
    requested = FRONTEND_DIST / path
    if path and requested.is_file():
        return send_from_directory(FRONTEND_DIST, path)
    index_file = FRONTEND_DIST / 'index.html'
    if not index_file.exists():
        return jsonify({
            'success': False,
            'message': 'JOJO 管理台尚未构建，请运行 pnpm build:admin'
        }), 503
    return send_from_directory(FRONTEND_DIST, 'index.html')


if __name__ == '__main__':
    print("=" * 50)
    print("JOJO报刊处理系统启动中...")
    print("=" * 50)
    print("访问地址: http://127.0.0.1:5000")
    print("=" * 50)
    app.run(debug=True, host='127.0.0.1', port=5000)

