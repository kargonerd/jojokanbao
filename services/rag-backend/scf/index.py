"""Tencent Cloud Function (SCF) entry point for NotebookLM API."""

import os
import sys
import json

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

# Set environment variables from SCF context
def init_env(context):
    """Initialize environment from SCF context."""
    # In SCF, we use environment variables for config
    # Admin password and notebook list should be set in SCF environment config
    pass


def main_handler(event, context):
    """Main handler for Tencent Cloud Function.
    
    Args:
        event: SCF event object containing request info
        context: SCF context object
        
    Returns:
        Response object for API Gateway
    """
    from app import app
    
    # Mark as serverless environment
    os.environ['SERVERLESS'] = 'true'
    
    # Extract function info from SCF context and set to environment
    # This allows admin.py to know which function to update
    if hasattr(context, 'function_name'):
        os.environ['TENCENT_FUNCTION_NAME'] = context.function_name
    if hasattr(context, 'namespace'):
        os.environ['TENCENT_NAMESPACE'] = context.namespace
    if hasattr(context, 'tencentcloud_region'):
        os.environ['TENCENT_REGION'] = context.tencentcloud_region
    
    # Also check if passed as dict (for testing)
    if isinstance(context, dict):
        if 'function_name' in context:
            os.environ['TENCENT_FUNCTION_NAME'] = context['function_name']
        if 'namespace' in context:
            os.environ['TENCENT_NAMESPACE'] = context['namespace']
        if 'tencentcloud_region' in context:
            os.environ['TENCENT_REGION'] = context['tencentcloud_region']
    
    # Build WSGI environ from SCF event
    environ = build_environ(event, context)
    
    # Create response object
    response_status = [None]
    response_headers = [None]
    
    def start_response(status, headers):
        response_status[0] = status
        response_headers[0] = headers
        
    # Call Flask app
    response_body = app(environ, start_response)
    
    # Build API Gateway response
    status_code = int(response_status[0].split(' ')[0])
    headers = dict(response_headers[0])
    
    # Handle binary responses
    body = b''.join(response_body)
    
    # Check if binary
    is_binary = False
    content_type = headers.get('Content-Type', '')
    if any(t in content_type for t in ['image/', 'audio/', 'video/', 'application/octet-stream']):
        is_binary = True
        
    if is_binary:
        import base64
        body = base64.b64encode(body).decode('utf-8')
        return {
            'isBase64Encoded': True,
            'statusCode': status_code,
            'headers': headers,
            'body': body
        }
    else:
        return {
            'isBase64Encoded': False,
            'statusCode': status_code,
            'headers': headers,
            'body': body.decode('utf-8') if isinstance(body, bytes) else body
        }


def build_environ(event, context):
    """Build WSGI environ from SCF event."""
    
    # Parse request
    http_method = event.get('httpMethod', 'GET')
    path = event.get('path', '/')
    query_string = event.get('queryString', '')
    headers = event.get('headers', {})
    body = event.get('body', '')
    
    # Handle base64 body
    if event.get('isBase64Encoded') and body:
        import base64
        body = base64.b64decode(body)
    elif body:
        body = body.encode('utf-8')
    else:
        body = b''
    
    # Build environ
    environ = {
        'REQUEST_METHOD': http_method,
        'SCRIPT_NAME': '',
        'PATH_INFO': path,
        'QUERY_STRING': query_string,
        'CONTENT_TYPE': headers.get('content-type', ''),
        'CONTENT_LENGTH': str(len(body)),
        'SERVER_NAME': headers.get('host', 'localhost'),
        'SERVER_PORT': '443',
        'SERVER_PROTOCOL': 'HTTP/1.1',
        'wsgi.version': (1, 0),
        'wsgi.url_scheme': headers.get('x-api-scheme', 'https'),
        'wsgi.input': io.BytesIO(body),
        'wsgi.errors': sys.stderr,
        'wsgi.multithread': False,
        'wsgi.multiprocess': False,
        'wsgi.run_once': False,
    }
    
    # Add headers
    for key, value in headers.items():
        key = key.upper().replace('-', '_')
        if key not in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
            key = 'HTTP_' + key
        environ[key] = value
    
    return environ


# Import io here for build_environ
import io


# For local testing
if __name__ == '__main__':
    # Test event
    test_event = {
        'httpMethod': 'GET',
        'path': '/',
        'queryString': '',
        'headers': {
            'host': 'localhost',
            'content-type': 'application/json'
        },
        'body': ''
    }
    test_context = {}
    result = main_handler(test_event, test_context)
    print(json.dumps(result, indent=2))
