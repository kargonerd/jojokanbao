"""Admin API for managing notebooks and authentication."""

import os
import json
import hashlib
import asyncio
import time
from datetime import datetime, timedelta
from functools import wraps
from flask import Blueprint, request, jsonify

try:
    from notebook_service import parse_cookie_value
    from notebooklm import AuthTokens, NotebookLMClient
    from notebooklm.auth import fetch_tokens
except ImportError:  # pragma: no cover
    from scf.notebook_service import parse_cookie_value
    from notebooklm import AuthTokens, NotebookLMClient
    from notebooklm.auth import fetch_tokens

# Admin blueprint
admin_bp = Blueprint('admin', __name__, url_prefix='/admin')

# Config keys
ADMIN_PASSWORD_KEY = 'ADMIN_PASSWORD'
ADMIN_PASSWORD_HASH_KEY = 'ADMIN_PASSWORD_HASH'
ADMIN_PASSWORD_SALT_KEY = 'ADMIN_PASSWORD_SALT'
SETUP_COMPLETED_KEY = 'SETUP_COMPLETED'

# Migration keys (kept for compat)
ACCOUNTS_KEY = 'GOOGLE_ACCOUNTS'
SELECTED_NOTEBOOKS_KEY = 'SELECTED_NOTEBOOKS'

# Token expiration time (24 hours)
TOKEN_EXPIRY_HOURS = 24

# Login attempt tracking
login_attempts = {}  # {ip: [(timestamp, count), ...]}
MAX_LOGIN_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 300  # 5 minutes
LOCKOUT_DURATION_SECONDS = 900  # 15 minutes


def get_env(key, default=None):
    """Get environment variable."""
    return os.environ.get(key, default)


def set_env(key, value):
    """Set environment variable (in-memory for SCF, also save to .env for local dev)."""
    os.environ[key] = value

    # Also save to .env file for local development
    # Skip for SCF environment
    if get_env('SERVERLESS') != 'true':
        try:
            env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')

            # Read existing .env content
            env_vars = {}
            if os.path.exists(env_path):
                with open(env_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if '=' in line:
                            k, v = line.strip().split('=', 1)
                            env_vars[k] = v

            # Update the key
            env_vars[key] = value

            # Write back
            with open(env_path, 'w', encoding='utf-8') as f:
                for k, v in env_vars.items():
                    f.write(f'{k}={v}\n')
        except Exception as e:
            print(f"[set_env] Failed to save to .env: {e}")


def hash_password(password, salt=None):
    """Hash password with salt using PBKDF2."""
    if salt is None:
        salt = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    # Use PBKDF2 with 100000 iterations
    pwdhash = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
    return pwdhash.hex(), salt


def verify_password(password, stored_hash, salt):
    """Verify password against split hash + salt."""
    pwdhash, _ = hash_password(password, salt)
    return pwdhash == stored_hash


def verify_legacy_password(stored, provided):
    """Verify password against legacy combined salt+hash format."""
    if not stored or not provided or len(stored) <= 32:
        return False
    salt = stored[:32]
    stored_hash = stored[32:]
    pwdhash = hashlib.pbkdf2_hmac('sha256', provided.encode(), salt.encode(), 100000)
    return pwdhash.hex() == stored_hash


def has_admin_password():
    """Return whether any supported admin password format is configured."""
    return bool(get_env(ADMIN_PASSWORD_KEY) or get_env(ADMIN_PASSWORD_HASH_KEY))


def get_token_secret():
    """Return secret material for signing admin tokens."""
    plain_password = get_env(ADMIN_PASSWORD_KEY)
    if plain_password:
        return plain_password

    stored_hash = get_env(ADMIN_PASSWORD_HASH_KEY, '')
    stored_salt = get_env(ADMIN_PASSWORD_SALT_KEY, '')
    if stored_hash and stored_salt:
        return f'{stored_salt}:{stored_hash}'
    return stored_hash


def verify_admin_password(password):
    """Verify password across plain-text and historical hash formats."""
    plain_password = get_env(ADMIN_PASSWORD_KEY)
    if plain_password:
        return password == plain_password

    stored_hash = get_env(ADMIN_PASSWORD_HASH_KEY)
    stored_salt = get_env(ADMIN_PASSWORD_SALT_KEY)

    if stored_hash and stored_salt:
        return verify_password(password, stored_hash, stored_salt)

    if stored_hash:
        return verify_legacy_password(stored_hash, password)

    return False


def generate_token():
    """Generate admin session token with timestamp."""
    timestamp = str(int(time.time()))
    secret = get_token_secret()
    token_data = f"{secret}:{timestamp}"
    token_hash = hashlib.sha256(token_data.encode()).hexdigest()[:32]
    return f"{token_hash}:{timestamp}"


def verify_token(token):
    """Verify token and check expiration."""
    try:
        token_hash, timestamp = token.split(':')
        timestamp = int(timestamp)
        
        # Check expiration
        current_time = int(time.time())
        if current_time - timestamp > TOKEN_EXPIRY_HOURS * 3600:
            return False, 'Token expired'
        
        # Verify token hash
        secret = get_token_secret()
        expected_data = f"{secret}:{timestamp}"
        expected_hash = hashlib.sha256(expected_data.encode()).hexdigest()[:32]
        
        if token_hash != expected_hash:
            return False, 'Invalid token'
        
        return True, None
    except (ValueError, IndexError):
        return False, 'Invalid token format'


def check_login_attempts(client_ip):
    """Check if IP is locked out due to failed login attempts."""
    current_time = time.time()
    
    if client_ip in login_attempts:
        attempts = login_attempts[client_ip]
        # Clean old attempts outside the window
        attempts = [(t, c) for t, c in attempts if current_time - t < LOGIN_WINDOW_SECONDS]
        login_attempts[client_ip] = attempts
        
        # Check if currently locked out
        if attempts:
            last_attempt_time, count = attempts[-1]
            if count >= MAX_LOGIN_ATTEMPTS:
                if current_time - last_attempt_time < LOCKOUT_DURATION_SECONDS:
                    remaining = int(LOCKOUT_DURATION_SECONDS - (current_time - last_attempt_time))
                    return False, f'Too many failed attempts. Please try again in {remaining} seconds.'
                else:
                    # Lockout period expired, reset
                    login_attempts[client_ip] = []
    
    return True, None


def record_login_attempt(client_ip, success):
    """Record a login attempt."""
    current_time = time.time()
    
    if client_ip not in login_attempts:
        login_attempts[client_ip] = []
    
    if success:
        # Clear attempts on success
        login_attempts[client_ip] = []
    else:
        # Add failed attempt
        attempts = login_attempts[client_ip]
        if attempts and current_time - attempts[-1][0] < LOGIN_WINDOW_SECONDS:
            # Increment count within window
            attempts[-1] = (attempts[-1][0], attempts[-1][1] + 1)
        else:
            # New attempt window
            attempts.append((current_time, 1))
        login_attempts[client_ip] = attempts


def require_auth(f):
    """Decorator to require admin authentication."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify(success=False, error='Unauthorized'), 401

        token = auth_header[7:]
        is_valid, error = verify_token(token)
        
        if not is_valid:
            return jsonify(success=False, error=error or 'Invalid token'), 401

        return f(*args, **kwargs)
    return decorated


def is_setup_completed():
    """Check if initial setup (password) is completed."""
    return bool(get_env(SETUP_COMPLETED_KEY)) and has_admin_password()


def run_async(coro):
    """Run async coroutine."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


async def fetch_account_notebooks(cookie_value: str):
    cookies = parse_cookie_value(cookie_value)
    if not cookies:
        raise ValueError('Invalid cookie payload')
    csrf_token, session_id = await fetch_tokens(cookies)
    auth = AuthTokens(cookies=cookies, csrf_token=csrf_token, session_id=session_id)
    async with NotebookLMClient(auth) as client:
        notebooks = await client.notebooks.list()
        return [{'id': nb.id, 'title': nb.title} for nb in notebooks]


@admin_bp.route('/check', methods=['GET'])
def check_setup():
    """Check setup status.
    
    Returns:
        - setup_completed: bool
        - need_password: bool (if no admin password set)
    """
    completed = is_setup_completed()
    return jsonify(
        setup_completed=completed,
        need_password=not completed
    )


@admin_bp.route('/setup/password', methods=['POST'])
def setup_password():
    """Initial setup: set admin password.
    
    Request body:
        - password: New admin password
    
    Returns:
        - success: bool
        - token: Admin session token (if success)
    """
    # Check if already set up
    if is_setup_completed():
        return jsonify(success=False, error='Already configured'), 400
    
    data = request.get_json()
    password = data.get('password')
    
    if not password or len(password) < 6:
        return jsonify(success=False, error='Password must be at least 6 characters'), 400
    
    # Local admin now uses plain password config for compatibility.
    set_env(ADMIN_PASSWORD_KEY, password)
    set_env(ADMIN_PASSWORD_HASH_KEY, '')
    set_env(ADMIN_PASSWORD_SALT_KEY, '')
    set_env(SETUP_COMPLETED_KEY, 'true')
    
    # Generate token
    token = generate_token()
    
    return jsonify(
        success=True,
        message='Setup completed successfully',
        token=token
    )


@admin_bp.route('/login', methods=['POST'])
def login():
    """Admin login with rate limiting."""
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    if client_ip and ',' in client_ip:
        client_ip = client_ip.split(',')[0].strip()
    
    # Check login attempts
    allowed, error = check_login_attempts(client_ip)
    if not allowed:
        return jsonify(success=False, error=error), 429
    
    data = request.get_json()
    password = data.get('password')
    
    if not has_admin_password():
        return jsonify(success=False, error='Admin not configured', need_setup=True), 400
    
    # Verify password
    if not verify_admin_password(password):
        record_login_attempt(client_ip, False)
        remaining_attempts = MAX_LOGIN_ATTEMPTS - login_attempts.get(client_ip, [(-1, 0)])[-1][1]
        return jsonify(
            success=False, 
            error='Invalid password',
            remaining_attempts=max(0, remaining_attempts)
        ), 401
    
    # Success - clear attempts and generate token
    record_login_attempt(client_ip, True)
    token = generate_token()
    
    return jsonify(
        success=True, 
        token=token,
        expires_in=TOKEN_EXPIRY_HOURS * 3600
    )


def _get_db():
    """Get database managers (lazy import to avoid circular deps)."""
    try:
        from database import AccountManager, SelectedNotebookManager
    except ImportError:
        from scf.database import AccountManager, SelectedNotebookManager
    return AccountManager, SelectedNotebookManager


def _migrate_env_to_db():
    """One-time migration: move accounts/selected_notebooks from env vars to SQLite."""
    AccountManager, SelectedNotebookManager = _get_db()
    # Check if DB already has data
    if AccountManager.get_all():
        return
    # Migrate accounts from env
    accounts_json = get_env(ACCOUNTS_KEY, '[]')
    try:
        accounts = json.loads(accounts_json)
        if accounts:
            for acc in accounts:
                AccountManager.add(
                    name=acc.get('name', ''),
                    cookie=acc.get('cookie', ''),
                    notebooks=acc.get('notebooks', []),
                    expires_at=acc.get('expires_at')
                )
            print(f"[Migration] Migrated {len(accounts)} accounts to SQLite")
    except Exception as e:
        print(f"[Migration] Failed to migrate accounts: {e}")

    # Migrate selected notebooks from env
    selected_json = get_env(SELECTED_NOTEBOOKS_KEY, '[]')
    try:
        selected = json.loads(selected_json)
        if selected:
            SelectedNotebookManager.save_all(selected)
            print(f"[Migration] Migrated {len(selected)} selected notebooks to SQLite")
    except Exception as e:
        print(f"[Migration] Failed to migrate selected notebooks: {e}")


def get_accounts(include_cookie: bool = True):
    """Get all accounts with notebooks from database."""
    _migrate_env_to_db()
    AccountManager, _ = _get_db()
    accounts = AccountManager.get_all()
    result = []
    for acc in accounts:
        item = {
            'id': acc['id'],
            'name': acc['name'],
            'notebooks': json.loads(acc['notebooks']) if isinstance(acc['notebooks'], str) else acc['notebooks'],
            'expires_at': acc.get('expires_at'),
            'added_at': acc.get('added_at'),
        }
        if include_cookie:
            item['cookie'] = acc['cookie']
        result.append(item)
    return result


def get_selected_notebooks():
    """Get selected notebooks from database."""
    _migrate_env_to_db()
    _, SelectedNotebookManager = _get_db()
    return SelectedNotebookManager.get_all()


@admin_bp.route('/config', methods=['GET'])
@require_auth
def get_config_v2():
    """Get configuration (v2 - account-based).

    Returns:
        - accounts: List of Google accounts with their notebooks
        - selected_notebooks: List of notebooks selected for display
    """
    accounts = get_accounts()
    selected = get_selected_notebooks()

    return jsonify(
        success=True,
        accounts=get_accounts(include_cookie=False),
        selected_notebooks=selected
    )


@admin_bp.route('/accounts', methods=['POST'])
@require_auth
def add_account():
    """Add a new Google account and fetch its notebooks.

    Request body:
        - name: Account name (e.g., "工作号")
        - cookie: NotebookLM cookie string

    Returns:
        - accounts: Updated accounts list
        - notebooks_count: Number of notebooks fetched
    """
    data = request.get_json()
    name = data.get('name', '').strip()
    cookie = data.get('cookie', '').strip()

    if not name or not cookie:
        return jsonify(success=False, error='Name and cookie are required'), 400

    try:
        notebooks = run_async(fetch_account_notebooks(cookie))

        # Save to database
        AccountManager, _ = _get_db()
        AccountManager.add(
            name=name,
            cookie=cookie,
            notebooks=notebooks,
            expires_at=None  # TODO: extract from cookie
        )

        return jsonify(
            success=True,
            accounts=get_accounts(include_cookie=False),
            notebooks_count=len(notebooks)
        )

    except Exception as e:
        print(f"[Admin] Failed to add account: {e}")
        return jsonify(success=False, error=f'Failed to fetch notebooks: {str(e)}'), 500


@admin_bp.route('/accounts/<int:account_id>', methods=['DELETE'])
@require_auth
def delete_account(account_id):
    """Delete a Google account."""
    try:
        AccountManager, _ = _get_db()
        account = AccountManager.get_by_id(account_id)
        if not account:
            return jsonify(success=False, error='Account not found'), 404

        AccountManager.delete(account_id)

        return jsonify(
            success=True,
            accounts=get_accounts(include_cookie=False)
        )
    except Exception as e:
        print(f"[Admin] Failed to delete account: {e}")
        return jsonify(success=False, error=str(e)), 500


@admin_bp.route('/accounts/<int:account_id>/refresh', methods=['POST'])
@require_auth
def refresh_account(account_id):
    """Refresh notebooks for a specific account."""
    try:
        AccountManager, _ = _get_db()
        account = AccountManager.get_by_id(account_id)
        if not account:
            return jsonify(success=False, error='Account not found'), 404
        notebooks = run_async(fetch_account_notebooks(account['cookie']))

        # Update database
        AccountManager.update(
            account_id=account['id'],
            notebooks=notebooks
        )

        return jsonify(
            success=True,
            accounts=get_accounts(include_cookie=False),
            notebooks_count=len(notebooks)
        )

    except Exception as e:
        print(f"[Admin] Failed to refresh account: {e}")
        return jsonify(success=False, error=str(e)), 500


@admin_bp.route('/selected-notebooks', methods=['PUT'])
@require_auth
def update_selected_notebooks():
    """Update selected notebooks list."""
    data = request.get_json()
    selected = data.get('selected', [])

    try:
        _, SelectedNotebookManager = _get_db()
        SelectedNotebookManager.save_all(selected)
        return jsonify(success=True, selected_notebooks=selected)
    except Exception as e:
        print(f"[Admin] Failed to update selected notebooks: {e}")
        return jsonify(success=False, error=str(e)), 500


@admin_bp.route('/public/notebooks', methods=['GET'])
def get_public_notebooks():
    """Get public notebooks list (for display on home page)."""
    try:
        selected = get_selected_notebooks()
        return jsonify(notebooks=selected)
    except Exception as e:
        print(f"[Admin] Failed to get public notebooks: {e}")
        return jsonify(notebooks=[])
