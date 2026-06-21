"""Data models for JOJO Library."""

import json
import os
from dataclasses import dataclass, asdict, field
from typing import List, Optional, Dict, Any
from datetime import datetime


# COS keys for data storage
LIBRARIES_COS_KEY = 'data/libraries.json'
BOOKS_COS_KEY = 'data/books.json'


@dataclass
class Library:
    """Library (collection of books)."""
    id: str
    name: str
    description: str = ''
    cover_url: str = ''
    notebooklm_id: str = ''  # Associated NotebookLM notebook ID
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    book_count: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Library':
        return cls(**data)


@dataclass
class Book:
    """Book in a library."""
    id: str
    library_id: str
    title: str
    author: str = ''
    description: str = ''
    cover_url: str = ''
    file_url: str = ''  # URL to the book content file
    file_type: str = 'markdown'  # markdown, pdf, etc.
    file_size: int = 0
    page_count: int = 0
    source_id: str = ''  # Associated NotebookLM source ID
    compare_result: Dict[str, Any] = field(default_factory=dict)  # Content comparison result
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Book':
        return cls(**data)


@dataclass
class Comment:
    """Comment on a highlight."""
    id: str
    device_id: str
    text: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Comment':
        return cls(**data)


@dataclass
class Highlight:
    """Text highlight with comments."""
    id: str
    book_id: str
    start_offset: int
    end_offset: int
    selected_text: str
    device_id: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    like_count: int = 0
    comments: List[Comment] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data['comments'] = [c.to_dict() for c in self.comments]
        return data
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Highlight':
        comments_data = data.pop('comments', [])
        highlight = cls(**data)
        highlight.comments = [Comment.from_dict(c) for c in comments_data]
        return highlight


@dataclass
class HighlightsData:
    """All highlights for a book."""
    book_id: str
    total_highlights: int
    highlights: List[Highlight]
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'book_id': self.book_id,
            'total_highlights': len(self.highlights),
            'highlights': [h.to_dict() for h in self.highlights]
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'HighlightsData':
        highlights = [Highlight.from_dict(h) for h in data.get('highlights', [])]
        return cls(
            book_id=data.get('book_id', ''),
            total_highlights=len(highlights),
            highlights=highlights
        )


# CRUD Operations

class LibraryManager:
    """Manager for library operations using SQLite."""

    @classmethod
    def _get_cos(cls):
        try:
            from cos_manager import get_cos_manager
        except ImportError:
            from scf.cos_manager import get_cos_manager
        return get_cos_manager()

    @classmethod
    def _get_dbm(cls):
        try:
            from database import LibraryDBManager
        except ImportError:
            from scf.database import LibraryDBManager
        return LibraryDBManager

    @classmethod
    def get_all(cls) -> List[Library]:
        data = cls._get_cos().download_json(LIBRARIES_COS_KEY) or {}
        if data.get('libraries'):
            return [Library.from_dict(item) for item in data.get('libraries', [])]

        dbm = cls._get_dbm()
        return [Library.from_dict(d) for d in dbm.get_all()]

    @classmethod
    def get_by_id(cls, library_id: str) -> Optional[Library]:
        payload = cls._get_cos().download_json(LIBRARIES_COS_KEY) or {}
        for item in payload.get('libraries', []):
            if item.get('id') == library_id:
                return Library.from_dict(item)

        dbm = cls._get_dbm()
        data = dbm.get_by_id(library_id)
        return Library.from_dict(data) if data else None

    @classmethod
    def save(cls, library: Library):
        dbm = cls._get_dbm()
        dbm.save(library.to_dict())

        cos = cls._get_cos()
        payload = cos.download_json(LIBRARIES_COS_KEY) or {'libraries': []}
        libraries = payload.get('libraries', [])
        for index, item in enumerate(libraries):
            if item.get('id') == library.id:
                libraries[index] = library.to_dict()
                break
        else:
            libraries.append(library.to_dict())
        cos.upload_json(LIBRARIES_COS_KEY, {'libraries': libraries})

    @classmethod
    def delete(cls, library_id: str) -> bool:
        dbm = cls._get_dbm()
        return dbm.delete(library_id)


class BookManager:
    """Manager for book operations using SQLite."""

    @classmethod
    def _get_cos(cls):
        try:
            from cos_manager import get_cos_manager
        except ImportError:
            from scf.cos_manager import get_cos_manager
        return get_cos_manager()

    @classmethod
    def _get_dbm(cls):
        try:
            from database import BookDBManager
        except ImportError:
            from scf.database import BookDBManager
        return BookDBManager

    @classmethod
    def get_all(cls) -> List[Book]:
        data = cls._get_cos().download_json(BOOKS_COS_KEY) or {}
        if data.get('books'):
            return [Book.from_dict(item) for item in data.get('books', [])]

        dbm = cls._get_dbm()
        return [Book.from_dict(d) for d in dbm.get_all()]

    @classmethod
    def get_by_id(cls, book_id: str) -> Optional[Book]:
        payload = cls._get_cos().download_json(BOOKS_COS_KEY) or {}
        for item in payload.get('books', []):
            if item.get('id') == book_id:
                return Book.from_dict(item)

        dbm = cls._get_dbm()
        data = dbm.get_by_id(book_id)
        return Book.from_dict(data) if data else None

    @classmethod
    def get_by_library(cls, library_id: str) -> List[Book]:
        payload = cls._get_cos().download_json(BOOKS_COS_KEY) or {}
        if payload.get('books'):
            return [
                Book.from_dict(item)
                for item in payload.get('books', [])
                if item.get('library_id') == library_id
            ]

        dbm = cls._get_dbm()
        return [Book.from_dict(d) for d in dbm.get_by_library(library_id)]

    @classmethod
    def save(cls, book: Book):
        dbm = cls._get_dbm()
        dbm.save(book.to_dict())

        cos = cls._get_cos()
        payload = cos.download_json(BOOKS_COS_KEY) or {'books': []}
        books = payload.get('books', [])
        for index, item in enumerate(books):
            if item.get('id') == book.id:
                books[index] = book.to_dict()
                break
        else:
            books.append(book.to_dict())
        cos.upload_json(BOOKS_COS_KEY, {'books': books})

    @classmethod
    def delete(cls, book_id: str) -> bool:
        dbm = cls._get_dbm()
        return dbm.delete(book_id)


class HighlightManager:
    """Manager for highlight operations using COS."""
    
    def __init__(self):
        try:
            from cos_manager import get_cos_manager, get_highlights_key
        except ImportError:
            from scf.cos_manager import get_cos_manager, get_highlights_key
        self.cos = get_cos_manager()
        self.get_key = get_highlights_key
    
    def get_all(self, book_id: str) -> HighlightsData:
        """Get all highlights for a book."""
        key = self.get_key(book_id)
        data = self.cos.download_json(key)
        
        if data is None:
            return HighlightsData(book_id=book_id, total_highlights=0, highlights=[])
        
        return HighlightsData.from_dict(data)
    
    def save_all(self, highlights_data: HighlightsData) -> bool:
        """Save all highlights for a book."""
        key = self.get_key(highlights_data.book_id)
        highlights_data.total_highlights = len(highlights_data.highlights)
        
        url = self.cos.upload_json(key, highlights_data.to_dict())
        return url is not None
    
    def add_highlight(self, book_id: str, highlight: Highlight) -> bool:
        """Add a new highlight."""
        data = self.get_all(book_id)
        data.highlights.append(highlight)
        data.total_highlights = len(data.highlights)
        return self.save_all(data)
    
    def delete_highlight(self, book_id: str, highlight_id: str) -> bool:
        """Delete a highlight."""
        data = self.get_all(book_id)
        data.highlights = [h for h in data.highlights if h.id != highlight_id]
        data.total_highlights = len(data.highlights)
        return self.save_all(data)
    
    def add_comment(self, book_id: str, highlight_id: str, comment: Comment) -> bool:
        """Add a comment to a highlight."""
        data = self.get_all(book_id)
        
        for highlight in data.highlights:
            if highlight.id == highlight_id:
                highlight.comments.append(comment)
                return self.save_all(data)
        
        return False
    
    def delete_comment(self, book_id: str, highlight_id: str, comment_id: str) -> bool:
        """Delete a comment from a highlight."""
        data = self.get_all(book_id)
        
        for highlight in data.highlights:
            if highlight.id == highlight_id:
                highlight.comments = [c for c in highlight.comments if c.id != comment_id]
                return self.save_all(data)
        
        return False
    
    def like_highlight(self, book_id: str, highlight_id: str) -> bool:
        """Increment like count for a highlight."""
        data = self.get_all(book_id)
        
        for highlight in data.highlights:
            if highlight.id == highlight_id:
                highlight.like_count += 1
                return self.save_all(data)
        
        return False
