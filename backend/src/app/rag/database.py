"""SQLite database manager for user data and reading progress."""

import os
import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List
from contextlib import contextmanager


SOURCE_PROFILE_JSON_COLUMNS = {
    'asset_manifest_json': '[]',
    'package_manifest_json': '{}',
    'toc_json': '[]',
    'chapters_json': '[]',
    'annotations_json': '[]',
    'reader_config_json': '{}',
}

# Prototype state remains local until this module moves to Supabase.
BACKEND_ROOT = Path(__file__).resolve().parents[3]
DB_PATH = os.environ.get(
    'RAG_DB_PATH',
    str(BACKEND_ROOT / '.runtime' / 'rag' / 'app.db'),
)

# Ensure data directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


def init_db():
    """Initialize database with tables."""
    with get_db() as db:
        # Reading progress table
        db.execute('''
            CREATE TABLE IF NOT EXISTS reading_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                book_id TEXT NOT NULL,
                scroll_position INTEGER DEFAULT 0,
                chapter_id TEXT,
                last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, book_id)
            )
        ''')
        
        # Reading history table
        db.execute('''
            CREATE TABLE IF NOT EXISTS reading_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                book_id TEXT NOT NULL,
                book_title TEXT,
                library_id TEXT,
                library_name TEXT,
                read_count INTEGER DEFAULT 1,
                last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, book_id)
            )
        ''')
        
        # Bookmarks table
        db.execute('''
            CREATE TABLE IF NOT EXISTS bookmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                book_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, book_id, position)
            )
        ''')
        
        # Species names table for anonymous nicknames
        db.execute('''
            CREATE TABLE IF NOT EXISTS species_names (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                is_used BOOLEAN DEFAULT FALSE,
                assigned_to TEXT,
                assigned_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Admin: Google accounts (NotebookLM cookie accounts)
        db.execute('''
            CREATE TABLE IF NOT EXISTS admin_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                cookie TEXT NOT NULL,
                notebooks_json TEXT DEFAULT '[]',
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Admin: Selected notebooks for display
        db.execute('''
            CREATE TABLE IF NOT EXISTS selected_notebooks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                notebook_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                account_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Published notebook profiles shown to users.
        # notebook_id maps 1:1 to a NotebookLM notebook.
        db.execute('''
            CREATE TABLE IF NOT EXISTS notebook_profiles (
                notebook_id TEXT PRIMARY KEY,
                account_name TEXT NOT NULL,
                notebook_title TEXT NOT NULL,
                display_title TEXT DEFAULT '',
                description TEXT DEFAULT '',
                cover_url TEXT DEFAULT '',
                is_published BOOLEAN DEFAULT FALSE,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Source-level metadata and bound document assets.
        db.execute('''
            CREATE TABLE IF NOT EXISTS source_profiles (
                notebook_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_title TEXT NOT NULL,
                display_title TEXT DEFAULT '',
                description TEXT DEFAULT '',
                cover_url TEXT DEFAULT '',
                markdown_url TEXT DEFAULT '',
                markdown_key TEXT DEFAULT '',
                pdf_url TEXT DEFAULT '',
                pdf_key TEXT DEFAULT '',
                source_kind TEXT DEFAULT '',
                source_url TEXT DEFAULT '',
                asset_manifest_json TEXT DEFAULT '[]',
                package_manifest_json TEXT DEFAULT '{}',
                toc_json TEXT DEFAULT '[]',
                chapters_json TEXT DEFAULT '[]',
                annotations_json TEXT DEFAULT '[]',
                reader_config_json TEXT DEFAULT '{}',
                document_status TEXT DEFAULT 'missing',
                is_published BOOLEAN DEFAULT FALSE,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (notebook_id, source_id)
            )
        ''')

        existing_source_profile_columns = {
            row['name'] for row in db.execute("PRAGMA table_info(source_profiles)").fetchall()
        }
        for column, default in SOURCE_PROFILE_JSON_COLUMNS.items():
            if column in existing_source_profile_columns:
                continue
            db.execute(
                f"ALTER TABLE source_profiles ADD COLUMN {column} TEXT DEFAULT '{default}'"
            )

        # Cached source-scoped analysis responses.
        db.execute('''
            CREATE TABLE IF NOT EXISTS analysis_cache (
                notebook_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                analysis_type TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                response_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (notebook_id, source_id, analysis_type, cache_key)
            )
        ''')

        # Libraries
        db.execute('''
            CREATE TABLE IF NOT EXISTS libraries (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                cover_url TEXT DEFAULT '',
                notebooklm_id TEXT DEFAULT '',
                book_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Books
        db.execute('''
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY,
                library_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT DEFAULT '',
                description TEXT DEFAULT '',
                cover_url TEXT DEFAULT '',
                file_url TEXT DEFAULT '',
                file_type TEXT DEFAULT 'markdown',
                file_size INTEGER DEFAULT 0,
                page_count INTEGER DEFAULT 0,
                source_id TEXT DEFAULT '',
                compare_result_json TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (library_id) REFERENCES libraries(id)
            )
        ''')
        
        db.commit()
        print(f"[Database] Initialized at {DB_PATH}")
        
        # Load species names if table is empty
        load_species_names_to_db(db)


@contextmanager
def get_db():
    """Get database connection context manager."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


class ReadingProgressManager:
    """Manager for reading progress operations."""
    
    @staticmethod
    def save_progress(user_id: str, book_id: str, scroll_position: int = 0, 
                      chapter_id: str = None) -> bool:
        """Save or update reading progress."""
        try:
            with get_db() as db:
                db.execute('''
                    INSERT INTO reading_progress 
                        (user_id, book_id, scroll_position, chapter_id, last_read_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(user_id, book_id) DO UPDATE SET
                        scroll_position = excluded.scroll_position,
                        chapter_id = excluded.chapter_id,
                        last_read_at = excluded.last_read_at
                ''', (user_id, book_id, scroll_position, chapter_id, datetime.now()))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving progress: {e}")
            return False
    
    @staticmethod
    def get_progress(user_id: str, book_id: str) -> Optional[Dict[str, Any]]:
        """Get reading progress for a book."""
        try:
            with get_db() as db:
                row = db.execute('''
                    SELECT * FROM reading_progress 
                    WHERE user_id = ? AND book_id = ?
                ''', (user_id, book_id)).fetchone()
                
                if row:
                    return {
                        'book_id': row['book_id'],
                        'scroll_position': row['scroll_position'],
                        'chapter_id': row['chapter_id'],
                        'last_read_at': row['last_read_at'],
                        'created_at': row['created_at']
                    }
                return None
        except Exception as e:
            print(f"[Database] Error getting progress: {e}")
            return None
    
    @staticmethod
    def get_all_progress(user_id: str) -> List[Dict[str, Any]]:
        """Get all reading progress for a user."""
        try:
            with get_db() as db:
                rows = db.execute('''
                    SELECT * FROM reading_progress 
                    WHERE user_id = ?
                    ORDER BY last_read_at DESC
                ''', (user_id,)).fetchall()
                
                return [{
                    'book_id': row['book_id'],
                    'scroll_position': row['scroll_position'],
                    'chapter_id': row['chapter_id'],
                    'last_read_at': row['last_read_at'],
                    'created_at': row['created_at']
                } for row in rows]
        except Exception as e:
            print(f"[Database] Error getting all progress: {e}")
            return []


class ReadingHistoryManager:
    """Manager for reading history operations."""
    
    @staticmethod
    def add_history(user_id: str, book_id: str, book_title: str = None,
                    library_id: str = None, library_name: str = None) -> bool:
        """Add or update reading history entry."""
        try:
            with get_db() as db:
                db.execute('''
                    INSERT INTO reading_history 
                        (user_id, book_id, book_title, library_id, library_name, 
                         read_count, last_read_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?)
                    ON CONFLICT(user_id, book_id) DO UPDATE SET
                        read_count = read_count + 1,
                        book_title = excluded.book_title,
                        library_id = excluded.library_id,
                        library_name = excluded.library_name,
                        last_read_at = excluded.last_read_at
                ''', (user_id, book_id, book_title, library_id, library_name, datetime.now()))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error adding history: {e}")
            return False
    
    @staticmethod
    def get_history(user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Get reading history for a user."""
        try:
            with get_db() as db:
                rows = db.execute('''
                    SELECT * FROM reading_history 
                    WHERE user_id = ?
                    ORDER BY last_read_at DESC
                    LIMIT ?
                ''', (user_id, limit)).fetchall()
                
                return [{
                    'book_id': row['book_id'],
                    'book_title': row['book_title'],
                    'library_id': row['library_id'],
                    'library_name': row['library_name'],
                    'read_count': row['read_count'],
                    'last_read_at': row['last_read_at'],
                    'created_at': row['created_at']
                } for row in rows]
        except Exception as e:
            print(f"[Database] Error getting history: {e}")
            return []


class BookmarkManager:
    """Manager for bookmark operations."""
    
    @staticmethod
    def add_bookmark(user_id: str, book_id: str, position: int, 
                     note: str = None) -> bool:
        """Add a bookmark."""
        try:
            with get_db() as db:
                db.execute('''
                    INSERT INTO bookmarks (user_id, book_id, position, note)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(user_id, book_id, position) DO UPDATE SET
                        note = excluded.note
                ''', (user_id, book_id, position, note))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error adding bookmark: {e}")
            return False
    
    @staticmethod
    def get_bookmarks(user_id: str, book_id: str) -> List[Dict[str, Any]]:
        """Get bookmarks for a book."""
        try:
            with get_db() as db:
                rows = db.execute('''
                    SELECT * FROM bookmarks 
                    WHERE user_id = ? AND book_id = ?
                    ORDER BY position ASC
                ''', (user_id, book_id)).fetchall()
                
                return [{
                    'id': row['id'],
                    'position': row['position'],
                    'note': row['note'],
                    'created_at': row['created_at']
                } for row in rows]
        except Exception as e:
            print(f"[Database] Error getting bookmarks: {e}")
            return []
    
    @staticmethod
    def delete_bookmark(user_id: str, bookmark_id: int) -> bool:
        """Delete a bookmark."""
        try:
            with get_db() as db:
                db.execute('''
                    DELETE FROM bookmarks 
                    WHERE id = ? AND user_id = ?
                ''', (bookmark_id, user_id))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error deleting bookmark: {e}")
            return False


# Species names data (embedded in code, no external JSON file needed)
SPECIES_NAMES_LIST = [
    "大熊猫", "金丝猴", "东北虎", "雪豹", "藏羚羊", "朱鹮", "丹顶鹤", "扬子鳄", "白鳍豚", "亚洲象",
    "华南虎", "麋鹿", "孔雀", "天鹅", "企鹅", "海豚", "蓝鲸", "海豹", "海狮", "海象",
    "北极熊", "棕熊", "黑熊", "灰狼", "赤狐", "猞猁", "豹猫", "野猪", "梅花鹿", "马鹿",
    "驯鹿", "羚羊", "岩羊", "盘羊", "黄羊", "旱獭", "松鼠", "花栗鼠", "刺猬", "蝙蝠",
    "穿山甲", "犰狳", "树懒", "食蚁兽", "鸭嘴兽", "袋鼠", "考拉", "袋熊", "袋獾", "鸸鹋",
    "鸵鸟", "几维鸟", "蜂鸟", "鹦鹉", "八哥", "画眉", "百灵", "黄鹂", "杜鹃", "啄木鸟",
    "猫头鹰", "老鹰", "秃鹫", "金雕", "游隼", "白鹭", "苍鹭", "鹈鹕", "海鸥", "信天翁",
    "军舰鸟", "火烈鸟", "锦鸡", "白鹇", "蟒蛇", "眼镜蛇", "金环蛇", "银环蛇", "竹叶青", "五步蛇",
    "蝮蛇", "蜥蜴", "壁虎", "变色龙", "鬣蜥", "巨蜥", "鳄鱼", "短吻鳄", "乌龟", "甲鱼",
    "玳瑁", "绿海龟", "陆龟", "蟾蜍", "青蛙", "树蛙", "娃娃鱼", "大鲵", "蝾螈", "中华鲟",
    "白鲟", "大白鲨", "鲸鲨", "江豚", "儒艮", "银杏", "水杉", "银杉", "秃杉", "红豆杉",
    "台湾杉", "望天树", "珙桐", "光叶珙桐", "桫椤", "人参", "三七", "天麻", "冬虫夏草", "雪莲",
    "红景天", "石斛", "灵芝", "茯苓", "何首乌", "黄连", "牡丹", "芍药", "梅花", "兰花",
    "菊花", "竹子", "松树", "柏树", "梧桐", "杨柳", "桃树", "李树", "梨树", "杏树",
    "柿树", "枣树", "柑橘", "柚子", "橙子", "柠檬", "荔枝", "龙眼", "芒果", "香蕉",
    "菠萝", "椰子", "槟榔", "棕榈", "橡胶树", "茶树", "咖啡树", "可可树", "胡椒", "肉桂",
    "丁香", "八角", "花椒", "薄荷", "罗勒", "迷迭香", "薰衣草", "玫瑰", "月季", "蔷薇",
    "海棠", "樱花", "杜鹃", "山茶", "栀子", "茉莉", "桂花", "荷花", "睡莲", "芦苇",
    "菖蒲", "香菇", "平菇", "金针菇", "杏鲍菇", "木耳", "银耳", "猴头菇", "竹荪", "牛肝菌",
    "松茸", "鸡枞", "羊肚菌", "珊瑚", "海葵", "水母", "海星", "海胆", "海参", "海百合",
    "鹦鹉螺", "章鱼", "乌贼", "鱿鱼", "鲍鱼", "海螺", "扇贝", "牡蛎", "蛤蜊", "蛏子",
    "蚶子", "贻贝", "珍珠贝", "砗磲", "蝴蝶", "蜻蜓", "蜜蜂", "蚂蚁", "螳螂", "蝉",
    "萤火虫", "瓢虫", "金龟子", "天牛", "独角仙", "锹甲", "竹节虫", "蝗虫", "蟋蟀", "蝈蝈",
    "纺织娘", "知了", "蚕", "蚯蚓", "蜗牛", "蛞蝓", "蚂蟥", "水蛭", "蜘蛛", "蝎子",
    "蜈蚣", "马陆", "蚰蜒", "蜱虫", "螨虫", "跳蚤", "虱子", "蟑螂", "白蚁"
]


def load_species_names_to_db(db):
    """Load species names into database if table is empty."""
    try:
        count = db.execute('SELECT COUNT(*) FROM species_names').fetchone()[0]
        if count == 0:
            print(f"[Database] Loading {len(SPECIES_NAMES_LIST)} species names...")
            for name in SPECIES_NAMES_LIST:
                try:
                    db.execute('INSERT INTO species_names (name) VALUES (?)', (name,))
                except sqlite3.IntegrityError:
                    pass  # Skip duplicates
            db.commit()
            print(f"[Database] Loaded {len(SPECIES_NAMES_LIST)} species names")
    except Exception as e:
        print(f"[Database] Error loading species names: {e}")


class SpeciesNameManager:
    """Manager for species name assignments."""
    
    @staticmethod
    def get_or_assign_name(device_id: str) -> Optional[str]:
        """Get existing assigned name or assign a new one."""
        try:
            with get_db() as db:
                # Check if device already has a name assigned
                row = db.execute('''
                    SELECT name FROM species_names 
                    WHERE assigned_to = ?
                ''', (device_id,)).fetchone()
                
                if row:
                    return row['name']
                
                # Find an unused name using hash for consistency
                hash_val = 0
                for char in device_id:
                    hash_val = ((hash_val << 5) - hash_val) + ord(char)
                    hash_val = hash_val & 0xFFFFFFFF
                
                # Get total count
                total = db.execute('SELECT COUNT(*) FROM species_names').fetchone()[0]
                if total == 0:
                    return None
                
                # Try to find unused name starting from hash position
                start_idx = abs(hash_val) % total
                for i in range(total):
                    idx = (start_idx + i) % total
                    row = db.execute('''
                        SELECT name FROM species_names 
                        WHERE id = (SELECT id FROM species_names LIMIT 1 OFFSET ?)
                        AND is_used = FALSE
                    ''', (idx,)).fetchone()
                    
                    if row:
                        name = row['name']
                        # Mark as used
                        db.execute('''
                            UPDATE species_names 
                            SET is_used = TRUE, assigned_to = ?, assigned_at = ?
                            WHERE name = ?
                        ''', (device_id, datetime.now(), name))
                        db.commit()
                        return name
                
                # All names used, assign with suffix
                import random
                name = random.choice(SPECIES_NAMES_LIST)
                suffix = random.randint(1, 999)
                return f"{name}{suffix}"
                
        except Exception as e:
            print(f"[Database] Error getting/assigning species name: {e}")
            return None
    
    @staticmethod
    def mark_name_used(name: str, device_id: str = None) -> bool:
        """Mark a species name as used."""
        try:
            with get_db() as db:
                db.execute('''
                    UPDATE species_names 
                    SET is_used = TRUE, assigned_to = ?, assigned_at = ?
                    WHERE name = ? AND is_used = FALSE
                ''', (device_id, datetime.now(), name))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error marking name as used: {e}")
            return False
    
    @staticmethod
    def get_stats() -> Dict[str, int]:
        """Get species name usage statistics."""
        try:
            with get_db() as db:
                total = db.execute('SELECT COUNT(*) FROM species_names').fetchone()[0]
                used = db.execute('SELECT COUNT(*) FROM species_names WHERE is_used = TRUE').fetchone()[0]
                return {'total': total, 'used': used, 'available': total - used}
        except Exception as e:
            print(f"[Database] Error getting stats: {e}")
            return {'total': 0, 'used': 0, 'available': 0}


class AccountManager:
    """Manager for admin Google accounts (NotebookLM cookie accounts)."""

    @staticmethod
    def get_all() -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM admin_accounts ORDER BY id ASC').fetchall()
                result = []
                for row in rows:
                    acc = {
                        'id': row['id'],
                        'name': row['name'],
                        'cookie': row['cookie'],
                        'notebooks': json.loads(row['notebooks_json']),
                        'added_at': row['created_at'],
                    }
                    if row['expires_at']:
                        acc['expires_at'] = row['expires_at']
                    result.append(acc)
                return result
        except Exception as e:
            print(f"[Database] Error getting accounts: {e}")
            return []

    @staticmethod
    def add(name: str, cookie: str, notebooks: list, expires_at: str = None) -> bool:
        try:
            with get_db() as db:
                db.execute(
                    'INSERT INTO admin_accounts (name, cookie, notebooks_json, expires_at) VALUES (?, ?, ?, ?)',
                    (name, cookie, json.dumps(notebooks), expires_at)
                )
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error adding account: {e}")
            return False

    @staticmethod
    def delete_by_index(index: int) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM admin_accounts ORDER BY id ASC').fetchall()
                if index < 0 or index >= len(rows):
                    return None
                row = rows[index]
                acc = {
                    'id': row['id'],
                    'name': row['name'],
                    'cookie': row['cookie'],
                    'notebooks': json.loads(row['notebooks_json']),
                }
                db.execute('DELETE FROM admin_accounts WHERE id = ?', (row['id'],))
                db.commit()
                return acc
        except Exception as e:
            print(f"[Database] Error deleting account: {e}")
            return None

    @staticmethod
    def update_notebooks_by_index(index: int, notebooks: list) -> bool:
        try:
            with get_db() as db:
                rows = db.execute('SELECT id FROM admin_accounts ORDER BY id ASC').fetchall()
                if index < 0 or index >= len(rows):
                    return False
                db.execute(
                    'UPDATE admin_accounts SET notebooks_json = ? WHERE id = ?',
                    (json.dumps(notebooks), rows[index]['id'])
                )
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error updating account notebooks: {e}")
            return False

    @staticmethod
    def get_by_index(index: int) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM admin_accounts ORDER BY id ASC').fetchall()
                if index < 0 or index >= len(rows):
                    return None
                row = rows[index]
                acc = {
                    'id': row['id'],
                    'name': row['name'],
                    'cookie': row['cookie'],
                    'notebooks': json.loads(row['notebooks_json']),
                    'added_at': row['created_at'],
                }
                if row['expires_at']:
                    acc['expires_at'] = row['expires_at']
                return acc
        except Exception as e:
            print(f"[Database] Error getting account: {e}")
            return None

    @staticmethod
    def get_by_id(account_id: int) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute('SELECT * FROM admin_accounts WHERE id = ?', (account_id,)).fetchone()
                if not row:
                    return None
                return {
                    'id': row['id'],
                    'name': row['name'],
                    'cookie': row['cookie'],
                    'notebooks': json.loads(row['notebooks_json']),
                    'added_at': row['created_at'],
                    'expires_at': row['expires_at'],
                }
        except Exception as e:
            print(f"[Database] Error getting account by id: {e}")
            return None

    @staticmethod
    def delete(account_id: int) -> bool:
        try:
            with get_db() as db:
                db.execute('DELETE FROM admin_accounts WHERE id = ?', (account_id,))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error deleting account: {e}")
            return False

    @staticmethod
    def update(account_id: int, **fields) -> bool:
        allowed = {
            'name': 'name',
            'cookie': 'cookie',
            'notebooks': 'notebooks_json',
            'expires_at': 'expires_at',
        }
        updates = []
        values = []
        for key, column in allowed.items():
            if key not in fields:
                continue
            value = fields[key]
            if key == 'notebooks':
                value = json.dumps(value)
            updates.append(f'{column} = ?')
            values.append(value)

        if not updates:
            return True

        try:
            with get_db() as db:
                values.append(account_id)
                db.execute(
                    f'UPDATE admin_accounts SET {", ".join(updates)} WHERE id = ?',
                    tuple(values)
                )
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error updating account: {e}")
            return False


class SelectedNotebookManager:
    """Manager for selected notebooks."""

    @staticmethod
    def get_all() -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT notebook_id, title, account_name FROM selected_notebooks').fetchall()
                return [{'id': row['notebook_id'], 'title': row['title'], 'accountName': row['account_name']} for row in rows]
        except Exception as e:
            print(f"[Database] Error getting selected notebooks: {e}")
            return []

    @staticmethod
    def save_all(selected: List[Dict[str, Any]]) -> bool:
        try:
            with get_db() as db:
                db.execute('DELETE FROM selected_notebooks')
                for sn in selected:
                    db.execute(
                        'INSERT INTO selected_notebooks (notebook_id, title, account_name) VALUES (?, ?, ?)',
                        (sn.get('id', ''), sn.get('title', ''), sn.get('accountName', ''))
                    )
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving selected notebooks: {e}")
            return False


class NotebookProfileManager:
    """Manager for user-facing NotebookLM notebook metadata."""

    @staticmethod
    def get_all(include_unpublished: bool = True) -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                query = 'SELECT * FROM notebook_profiles'
                params: tuple[Any, ...] = ()
                if not include_unpublished:
                    query += ' WHERE is_published = 1'
                query += ' ORDER BY sort_order ASC, updated_at DESC'
                rows = db.execute(query, params).fetchall()
                return [NotebookProfileManager._row_to_dict(row) for row in rows]
        except Exception as e:
            print(f"[Database] Error getting notebook profiles: {e}")
            return []

    @staticmethod
    def get_by_id(notebook_id: str) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute(
                    'SELECT * FROM notebook_profiles WHERE notebook_id = ?',
                    (notebook_id,)
                ).fetchone()
                return NotebookProfileManager._row_to_dict(row) if row else None
        except Exception as e:
            print(f"[Database] Error getting notebook profile: {e}")
            return None

    @staticmethod
    def save(profile: Dict[str, Any]) -> bool:
        now = datetime.now().isoformat()
        existing = NotebookProfileManager.get_by_id(profile['notebook_id'])
        try:
            with get_db() as db:
                if existing:
                    db.execute('''
                        UPDATE notebook_profiles
                        SET account_name = ?, notebook_title = ?, display_title = ?, description = ?,
                            cover_url = ?, is_published = ?, sort_order = ?, updated_at = ?
                        WHERE notebook_id = ?
                    ''', (
                        profile.get('account_name', existing.get('account_name', '')),
                        profile.get('notebook_title', existing.get('notebook_title', '')),
                        profile.get('display_title', existing.get('display_title', '')),
                        profile.get('description', existing.get('description', '')),
                        profile.get('cover_url', existing.get('cover_url', '')),
                        1 if profile.get('is_published', existing.get('is_published', False)) else 0,
                        profile.get('sort_order', existing.get('sort_order', 0)),
                        now,
                        profile['notebook_id'],
                    ))
                else:
                    db.execute('''
                        INSERT INTO notebook_profiles (
                            notebook_id, account_name, notebook_title, display_title, description,
                            cover_url, is_published, sort_order, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        profile['notebook_id'],
                        profile.get('account_name', ''),
                        profile.get('notebook_title', ''),
                        profile.get('display_title', ''),
                        profile.get('description', ''),
                        profile.get('cover_url', ''),
                        1 if profile.get('is_published', False) else 0,
                        profile.get('sort_order', 0),
                        profile.get('created_at', now),
                        now,
                    ))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving notebook profile: {e}")
            return False

    @staticmethod
    def _row_to_dict(row) -> Dict[str, Any]:
        return {
            'notebook_id': row['notebook_id'],
            'account_name': row['account_name'],
            'notebook_title': row['notebook_title'],
            'display_title': row['display_title'],
            'description': row['description'],
            'cover_url': row['cover_url'],
            'is_published': bool(row['is_published']),
            'sort_order': row['sort_order'],
            'created_at': row['created_at'],
            'updated_at': row['updated_at'],
        }


class SourceProfileManager:
    """Manager for source-level metadata and bound documents."""

    @staticmethod
    def get_all_for_notebook(notebook_id: str, include_unpublished: bool = True) -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                query = 'SELECT * FROM source_profiles WHERE notebook_id = ?'
                params: list[Any] = [notebook_id]
                if not include_unpublished:
                    query += ' AND is_published = 1'
                query += ' ORDER BY sort_order ASC, updated_at DESC'
                rows = db.execute(query, tuple(params)).fetchall()
                return [SourceProfileManager._row_to_dict(row) for row in rows]
        except Exception as e:
            print(f"[Database] Error getting source profiles: {e}")
            return []

    @staticmethod
    def get(notebook_id: str, source_id: str) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute(
                    'SELECT * FROM source_profiles WHERE notebook_id = ? AND source_id = ?',
                    (notebook_id, source_id)
                ).fetchone()
                return SourceProfileManager._row_to_dict(row) if row else None
        except Exception as e:
            print(f"[Database] Error getting source profile: {e}")
            return None

    @staticmethod
    def save(profile: Dict[str, Any]) -> bool:
        now = datetime.now().isoformat()
        existing = SourceProfileManager.get(profile['notebook_id'], profile['source_id'])
        try:
            with get_db() as db:
                if existing:
                    db.execute('''
                        UPDATE source_profiles
                        SET source_title = ?, display_title = ?, description = ?, cover_url = ?,
                            markdown_url = ?, markdown_key = ?, pdf_url = ?, pdf_key = ?,
                            source_kind = ?, source_url = ?, asset_manifest_json = ?,
                            package_manifest_json = ?, toc_json = ?, chapters_json = ?,
                            annotations_json = ?, reader_config_json = ?, document_status = ?,
                            is_published = ?, sort_order = ?, updated_at = ?
                        WHERE notebook_id = ? AND source_id = ?
                    ''', (
                        profile.get('source_title', existing.get('source_title', '')),
                        profile.get('display_title', existing.get('display_title', '')),
                        profile.get('description', existing.get('description', '')),
                        profile.get('cover_url', existing.get('cover_url', '')),
                        profile.get('markdown_url', existing.get('markdown_url', '')),
                        profile.get('markdown_key', existing.get('markdown_key', '')),
                        profile.get('pdf_url', existing.get('pdf_url', '')),
                        profile.get('pdf_key', existing.get('pdf_key', '')),
                        profile.get('source_kind', existing.get('source_kind', '')),
                        profile.get('source_url', existing.get('source_url', '')),
                        json.dumps(profile.get('asset_manifest', existing.get('asset_manifest', [])), ensure_ascii=False),
                        json.dumps(profile.get('package_manifest', existing.get('package_manifest', {})), ensure_ascii=False),
                        json.dumps(profile.get('toc', existing.get('toc', [])), ensure_ascii=False),
                        json.dumps(profile.get('chapters', existing.get('chapters', [])), ensure_ascii=False),
                        json.dumps(profile.get('annotations', existing.get('annotations', [])), ensure_ascii=False),
                        json.dumps(profile.get('reader_config', existing.get('reader_config', {})), ensure_ascii=False),
                        profile.get('document_status', existing.get('document_status', 'missing')),
                        1 if profile.get('is_published', existing.get('is_published', False)) else 0,
                        profile.get('sort_order', existing.get('sort_order', 0)),
                        now,
                        profile['notebook_id'],
                        profile['source_id'],
                    ))
                else:
                    db.execute('''
                        INSERT INTO source_profiles (
                            notebook_id, source_id, source_title, display_title, description,
                            cover_url, markdown_url, markdown_key, pdf_url, pdf_key,
                            source_kind, source_url, asset_manifest_json, package_manifest_json,
                            toc_json, chapters_json, annotations_json, reader_config_json,
                            document_status, is_published, sort_order, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        profile['notebook_id'],
                        profile['source_id'],
                        profile.get('source_title', ''),
                        profile.get('display_title', ''),
                        profile.get('description', ''),
                        profile.get('cover_url', ''),
                        profile.get('markdown_url', ''),
                        profile.get('markdown_key', ''),
                        profile.get('pdf_url', ''),
                        profile.get('pdf_key', ''),
                        profile.get('source_kind', ''),
                        profile.get('source_url', ''),
                        json.dumps(profile.get('asset_manifest', []), ensure_ascii=False),
                        json.dumps(profile.get('package_manifest', {}), ensure_ascii=False),
                        json.dumps(profile.get('toc', []), ensure_ascii=False),
                        json.dumps(profile.get('chapters', []), ensure_ascii=False),
                        json.dumps(profile.get('annotations', []), ensure_ascii=False),
                        json.dumps(profile.get('reader_config', {}), ensure_ascii=False),
                        profile.get('document_status', 'missing'),
                        1 if profile.get('is_published', False) else 0,
                        profile.get('sort_order', 0),
                        profile.get('created_at', now),
                        now,
                    ))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving source profile: {e}")
            return False

    @staticmethod
    def _row_to_dict(row) -> Dict[str, Any]:
        return {
            'notebook_id': row['notebook_id'],
            'source_id': row['source_id'],
            'source_title': row['source_title'],
            'display_title': row['display_title'],
            'description': row['description'],
            'cover_url': row['cover_url'],
            'markdown_url': row['markdown_url'],
            'markdown_key': row['markdown_key'],
            'pdf_url': row['pdf_url'],
            'pdf_key': row['pdf_key'],
            'source_kind': row['source_kind'],
            'source_url': row['source_url'],
            'asset_manifest': json.loads(row['asset_manifest_json'] or '[]'),
            'package_manifest': json.loads(row['package_manifest_json'] or '{}'),
            'toc': json.loads(row['toc_json'] or '[]'),
            'chapters': json.loads(row['chapters_json'] or '[]'),
            'annotations': json.loads(row['annotations_json'] or '[]'),
            'reader_config': json.loads(row['reader_config_json'] or '{}'),
            'document_status': row['document_status'],
            'is_published': bool(row['is_published']),
            'sort_order': row['sort_order'],
            'created_at': row['created_at'],
            'updated_at': row['updated_at'],
        }


class AnalysisCacheManager:
    """Manager for cached source-scoped analysis results."""

    @staticmethod
    def get(notebook_id: str, source_id: str, analysis_type: str, cache_key: str) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute('''
                    SELECT response_json FROM analysis_cache
                    WHERE notebook_id = ? AND source_id = ? AND analysis_type = ? AND cache_key = ?
                ''', (notebook_id, source_id, analysis_type, cache_key)).fetchone()
                return json.loads(row['response_json']) if row else None
        except Exception as e:
            print(f"[Database] Error getting analysis cache: {e}")
            return None

    @staticmethod
    def save(notebook_id: str, source_id: str, analysis_type: str, cache_key: str, payload: Dict[str, Any]) -> bool:
        now = datetime.now().isoformat()
        try:
            with get_db() as db:
                db.execute('''
                    INSERT INTO analysis_cache (
                        notebook_id, source_id, analysis_type, cache_key, response_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(notebook_id, source_id, analysis_type, cache_key) DO UPDATE SET
                        response_json = excluded.response_json,
                        updated_at = excluded.updated_at
                ''', (
                    notebook_id,
                    source_id,
                    analysis_type,
                    cache_key,
                    json.dumps(payload, ensure_ascii=False),
                    now,
                    now,
                ))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving analysis cache: {e}")
            return False


class LibraryDBManager:
    """SQLite-based library manager (replaces COS-based LibraryManager)."""

    @staticmethod
    def get_all() -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM libraries ORDER BY created_at DESC').fetchall()
                return [{
                    'id': row['id'],
                    'name': row['name'],
                    'description': row['description'],
                    'cover_url': row['cover_url'],
                    'notebooklm_id': row['notebooklm_id'],
                    'book_count': row['book_count'],
                    'created_at': row['created_at'],
                } for row in rows]
        except Exception as e:
            print(f"[Database] Error getting libraries: {e}")
            return []

    @staticmethod
    def get_by_id(library_id: str) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute('SELECT * FROM libraries WHERE id = ?', (library_id,)).fetchone()
                if not row:
                    return None
                return {
                    'id': row['id'],
                    'name': row['name'],
                    'description': row['description'],
                    'cover_url': row['cover_url'],
                    'notebooklm_id': row['notebooklm_id'],
                    'book_count': row['book_count'],
                    'created_at': row['created_at'],
                }
        except Exception as e:
            print(f"[Database] Error getting library: {e}")
            return None

    @staticmethod
    def save(library: Dict[str, Any]) -> bool:
        try:
            with get_db() as db:
                existing = db.execute('SELECT id FROM libraries WHERE id = ?', (library['id'],)).fetchone()
                # Update book_count
                count = db.execute('SELECT COUNT(*) FROM books WHERE library_id = ?', (library['id'],)).fetchone()[0]
                if existing:
                    db.execute('''
                        UPDATE libraries SET name=?, description=?, cover_url=?, notebooklm_id=?, book_count=?
                        WHERE id=?
                    ''', (library.get('name', ''), library.get('description', ''), library.get('cover_url', ''),
                          library.get('notebooklm_id', ''), count, library['id']))
                else:
                    db.execute('''
                        INSERT INTO libraries (id, name, description, cover_url, notebooklm_id, book_count, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''', (library['id'], library.get('name', ''), library.get('description', ''),
                          library.get('cover_url', ''), library.get('notebooklm_id', ''), count,
                          library.get('created_at', datetime.now().isoformat())))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving library: {e}")
            return False

    @staticmethod
    def delete(library_id: str) -> bool:
        try:
            with get_db() as db:
                db.execute('DELETE FROM books WHERE library_id = ?', (library_id,))
                db.execute('DELETE FROM libraries WHERE id = ?', (library_id,))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error deleting library: {e}")
            return False


class BookDBManager:
    """SQLite-based book manager (replaces COS-based BookManager)."""

    @staticmethod
    def get_all() -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM books ORDER BY created_at DESC').fetchall()
                return [BookDBManager._row_to_dict(row) for row in rows]
        except Exception as e:
            print(f"[Database] Error getting books: {e}")
            return []

    @staticmethod
    def get_by_id(book_id: str) -> Optional[Dict[str, Any]]:
        try:
            with get_db() as db:
                row = db.execute('SELECT * FROM books WHERE id = ?', (book_id,)).fetchone()
                if not row:
                    return None
                return BookDBManager._row_to_dict(row)
        except Exception as e:
            print(f"[Database] Error getting book: {e}")
            return None

    @staticmethod
    def get_by_library(library_id: str) -> List[Dict[str, Any]]:
        try:
            with get_db() as db:
                rows = db.execute('SELECT * FROM books WHERE library_id = ? ORDER BY created_at DESC', (library_id,)).fetchall()
                return [BookDBManager._row_to_dict(row) for row in rows]
        except Exception as e:
            print(f"[Database] Error getting books by library: {e}")
            return []

    @staticmethod
    def save(book: Dict[str, Any]) -> bool:
        try:
            with get_db() as db:
                existing = db.execute('SELECT id FROM books WHERE id = ?', (book['id'],)).fetchone()
                compare_json = json.dumps(book.get('compare_result', {}))
                if existing:
                    db.execute('''
                        UPDATE books SET title=?, author=?, description=?, cover_url=?, file_url=?,
                            file_type=?, file_size=?, page_count=?, source_id=?, compare_result_json=?
                        WHERE id=?
                    ''', (book.get('title', ''), book.get('author', ''), book.get('description', ''),
                          book.get('cover_url', ''), book.get('file_url', ''), book.get('file_type', 'markdown'),
                          book.get('file_size', 0), book.get('page_count', 0), book.get('source_id', ''),
                          compare_json, book['id']))
                else:
                    db.execute('''
                        INSERT INTO books (id, library_id, title, author, description, cover_url,
                            file_url, file_type, file_size, page_count, source_id, compare_result_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (book['id'], book.get('library_id', ''), book.get('title', ''), book.get('author', ''),
                          book.get('description', ''), book.get('cover_url', ''), book.get('file_url', ''),
                          book.get('file_type', 'markdown'), book.get('file_size', 0), book.get('page_count', 0),
                          book.get('source_id', ''), compare_json, book.get('created_at', datetime.now().isoformat())))
                # Update library book_count
                count = db.execute('SELECT COUNT(*) FROM books WHERE library_id = ?', (book.get('library_id', ''),)).fetchone()[0]
                db.execute('UPDATE libraries SET book_count = ? WHERE id = ?', (count, book.get('library_id', '')))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error saving book: {e}")
            return False

    @staticmethod
    def delete(book_id: str) -> bool:
        try:
            with get_db() as db:
                book = db.execute('SELECT library_id FROM books WHERE id = ?', (book_id,)).fetchone()
                db.execute('DELETE FROM books WHERE id = ?', (book_id,))
                if book:
                    count = db.execute('SELECT COUNT(*) FROM books WHERE library_id = ?', (book['library_id'],)).fetchone()[0]
                    db.execute('UPDATE libraries SET book_count = ? WHERE id = ?', (count, book['library_id']))
                db.commit()
                return True
        except Exception as e:
            print(f"[Database] Error deleting book: {e}")
            return False

    @staticmethod
    def _row_to_dict(row) -> Dict[str, Any]:
        return {
            'id': row['id'],
            'library_id': row['library_id'],
            'title': row['title'],
            'author': row['author'],
            'description': row['description'],
            'cover_url': row['cover_url'],
            'file_url': row['file_url'],
            'file_type': row['file_type'],
            'file_size': row['file_size'],
            'page_count': row['page_count'],
            'source_id': row['source_id'],
            'compare_result': json.loads(row['compare_result_json']),
            'created_at': row['created_at'],
        }


# Initialize database on module load
init_db()
