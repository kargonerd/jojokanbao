"""类型定义"""
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel


class NewsItem(BaseModel):
    """新闻项"""
    id: str
    title: str
    content: Optional[str] = None
    summary: Optional[str] = None
    link: str
    pubDate: str
    sourceId: str
    sourceName: str
    icon: Optional[str] = None
    category: Optional[str] = None
    imageUrl: Optional[str] = None
    eventId: Optional[str] = None


class RSSSource(BaseModel):
    """RSS源"""
    id: str
    name: str
    url: str
    category: str
    description: str
    icon: str
    country: str


class ExtractedEntity(BaseModel):
    """抽取的实体"""
    name: str
    type: str  # person, organization, location, event, product, technology
    confidence: float


class TimelineEvent(BaseModel):
    """时间线事件"""
    date: str
    title: str
    description: str
    source: str
    link: str


class User(BaseModel):
    """用户"""
    deviceId: str
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    sources: List[str] = []
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class Event(BaseModel):
    """事件"""
    id: str
    name: str
    description: Optional[str] = None
    newsCount: int = 0
    status: str = "active"  # active, archived
    createdAt: Optional[str] = None


class FetchLog(BaseModel):
    """抓取日志"""
    id: int
    sourceId: str
    sourceName: str
    fetchedCount: int
    newCount: int
    errorMessage: Optional[str] = None
    startedAt: Optional[str] = None
    completedAt: Optional[str] = None
    createdAt: Optional[str] = None
