#!/usr/bin/env python3
import os
import sys

# Load .env file - support both simple and JSON values
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(script_dir, '.env')
print(f'[DEBUG] Looking for .env at: {env_path}')
print(f'[DEBUG] .env exists: {os.path.exists(env_path)}')
if os.path.exists(env_path):
    with open(env_path, 'r', encoding='utf-8') as f:
        content = f.read()
        # Parse env vars, handling multi-line JSON values
        i = 0
        while i < len(content):
            line_start = i
            # Find end of line
            while i < len(content) and content[i] != '\n':
                i += 1
            line = content[line_start:i].strip()
            i += 1  # Skip newline
            
            if not line or line.startswith('#'):
                continue
                
            if '=' in line:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip()
                
                # Handle JSON array/object values that might span multiple lines
                if value.startswith('[') or value.startswith('{'):
                    # Count braces to find complete JSON
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
                                    # Found complete JSON
                                    value = content[json_start:j+1].strip()
                                    i = j + 1
                                    break
                        else:
                            if c == string_char and content[j-1] != '\\':
                                in_string = False
                        j += 1
                
                os.environ[key] = value
    print('Loaded .env (full mode)')
    # Debug: Print key env vars
    selected_loaded = 'SELECTED_NOTEBOOKS' in os.environ
    accounts_loaded = 'GOOGLE_ACCOUNTS' in os.environ
    print(f'[DEBUG] SELECTED_NOTEBOOKS loaded: {selected_loaded}')
    print(f'[DEBUG] GOOGLE_ACCOUNTS loaded: {accounts_loaded}')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'scf'))

from scf.app import app
from scf.admin import get_selected_notebooks

# Debug: Check env vars after import
selected_in_env = 'SELECTED_NOTEBOOKS' in os.environ
print(f'[DEBUG] After import - SELECTED_NOTEBOOKS: {selected_in_env}')
print(f'[DEBUG] get_selected_notebooks(): {get_selected_notebooks()}')

# Print all routes for debugging
print('\nRegistered routes:')
for rule in app.url_map.iter_rules():
    if 'library' in rule.rule or 'api' in rule.rule:
        print(f'  {rule.rule}')
print()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 9002))
    print(f'Starting on http://127.0.0.1:{port}')
    app.run(host='127.0.0.1', port=port, debug=False)
