from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    rss_url TEXT NOT NULL,
                    last_fetched_at TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS news (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    summary TEXT,
                    content TEXT NOT NULL,
                    url TEXT NOT NULL UNIQUE,
                    published_at TEXT NOT NULL,
                    source_id TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS highlights (
                    id TEXT PRIMARY KEY,
                    news_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT,
                    start_offset INTEGER NOT NULL,
                    end_offset INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(news_id) REFERENCES news(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS comments (
                    id TEXT PRIMARY KEY,
                    highlight_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(highlight_id) REFERENCES highlights(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS scrapbook_items (
                    id TEXT PRIMARY KEY,
                    news_id TEXT NOT NULL,
                    related_news_id TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    score REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(news_id, related_news_id),
                    FOREIGN KEY(news_id) REFERENCES news(id) ON DELETE CASCADE,
                    FOREIGN KEY(related_news_id) REFERENCES news(id) ON DELETE CASCADE
                );
                """
            )

    def health(self) -> dict:
        with self.connect() as conn:
            articles = conn.execute("SELECT COUNT(*) AS count FROM news").fetchone()["count"]
            sources = conn.execute("SELECT COUNT(*) AS count FROM sources").fetchone()["count"]
        return {
            "status": "ok",
            "timestamp": utc_now(),
            "database": "connected",
            "articles": articles,
            "sources": sources,
        }

    def list_sources(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM sources ORDER BY created_at DESC").fetchall()
        return [source_to_api(row) for row in rows]

    def create_source(self, name: str, rss_url: str) -> dict:
        source_id = str(uuid.uuid4())
        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO sources (id, name, rss_url, created_at) VALUES (?, ?, ?, ?)",
                (source_id, name, rss_url, now),
            )
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
        return source_to_api(row)

    def delete_source(self, source_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
            if row is None:
                return None
            conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        return {"id": source_id}

    def upsert_news(self, item: dict) -> bool:
        now = utc_now()
        with self.connect() as conn:
            existing = conn.execute("SELECT id FROM news WHERE url = ?", (item["url"],)).fetchone()
            if existing:
                return False
            conn.execute(
                """
                INSERT INTO news (id, title, summary, content, url, published_at, source_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.get("id") or str(uuid.uuid4()),
                    item["title"],
                    item.get("summary"),
                    item.get("content") or item.get("summary") or item["title"],
                    item["url"],
                    item.get("publishedAt") or now,
                    item.get("sourceId"),
                    now,
                ),
            )
        return True

    def mark_source_fetched(self, source_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE sources SET last_fetched_at = ? WHERE id = ?", (utc_now(), source_id))

    def get_source(self, source_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
        return source_to_api(row) if row else None

    def list_news(self, limit: int = 100, source_id: str | None = None) -> list[dict]:
        where = "WHERE n.source_id = ?" if source_id else ""
        params: tuple = (source_id, limit) if source_id else (limit,)
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT n.*, s.name AS source_name, s.rss_url AS source_rss_url
                FROM news n
                LEFT JOIN sources s ON s.id = n.source_id
                {where}
                ORDER BY n.published_at DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [news_to_api(row) for row in rows]

    def get_news_detail(self, news_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT n.*, s.name AS source_name, s.rss_url AS source_rss_url
                FROM news n
                LEFT JOIN sources s ON s.id = n.source_id
                WHERE n.id = ?
                """,
                (news_id,),
            ).fetchone()
            if row is None:
                return None
            highlights = conn.execute(
                "SELECT * FROM highlights WHERE news_id = ? ORDER BY created_at DESC",
                (news_id,),
            ).fetchall()
            comments = conn.execute(
                """
                SELECT c.*
                FROM comments c
                JOIN highlights h ON h.id = c.highlight_id
                WHERE h.news_id = ?
                ORDER BY c.created_at DESC
                """,
                (news_id,),
            ).fetchall()
            scrapbook = self._scrapbook_rows(conn, news_id)
        return {
            "news": news_to_api(row),
            "scrapbookItems": [scrapbook_to_api(item) for item in scrapbook],
            "highlights": [highlight_to_api(item) for item in highlights],
            "comments": [comment_to_api(item) for item in comments],
        }

    def create_highlight(self, payload) -> dict | None:
        with self.connect() as conn:
            news = conn.execute("SELECT id FROM news WHERE id = ?", (payload.newsId,)).fetchone()
            if news is None:
                return None
            highlight_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO highlights (id, news_id, user_id, display_name, start_offset, end_offset, text, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    highlight_id,
                    payload.newsId,
                    payload.userId,
                    payload.displayName,
                    payload.startOffset,
                    payload.endOffset,
                    payload.text,
                    utc_now(),
                ),
            )
            row = conn.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
        return highlight_to_api(row)

    def create_comment(self, payload) -> dict | None:
        with self.connect() as conn:
            highlight = conn.execute("SELECT id FROM highlights WHERE id = ?", (payload.highlightId,)).fetchone()
            if highlight is None:
                return None
            comment_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO comments (id, highlight_id, user_id, display_name, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (comment_id, payload.highlightId, payload.userId, payload.displayName, payload.content, utc_now()),
            )
            row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        return comment_to_api(row)

    def list_scrapbook(self, news_id: str) -> list[dict]:
        with self.connect() as conn:
            return [scrapbook_to_api(row) for row in self._scrapbook_rows(conn, news_id)]

    def create_scrapbook_item(self, news_id: str, related_news_id: str, reason: str, score: float) -> bool:
        with self.connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO scrapbook_items (id, news_id, related_news_id, reason, score, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), news_id, related_news_id, reason, score, utc_now()),
                )
                return True
            except sqlite3.IntegrityError:
                return False

    def search(self, query: str, limit: int = 20) -> list[dict]:
        like = f"%{query}%"
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT n.*, s.name AS source_name, s.rss_url AS source_rss_url
                FROM news n
                LEFT JOIN sources s ON s.id = n.source_id
                WHERE n.title LIKE ? OR n.summary LIKE ? OR n.content LIKE ?
                ORDER BY n.published_at DESC
                LIMIT ?
                """,
                (like, like, like, limit),
            ).fetchall()
        return [news_to_api(row) for row in rows]

    def stats(self) -> dict:
        with self.connect() as conn:
            total = conn.execute("SELECT COUNT(*) AS count FROM news").fetchone()["count"]
            source_count = conn.execute("SELECT COUNT(*) AS count FROM sources").fetchone()["count"]
        return {"total": total, "sourceCount": source_count, "recentLogs": []}

    def _scrapbook_rows(self, conn: sqlite3.Connection, news_id: str) -> list[sqlite3.Row]:
        return conn.execute(
            """
            SELECT si.*, rn.title AS related_title, rn.summary AS related_summary, rn.url AS related_url
            FROM scrapbook_items si
            LEFT JOIN news rn ON rn.id = si.related_news_id
            WHERE si.news_id = ?
            ORDER BY si.score DESC
            """,
            (news_id,),
        ).fetchall()


def source_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "rssUrl": row["rss_url"],
        "lastFetchedAt": row["last_fetched_at"],
        "createdAt": row["created_at"],
    }


def news_to_api(row: sqlite3.Row) -> dict:
    source = None
    if "source_name" in row.keys() and row["source_name"]:
        source = {"id": row["source_id"], "name": row["source_name"], "rssUrl": row["source_rss_url"]}
    return {
        "id": row["id"],
        "title": row["title"],
        "summary": row["summary"],
        "content": row["content"],
        "url": row["url"],
        "publishedAt": row["published_at"],
        "createdAt": row["created_at"],
        "sourceId": row["source_id"],
        "source": source,
    }


def highlight_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "newsId": row["news_id"],
        "userId": row["user_id"],
        "displayName": row["display_name"],
        "startOffset": row["start_offset"],
        "endOffset": row["end_offset"],
        "text": row["text"],
        "createdAt": row["created_at"],
    }


def comment_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "highlightId": row["highlight_id"],
        "highlight": {"id": row["highlight_id"]},
        "userId": row["user_id"],
        "displayName": row["display_name"],
        "content": row["content"],
        "createdAt": row["created_at"],
    }


def scrapbook_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "newsId": row["news_id"],
        "relatedNewsId": row["related_news_id"],
        "reason": row["reason"],
        "score": row["score"],
        "createdAt": row["created_at"],
        "relatedNews": {
            "id": row["related_news_id"],
            "title": row["related_title"],
            "summary": row["related_summary"],
            "url": row["related_url"],
        },
    }
