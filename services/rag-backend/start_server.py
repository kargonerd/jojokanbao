#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys

# Load .env file
def load_env():
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if not os.path.exists(env_path):
        print('Warning: .env file not found')
        return
    
    with open(env_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Simple parser that handles multi-line values
    lines = content.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]
        if '=' in line and not line.startswith(' '):
            key, value = line.split('=', 1)
            key = key.strip()
            # Check if next lines are continuation (for JSON values)
            j = i + 1
            while j < len(lines) and (lines[j].startswith(' ') or (lines[j] and not '=' in lines[j][:20])):
                value += '\n' + lines[j]
                j += 1
            os.environ[key] = value
            i = j
        else:
            i += 1
    
    print('Loaded .env')

load_env()

# Add scf to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'scf'))

# Import and run app
from scf.app import app

if __name__ == '__main__':
    print('Starting server on http://127.0.0.1:9002')
    print('Press Ctrl+C to stop')
    try:
        app.run(host='127.0.0.1', port=9002, debug=False, threaded=True)
    except KeyboardInterrupt:
        print('\nServer stopped')
