import os
import sys
import traceback

# Load .env - handle multi-line values
def load_env_file(filepath):
    """Load .env file, handling multi-line values."""
    if not os.path.exists(filepath):
        print('⚠️ .env 不存在')
        return
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Parse env vars, handling multi-line JSON values
    current_key = None
    current_value = []
    
    for line in content.split('\n'):
        if '=' in line and not line.startswith(' '):
            # Save previous key-value pair
            if current_key:
                os.environ[current_key] = '\n'.join(current_value)
            
            # Start new key-value pair
            key, value = line.split('=', 1)
            current_key = key.strip()
            current_value = [value]
        elif current_key:
            # Continue multi-line value
            current_value.append(line)
    
    # Save last key-value pair
    if current_key:
        os.environ[current_key] = '\n'.join(current_value)
    
    print('✅ 已加载 .env')

load_env_file('.env')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'scf'))

# 动态挂载本地的 notebooklm-py 源码（覆盖 pip 安装版本），实现零摩擦随时调试
local_notebooklm = os.path.join(os.path.dirname(__file__), 'notebooklm-py', 'src')
if os.path.exists(local_notebooklm):
    sys.path.insert(0, local_notebooklm)
    print('📦 [Dev Mode] 已优先挂载本地 notebooklm-py 源码目录，支持直接修改并热生效！')

try:
    from scf.app import app
except Exception as e:
    print(f'❌ 导入 app 失败: {e}')
    traceback.print_exc()
    sys.exit(1)

if __name__ == '__main__':
    print('Starting NotebookLM API server on http://127.0.0.1:9002')
    print('Press Ctrl+C to stop')
    try:
        app.run(host='127.0.0.1', port=9002, debug=True, use_reloader=False)
    except Exception as e:
        print(f'❌ 启动失败: {e}')
        traceback.print_exc()
