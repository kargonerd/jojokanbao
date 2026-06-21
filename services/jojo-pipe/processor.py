#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简单的报纸期刊处理器 - 整合重命名、拆分、生成Vue的功能
"""
import os
import json
import shutil
import tempfile
import uuid
import warnings
import threading
import pikepdf
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import logging
from storage import PublicationStorage, load_publications, processed_tree_for_scan

# 并发配置
FILE_WORKERS = 4  # 文件级并发：同时处理4个文件
PAGE_WORKERS = 3  # 页面级并发：每个文件内部3个线程拆分页面

# 配置
CONFIG_PATH = 'config.json'

def load_config():
    """加载配置"""
    return load_publications(CONFIG_PATH)

def get_paths_for_pub(pub_code):
    """获取报刊的路径配置"""
    storage = PublicationStorage(pub_code)
    return {
        'processed_path': storage.processed_label,
        'split_path': storage.split_label
    }

def stage_files(source_dir, pub_code, mapping, progress_callback=None, staging_id=None, is_cancelled_callback=None, new_pub_config=None):
    """
    阶段1：在临时目录处理文件（安全预处理）
    
    progress_callback: 进度回调函数 callback(file_index, page_index, current_file, status)
    staging_id: 可选的预生成staging_id，如果不提供则自动生成
    is_cancelled_callback: 检查任务是否被取消的回调函数
    new_pub_config: 新报刊的配置信息（用于新报刊onboard流程，此时配置还未保存到config.json）
    
    返回: {
        'success': True/False,
        'staging_id': 临时处理ID,
        'staging_dir': 临时目录路径,
        'preview': [{...}],
        'errors': [],
        'skipped': []
    }
    """
    storage = PublicationStorage(pub_code, new_pub_config)
    
    # 创建临时处理目录（如果没有提供staging_id则生成）
    if not staging_id:
        staging_id = str(uuid.uuid4())
    temp_base = tempfile.gettempdir()
    staging_dir = os.path.join(temp_base, f'jojo_staging_{staging_id}')
    os.makedirs(staging_dir, exist_ok=True)
    
    results = {
        'success': True,
        'staging_id': staging_id,
        'staging_dir': staging_dir,
        'preview': [],
        'errors': [],
        'skipped': []
    }
    
    # 获取目标存储中已存在的文件
    existing_files = storage.existing_processed_ids()
    
    print(f"[预处理] 临时目录: {staging_dir}")
    print(f"[预处理] 目标存储已有 {len(existing_files)} 个文件: {storage.processed_label}")
    
    # 筛选需要处理的文件
    files_to_process = []
    for item in mapping:
        if not item.get('success'):
            continue
        
        date_str = os.path.splitext(item['renamed'])[0]
        if date_str in existing_files:
            results['skipped'].append({
                'original': item['original'],
                'renamed': item['renamed'],
                'reason': '目标存储已存在'
            })
        else:
            files_to_process.append(item)
    
    total_files = len(files_to_process)
    print(f"[预处理] 需要处理 {total_files} 个文件")
    
    # 预扫描：获取所有文件的总页数（用于精确计算进度）
    print(f"[预扫描] 统计总页数...")
    total_pages = 0
    file_page_counts = {}
    for item in files_to_process:
        # 使用相对路径（如果有）或原始文件名
        rel_path = item.get('rel_path', item['original'])
        source_file = os.path.join(source_dir, rel_path)
        try:
            with pikepdf.open(source_file) as pdf:
                page_count = len(pdf.pages)
                file_page_counts[item['original']] = page_count
                total_pages += page_count
        except:
            file_page_counts[item['original']] = 0
    
    print(f"[预扫描] 总计 {total_pages} 页")
    processed_pages = 0
    completed_files = 0  # 已完成的文件数
    processing_files_status = {}  # {file_index: {name, status, current_page, total_pages}}
    processed_pages_lock = threading.Lock()  # 用于线程安全地更新页数
    results_lock = threading.Lock()  # 用于线程安全地更新结果
    
    # 定义单个文件的处理函数
    def process_single_file(index, item):
        nonlocal processed_pages, completed_files
        
        # 检查任务是否被取消
        if is_cancelled_callback and is_cancelled_callback():
            print(f"[任务取消] 停止处理文件")
            return
        
        original_name = item['original']
        renamed_name = item['renamed']
        # 使用相对路径（如果有）或原始文件名
        rel_path = item.get('rel_path', original_name)
        source_file = os.path.join(source_dir, rel_path)
        page_count = file_page_counts.get(original_name, 0)
        
        # 标记开始处理这个文件
        with processed_pages_lock:
            processing_files_status[index] = {
                'name': original_name,
                'status': '复制文件',
                'current_page': 0,
                'total_pages': page_count
            }
            if progress_callback:
                progress_callback(completed_files, processed_pages, processing_files_status)
        
        if not os.path.exists(source_file):
            # 文件不存在也要计入页数进度
            failed_pages = file_page_counts.get(original_name, 0)
            with processed_pages_lock:
                processed_pages += failed_pages
                current_pages = processed_pages
                if index in processing_files_status:
                    del processing_files_status[index]
                completed_files += 1
            
            with results_lock:
                results['errors'].append({
                    'original': original_name,
                    'renamed': renamed_name,
                    'error': '文件不存在',
                    'pages': failed_pages
                })
            
            if progress_callback:
                progress_callback(completed_files, current_pages, processing_files_status)
            return
        
        # 提取日期和年份
        date_str = os.path.splitext(renamed_name)[0]
        year = date_str[:4]
        
        try:
            # 在临时目录创建年份文件夹
            staging_year_dir = os.path.join(staging_dir, 'processed', year)
            staging_split_dir = os.path.join(staging_dir, 'split', year)
            os.makedirs(staging_year_dir, exist_ok=True)
            os.makedirs(staging_split_dir, exist_ok=True)
            
            # 复制并重命名文件到临时目录
            temp_file = os.path.join(staging_year_dir, renamed_name)
            shutil.copy2(source_file, temp_file)
            
            # 获取文件信息
            file_size = os.path.getsize(temp_file)
            
            # 拆分PDF
            split_count = 0
            failed_pages = []  # 记录失败的页面
            try:
                # 先获取页数
                with pikepdf.open(temp_file) as pdf:
                    page_count = len(pdf.pages)
                
                print(f"[拆分中] {original_name} ({page_count}页)...")
                
                # 拆分为单页（批量并发处理）
                # 将页面分组，每个线程处理一批页面（减少PDF打开次数）
                def split_page_batch(page_batch):
                    """处理一批页面，每个线程只打开一次PDF"""
                    results = []
                    try:
                        # 每个线程打开一次PDF，处理多个页面
                        with pikepdf.open(temp_file) as src_pdf:
                            for page_index in page_batch:
                                try:
                                    dst_pdf = pikepdf.new()
                                    dst_pdf.pages.append(src_pdf.pages[page_index - 1])
                                    split_file = os.path.join(staging_split_dir, f"{date_str}-{page_index}.pdf")
                                    # 不压缩流，避免损坏的流导致错误（最稳定）
                                    dst_pdf.save(split_file, compress_streams=False)
                                    dst_pdf.close()
                                    results.append((True, page_index, None))
                                except Exception as e:
                                    error_msg = str(e)
                                    print(f"[页面错误] {original_name} 第{page_index}页拆分失败: {error_msg}")
                                    results.append((False, page_index, error_msg))
                    except Exception as e:
                        # 整批失败
                        print(f"[批次错误] {original_name}: {str(e)}")
                        for page_index in page_batch:
                            results.append((False, page_index, str(e)))
                    return results
                
                # 使用线程池并发处理（批量模式：减少PDF打开次数，保持进度流畅）
                try:
                    # 将页面分成多个批次，每批5页（平衡性能和流畅度）
                    page_indices = list(range(1, page_count + 1))
                    batch_size = 5  # 每批5页：既减少PDF打开次数，又保持进度流畅
                    page_batches = [page_indices[i:i + batch_size] for i in range(0, len(page_indices), batch_size)]
                    
                    with ThreadPoolExecutor(max_workers=PAGE_WORKERS) as executor:
                        futures = [executor.submit(split_page_batch, batch) for batch in page_batches]
                        
                        for future in as_completed(futures):
                            # 检查任务是否被取消
                            if is_cancelled_callback and is_cancelled_callback():
                                print(f"[任务取消] 停止拆分页面: {original_name}")
                                break
                            
                            try:
                                # 获取批次结果（列表）
                                batch_results = future.result(timeout=60)  # 批次处理需要更长超时
                                
                                for success, page_num, error_msg in batch_results:
                                    if success:
                                        split_count += 1
                                    else:
                                        failed_pages.append(page_num)
                                    
                                    # 每完成一页就更新进度
                                    with processed_pages_lock:
                                        processed_pages += 1
                                        current_pages = processed_pages
                                        # 更新当前文件的状态
                                        if index in processing_files_status:
                                            processing_files_status[index]['status'] = f'拆分PDF'
                                            processing_files_status[index]['current_page'] = split_count
                                    
                                    if progress_callback:
                                        progress_callback(completed_files, current_pages, processing_files_status)
                                        
                            except Exception as e:
                                # future.result() 超时或出错
                                print(f"[批次超时/错误] {original_name}: {str(e)}")
                                # 这批页面都算失败，但我们不知道具体是哪些页
                except Exception as e:
                    raise Exception(f"线程池错误: {str(e)}")
                
                # 根据是否有失败页面，决定是成功还是失败
                if failed_pages:
                    # 有页面失败 = 整个文件算失败
                    failed_count = len(failed_pages)
                    print(f"[失败] {original_name} -> {renamed_name} (成功: {split_count}/{page_count}页, 失败: {failed_count}页)")
                    
                    # 添加到错误列表
                    with results_lock:
                        results['errors'].append({
                            'original': original_name,
                            'renamed': renamed_name,
                            'error': f'{failed_count}页拆分失败 (失败页码: {", ".join(map(str, failed_pages[:10]))}{"..." if len(failed_pages) > 10 else ""})',
                            'pages': page_count,
                            'split_count': split_count,
                            'failed_pages': failed_pages
                        })
                else:
                    # 所有页面都成功 = 完全成功
                    print(f"[完成] {original_name} -> {renamed_name} ({page_count}页)")
                    
                    # 添加到预览（成功）列表
                    with results_lock:
                        results['preview'].append({
                            'original': original_name,
                            'renamed': renamed_name,
                            'date': date_str,
                            'year': year,
                            'pages': page_count,
                            'split_count': split_count,
                            'size': file_size,
                            'size_mb': round(file_size / 1024 / 1024, 2)
                        })
                
            except Exception as e:
                print(f"[错误] {original_name}: 拆分失败 - {str(e)}")
                # 失败的文件也要计入页数进度（如果有总页数的话）
                failed_pages = file_page_counts.get(original_name, 0)
                with processed_pages_lock:
                    processed_pages += failed_pages
                    current_pages = processed_pages
                
                with results_lock:
                    # 将失败文件添加到 errors 列表（详细信息）
                    results['errors'].append({
                        'original': original_name,
                        'renamed': renamed_name,
                        'error': str(e),
                        'pages': failed_pages
                    })
                
                # 更新进度
                if progress_callback:
                    progress_callback(completed_files, current_pages, processing_files_status)
            
        except Exception as e:
            print(f"[错误] {original_name}: {str(e)}")
            # 失败的文件也要计入页数进度
            failed_pages = file_page_counts.get(original_name, 0)
            with processed_pages_lock:
                processed_pages += failed_pages
                current_pages = processed_pages
            
            with results_lock:
                results['errors'].append({
                    'original': original_name,
                    'renamed': renamed_name,
                    'error': str(e),
                    'pages': failed_pages
                })
            
            # 更新进度
            if progress_callback:
                progress_callback(completed_files, current_pages, processing_files_status)
        
        # 文件处理完成，从正在处理列表中移除
        with processed_pages_lock:
            if index in processing_files_status:
                del processing_files_status[index]
            completed_files += 1
            if progress_callback:
                progress_callback(completed_files, processed_pages, processing_files_status)
    
    # 并发处理多个文件
    print(f"[开始处理] 并发处理 {len(files_to_process)} 个文件（同时{FILE_WORKERS}个）")
    with ThreadPoolExecutor(max_workers=FILE_WORKERS) as file_executor:
        file_futures = [file_executor.submit(process_single_file, i+1, item) 
                       for i, item in enumerate(files_to_process)]
        
        # 等待所有文件处理完成
        for future in as_completed(file_futures):
            try:
                future.result()  # 获取结果，如果有异常会抛出
            except Exception as e:
                print(f"[文件处理异常] {str(e)}")
    
    print(f"[预处理完成] 成功: {len(results['preview'])}, 错误: {len(results['errors'])}, 跳过: {len(results['skipped'])}")
    
    return results

def _commit_jobs_for_staging(staging_dir):
    jobs = []
    processed_staging = os.path.join(staging_dir, 'processed')
    if os.path.exists(processed_staging):
        for year_folder in sorted(os.listdir(processed_staging)):
            src_year_dir = os.path.join(processed_staging, year_folder)
            if not os.path.isdir(src_year_dir):
                continue
            for filename in sorted(os.listdir(src_year_dir)):
                src_file = os.path.join(src_year_dir, filename)
                if os.path.isfile(src_file):
                    jobs.append({
                        'kind': 'processed',
                        'year': year_folder,
                        'filename': filename,
                        'src_file': src_file
                    })

    split_staging = os.path.join(staging_dir, 'split')
    if os.path.exists(split_staging):
        for year_folder in sorted(os.listdir(split_staging)):
            src_year_dir = os.path.join(split_staging, year_folder)
            if not os.path.isdir(src_year_dir):
                continue
            for filename in sorted(os.listdir(src_year_dir)):
                src_file = os.path.join(src_year_dir, filename)
                if os.path.isfile(src_file):
                    jobs.append({
                        'kind': 'split',
                        'year': year_folder,
                        'filename': filename,
                        'src_file': src_file
                    })

    return jobs


def count_staged_commit_objects(staging_id):
    temp_base = tempfile.gettempdir()
    staging_dir = os.path.join(temp_base, f'jojo_staging_{staging_id}')
    if not os.path.exists(staging_dir):
        return {'success': False, 'message': '临时目录不存在', 'total': 0, 'processed': 0, 'split': 0}

    jobs = _commit_jobs_for_staging(staging_dir)
    processed = sum(1 for job in jobs if job['kind'] == 'processed')
    split = sum(1 for job in jobs if job['kind'] == 'split')
    return {'success': True, 'total': len(jobs), 'processed': processed, 'split': split}


def commit_staged_files(staging_id, pub_code, new_pub_config=None, progress_callback=None, is_cancelled_callback=None):
    """
    阶段2：确认后将临时文件提交到目标存储
    """
    storage = PublicationStorage(pub_code, new_pub_config)
    
    # 找到临时目录
    temp_base = tempfile.gettempdir()
    staging_dir = os.path.join(temp_base, f'jojo_staging_{staging_id}')
    
    if not os.path.exists(staging_dir):
        return {'success': False, 'message': '临时目录不存在'}

    jobs = _commit_jobs_for_staging(staging_dir)
    total_jobs = len(jobs)
    
    stats = {
        'processed': 0,
        'split': 0,
        'skipped': 0,
        'errors': [],
        'manifest': None
    }
    
    completed_jobs = 0
    processing_status = {}
    progress_lock = threading.Lock()
    stats_lock = threading.Lock()

    def emit_progress():
        if progress_callback:
            progress_callback(completed_jobs, completed_jobs, processing_status)

    def upload_one(index, job):
        if is_cancelled_callback and is_cancelled_callback():
            raise RuntimeError('任务已取消')

        with progress_lock:
            processing_status[index] = {
                'name': job['filename'],
                'status': '上传完整PDF' if job['kind'] == 'processed' else '上传拆分页',
                'current_page': 0,
                'total_pages': 1
            }
            emit_progress()

        if job['kind'] == 'processed':
            uploaded = storage.put_processed(job['year'], job['filename'], job['src_file'])
        else:
            uploaded = storage.put_split(job['filename'], job['src_file'])

        with progress_lock:
            if index in processing_status:
                processing_status[index]['current_page'] = 1
                processing_status[index]['status'] = '完成' if uploaded else '已存在，跳过'

        return job, uploaded

    success = False
    try:
        if total_jobs == 0:
            success = True
            return {'success': True, 'stats': stats}

        max_workers = max(1, int(storage.backend_config.get('upload_workers', 4)))
        print(f"[提交] 开始上传 {total_jobs} 个对象（并发 {max_workers}）")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(upload_one, index + 1, job)
                for index, job in enumerate(jobs)
            ]

            for future in as_completed(futures):
                with progress_lock:
                    completed_jobs += 1

                try:
                    job, uploaded = future.result()
                    with stats_lock:
                        if uploaded:
                            if job['kind'] == 'processed':
                                stats['processed'] += 1
                            else:
                                stats['split'] += 1
                        else:
                            stats['skipped'] += 1
                except Exception as e:
                    with stats_lock:
                        stats['errors'].append(str(e))

                with progress_lock:
                    done_indexes = [
                        index for index, file_info in processing_status.items()
                        if file_info.get('current_page') == file_info.get('total_pages')
                    ]
                    for index in done_indexes:
                        processing_status.pop(index, None)
                    emit_progress()

                if is_cancelled_callback and is_cancelled_callback():
                    return {'success': False, 'message': '任务已取消', 'stats': stats}

        if stats['errors']:
            return {
                'success': False,
                'message': '部分对象提交失败或已存在，请检查后重试',
                'stats': stats
            }

        stats['manifest'] = storage.write_manifest(stats)
        print(f"[提交完成] 完整PDF: {stats['processed']}, 拆分: {stats['split']}, manifest: {stats['manifest']}")
        success = True
        
        return {
            'success': True,
            'stats': stats
        }
        
    except Exception as e:
        return {
            'success': False,
            'message': f'提交失败: {str(e)}'
        }
    finally:
        # 成功后清理临时目录；失败时保留，便于重试或排查
        if success and os.path.exists(staging_dir):
            try:
                shutil.rmtree(staging_dir)
                print(f"[清理] 已删除临时目录: {staging_dir}")
            except Exception as e:
                print(f"[警告] 清理临时目录失败: {str(e)}")

def cancel_staged_files(staging_id):
    """取消预处理，删除临时文件（快速尝试，失败不阻塞）"""
    temp_base = tempfile.gettempdir()
    staging_dir = os.path.join(temp_base, f'jojo_staging_{staging_id}')
    
    if not os.path.exists(staging_dir):
        return {'success': True, 'message': '临时目录不存在或已删除'}
    
    # 快速尝试删除（不重试，失败立即返回）
    try:
        # 尝试强制垃圾回收
        import gc
        gc.collect()
        
        shutil.rmtree(staging_dir)
        print(f"[已取消] 清理临时目录: {staging_dir}")
        return {'success': True, 'message': '任务已取消，临时文件已删除'}
    except PermissionError as e:
        print(f"[延迟清理] 临时目录被占用，将自动清理: {staging_dir}")
        # 文件被占用时不算失败，因为会自动清理
        return {
            'success': False,
            'message': '临时文件正在使用中，将在后台自动清理',
            'auto_cleanup': True
        }
    except Exception as e:
        print(f"[错误] 删除临时目录失败: {str(e)}")
        return {'success': False, 'message': f'删除失败: {str(e)}'}
    
    return {'success': True, 'message': '临时目录不存在或已删除'}

def cleanup_old_staging_dirs(max_age_hours=1):
    """清理旧的临时staging目录
    
    Args:
        max_age_hours: 最大保留时间（小时），默认1小时
    """
    temp_base = tempfile.gettempdir()
    cleaned = 0
    
    try:
        for item in os.listdir(temp_base):
            if item.startswith('jojo_staging_'):
                staging_dir = os.path.join(temp_base, item)
                try:
                    # 检查目录修改时间（最后访问时间）
                    modify_time = os.path.getmtime(staging_dir)
                    age_hours = (time.time() - modify_time) / 3600
                    
                    if age_hours > max_age_hours:
                        shutil.rmtree(staging_dir)
                        cleaned += 1
                        print(f"[cleanup] 清理临时目录: {item} (最后修改: {age_hours:.1f} 小时前)")
                except PermissionError:
                    # 文件被占用，跳过
                    pass
                except Exception as e:
                    print(f"[cleanup warning] 清理失败 {item}: {str(e)}")
    except Exception as e:
        print(f"[cleanup warning] 扫描临时目录失败: {str(e)}")
    
    if cleaned > 0:
        print(f"[cleanup] 清理完成，共删除 {cleaned} 个临时目录")
    else:
        print(f"[cleanup] 没有需要清理的临时目录")
    
    return cleaned

def generate_vue_file(pub_code):
    """生成Vue文件"""
    pubs = load_config()
    pub_config = pubs[pub_code]
    vue_name = pub_config["vue_name"]
    pub_type = pub_config["type"]
    
    # 扫描年份和文件
    years_data = {}
    with processed_tree_for_scan(pub_code) as processed_path:
        if os.path.exists(processed_path):
            for year_folder in sorted(os.listdir(processed_path), reverse=True):
                year_path = os.path.join(processed_path, year_folder)
                if os.path.isdir(year_path):
                    files = sorted([f for f in os.listdir(year_path) if f.endswith('.pdf')])
                    if files:
                        years_data[year_folder] = files
    
    # 读取Vue模板
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    views_path = config['paths']['views']
    output_file = os.path.join(views_path, f"{vue_name.upper()}View.vue")
    
    # 生成Vue代码
    vue_code = f'''<template>
  <div class="publication-view">
    <h1>{pub_config["name"]}</h1>
    <div v-for="(files, year) in publicationData" :key="year" class="year-section">
      <h2>{{{{ year }}}}年</h2>
      <div class="files-grid">
        <div v-for="file in files" :key="file" class="file-item">
          <a :href="`/publications/{pub_code}/${{year}}/${{file}}`" target="_blank">
            {{{{ formatFileName(file) }}}}
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {{ ref }} from 'vue'

const publicationData = ref({json.dumps(years_data, ensure_ascii=False, indent=2)})

function formatFileName(filename) {{
  const name = filename.replace('.pdf', '')
  {'return name.replace(/(\\d{4})(\\d{2})(\\d{2})/, "$1年$2月$3日")' if pub_type == 'newspaper' else 'return name.replace(/(\\d{4})(\\d{2})/, "$1年第$2期")'}
}}
</script>

<style scoped>
.publication-view {{
  padding: 20px;
}}
.year-section {{
  margin-bottom: 30px;
}}
.files-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 15px;
}}
.file-item a {{
  display: block;
  padding: 10px;
  background: #f5f5f5;
  border-radius: 4px;
  text-decoration: none;
  color: #333;
}}
.file-item a:hover {{
  background: #e0e0e0;
}}
</style>
'''
    
    # 确保输出目录存在
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(vue_code)
    
    print(f"[generate] Vue文件已生成: {output_file}")
    
    return {
        'success': True,
        'file': output_file,
        'years': list(years_data.keys())
    }

# 保留旧函数以兼容

