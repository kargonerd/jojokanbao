"""
进度管理器 - 用于跟踪和推送处理进度
"""
import time
from threading import Lock

class ProgressManager:
    """全局进度管理器"""
    
    def __init__(self):
        self.tasks = {}  # {task_id: {status, current, total, current_file, errors}}
        self.lock = Lock()
    
    def create_task(self, task_id, total_files, total_pages, task_type='staging', unit_label='页'):
        """创建新任务"""
        with self.lock:
            self.tasks[task_id] = {
                'status': 'processing',
                'task_type': task_type,
                'unit_label': unit_label,
                'completed_files': 0,
                'total_files': total_files,
                'current_page': 0,
                'total_pages': total_pages,
                'processing_files': {},  # {file_index: {name, status, progress}}
                'errors': [],
                'start_time': time.time(),
                'cancelled': False  # 取消标志
            }
    
    def update(self, task_id, completed_files, current_page, processing_files):
        """更新进度"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['completed_files'] = completed_files
                self.tasks[task_id]['current_page'] = current_page
                self.tasks[task_id]['processing_files'] = processing_files.copy()
    
    def add_error(self, task_id, error):
        """添加错误"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['errors'].append(error)
    
    def complete(self, task_id):
        """完成任务"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['status'] = 'completed'
                self.tasks[task_id]['end_time'] = time.time()
    
    def set_result(self, task_id, result):
        """保存任务结果"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['results'] = result
    
    def fail(self, task_id, error):
        """任务失败"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['status'] = 'failed'
                self.tasks[task_id]['error'] = error
    
    def get_progress(self, task_id):
        """获取进度"""
        with self.lock:
            return self.tasks.get(task_id, None)
    
    def cancel(self, task_id):
        """取消任务"""
        with self.lock:
            if task_id in self.tasks:
                self.tasks[task_id]['cancelled'] = True
                self.tasks[task_id]['status'] = 'cancelled'
    
    def is_cancelled(self, task_id):
        """检查任务是否被取消"""
        with self.lock:
            if task_id in self.tasks:
                return self.tasks[task_id].get('cancelled', False)
            return False
    
    def cleanup(self, task_id):
        """清理任务"""
        with self.lock:
            if task_id in self.tasks:
                del self.tasks[task_id]

# 全局实例
progress_manager = ProgressManager()

