# Python 后端实现规范

## 概述

将现有的 TypeScript/Node.js 后端迁移到 Python，使用 FastAPI 框架，保持 API 接口兼容。

## 技术栈

- **框架**: FastAPI 0.109.0
- **数据库**: SQLite + sqlite-vec (向量扩展)
- **HTTP 客户端**: httpx, aiohttp
- **RSS 解析**: feedparser
- **调度器**: APScheduler
- **COS 上传**: cos-python-sdk-v5

## 项目结构

```
server-python/
├── requirements.txt
├── .env
├── src/
│   ├── __init__.py
│   ├── main.py           # FastAPI 入口
│   ├── types.py          # Pydantic 模型
│   ├── config.py         # 配置管理
│   ├── db.py             # 数据库操作
│   ├── rss.py            # RSS 抓取
│   ├── ai.py             # AI 实体抽取
│   ├── search.py         # 向量搜索
│   ├── scheduler.py      # 定时任务
│   ├── event_engine.py   # 事件聚合
│   └── cos.py            # 腾讯云 COS
└── data/
    └── news.db           # SQLite 数据库
```

## 文件详细规范

### 1. requirements.txt

```
fastapi==0.109.0
uvicorn[standard]==0.27.0
python-multipart==0.0.6
pydantic==2.5.3
pydantic-settings==2.1.0
sqlite-vec==0.1.9
httpx==0.26.0
aiohttp==3.9.1
feedparser==6.0.11
xmltodict==0.13.0
beautifulsoup4==4.12.3
html5lib==1.1
lxml==5.1.0
jieba==0.42.1
cos-python-sdk-v5==1.9.28
apscheduler==3.10.4
python-dateutil==2.8.2
python-dotenv==1.0.0
```

### 2. src/types.py

定义所有 Pydantic 模型，与 TypeScript 类型对应：

```python
from typing import Optional, List
from pydantic import BaseModel

class NewsItem(BaseModel):
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
    id: str
    name: str
    url: str
    category: str
    description: str
    icon: str
    country: str

class ExtractedEntity(BaseModel):
    name: str
    type: str  # person, organization, location, event, product, technology
    confidence: float

class TimelineEvent(BaseModel):
    date: str
    title: str
    description: str
    source: str
    link: str

class User(BaseModel):
    deviceId: str
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    sources: List[str] = []
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None

class Event(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    newsCount: int = 0
    status: str = "active"
    createdAt: Optional[str] = None

class FetchLog(BaseModel):
    id: int
    sourceId: str
    sourceName: str
    fetchedCount: int
    newCount: int
    errorMessage: Optional[str] = None
    startedAt: Optional[str] = None
    completedAt: Optional[str] = None
    createdAt: Optional[str] = None
```

### 3. src/config.py

```python
from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    # Server
    PORT: int = 4568
    HOST: str = "0.0.0.0"
    
    # Database
    DB_PATH: str = "../data/news.db"
    
    # RSSHub
    RSSHUB_BASE: str = "https://rsshub-latest-5elh.onrender.com"
    
    # COS (Optional)
    COS_SECRET_ID: str = ""
    COS_SECRET_KEY: str = ""
    COS_BUCKET: str = ""
    COS_REGION: str = "ap-shanghai"
    
    # Scheduler
    FETCH_INTERVAL_MINUTES: int = 15
    EVENT_IDENTIFICATION_INTERVAL_MINUTES: int = 30
    
    class Config:
        env_file = ".env"

@lru_cache()
def get_settings():
    return Settings()
```

### 4. src/db.py

数据库操作模块，使用 sqlite3 + sqlite-vec：

**关键函数**:
- `init_database()` - 初始化数据库，创建表和索引
- `upsert_article(article: NewsItem) -> bool` - 插入或更新新闻
- `get_articles(cursor=None, limit=20, source_id=None, event_id=None)` - 获取新闻列表
- `get_article_by_id(article_id: str)` - 获取单条新闻
- `article_exists(link: str) -> bool` - 检查文章是否存在
- `log_fetch(log_data)` - 记录抓取日志
- `get_stats()` - 获取统计信息

**表结构** (与 TypeScript 版本保持一致):
- articles
- events
- event_news
- fetch_logs
- users
- read_history
- favorites

**向量表**:
```python
# 使用 sqlite-vec 创建虚拟表
db.execute("""
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_vec USING vec0(
        embedding float[384]
    )
""")
```

### 5. src/rss.py

RSS 抓取模块：

```python
# 默认新闻源配置 (与 TypeScript 版本完全一致)
DEFAULT_SOURCES = [
    {
        "id": "zaobao-china",
        "name": "联合早报 - 中国",
        "url": f"{RSSHUB_BASE}/zaobao/znews/china",
        "category": "中文",
        "description": "新加坡联合早报中国新闻",
        "icon": "🇸🇬",
        "country": "新加坡",
    },
    # ... 其他 21 个源
]

# 关键函数
async def fetch_rss_news(source: RSSSource) -> List[NewsItem]:
    """抓取单个 RSS 源"""
    
def parse_rss(xml: str, source: RSSSource) -> List[NewsItem]:
    """解析 RSS XML"""
    
def decode_html_entities(text: str) -> str:
    """解码 HTML 实体"""
    
def extract_image_url(content: str) -> Optional[str]:
    """从内容中提取图片 URL"""
```

### 6. src/ai.py

AI 实体抽取模块，调用本地 Claude Code CLI：

```python
import subprocess

async def call_claude(prompt: str) -> str:
    """调用 Claude Code CLI"""
    process = await asyncio.create_subprocess_exec(
        "claude", "--print",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout, _ = await process.communicate(prompt.encode())
    return stdout.decode()

async def extract_entities(content: str) -> List[ExtractedEntity]:
    """从新闻内容中抽取实体"""
    prompt = f"""
    分析以下新闻内容，抽取关键实体（人名、组织、地点、事件、产品、技术）。
    只返回 JSON 格式，不要其他解释。
    
    新闻内容：
    {content[:2000]}
    
    返回格式：
    {{
      "entities": [
        {{"name": "实体名", "type": "person|organization|location|event|product|technology", "confidence": 0.95}}
      ]
    }}
    """
    response = await call_claude(prompt)
    # 解析 JSON 响应
    
async def generate_timeline(entity_name: str, entity_type: str) -> List[TimelineEvent]:
    """生成实体时间线"""
    # 先搜索相关新闻
    # 然后调用 Claude 生成时间线
```

### 7. src/search.py

向量搜索模块：

```python
import sqlite_vec
import numpy as np

VECTOR_DIMENSION = 384

async def generate_embedding(text: str) -> List[float]:
    """生成文本向量 (简化版 hash-based)"""
    # 使用 jieba 分词
    # 生成 384 维向量
    # 归一化
    
def search_by_vector(query: str, limit: int = 20) -> List[NewsItem]:
    """向量搜索"""
    query_vec = await generate_embedding(query)
    # 使用 sqlite-vec 查询
    
def search_by_keywords(query: str, limit: int = 20) -> List[NewsItem]:
    """关键词搜索 (FTS5)"""
    
def hybrid_search(query: str, limit: int = 20) -> List[NewsItem]:
    """混合搜索"""
    # 结合向量搜索和关键词搜索
    
def batch_index_vectors(articles: List[NewsItem]):
    """批量索引向量"""
```

### 8. src/scheduler.py

定时任务模块：

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

async def fetch_single_source(source: RSSSource):
    """抓取单个源"""
    
async def fetch_all_sources():
    """抓取所有源"""
    
def start_scheduler():
    """启动定时任务"""
    scheduler.add_job(fetch_all_sources, 'interval', minutes=15)
    scheduler.add_job(identify_events, 'interval', minutes=30)
    scheduler.start()
```

### 9. src/event_engine.py

事件聚合模块：

```python
async def identify_events():
    """识别事件，聚合相关新闻"""
    # 获取最近 24 小时未分组的新闻
    # 调用 Claude 进行事件识别
    # 保存事件和关联
    
def get_active_events():
    """获取活跃事件"""
    
def archive_old_events():
    """归档旧事件"""
```

### 10. src/cos.py

腾讯云 COS 上传模块：

```python
from qcloud_cos import CosConfig, CosS3Client

def upload_avatar(file_data: bytes, filename: str) -> str:
    """上传头像到 COS"""
    # 生成唯一文件名
    # 上传到 COS
    # 返回 URL
```

### 11. src/main.py

FastAPI 主入口：

```python
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="新闻合订本 API", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 生命周期
def init_db():
    """初始化数据库"""
    
def start_scheduler():
    """启动定时任务"""

# API 路由 (与 TypeScript 版本保持一致)

@app.get("/api/news")
async def get_news(limit: int = 20, cursor: str = None, sourceId: str = None):
    """获取新闻列表"""

@app.get("/api/news/{news_id}")
async def get_news_by_id(news_id: str):
    """获取单条新闻"""

@app.get("/api/search")
async def search(q: str, type: str = "hybrid", limit: int = 20):
    """搜索新闻"""

@app.get("/api/search-for-claude")
async def search_for_claude(q: str, limit: int = 10):
    """Claude 专用搜索"""

@app.post("/api/extract-entities")
async def extract_entities_endpoint(content: str):
    """抽取实体"""

@app.get("/api/timeline/{entity_name}")
async def get_timeline(entity_name: str, entityType: str = None):
    """获取实体时间线"""

@app.get("/api/sources")
async def get_sources():
    """获取所有新闻源"""

@app.post("/api/users/device")
async def create_or_get_user(deviceId: str):
    """获取或创建设备用户"""

@app.put("/api/users/{device_id}")
async def update_user(device_id: str, user_data: User):
    """更新用户信息"""

@app.post("/api/upload-avatar")
async def upload_avatar_endpoint(file: UploadFile = File(...)):
    """上传头像"""

@app.get("/api/events")
async def get_events(limit: int = 20, status: str = "active"):
    """获取事件列表"""

@app.get("/api/events/{event_id}")
async def get_event_by_id(event_id: str):
    """获取事件详情"""

@app.get("/api/stats")
async def get_stats():
    """获取统计信息"""

@app.get("/api/scheduler/status")
async def get_scheduler_status():
    """获取调度器状态"""

@app.post("/api/scheduler/trigger")
async def trigger_scheduler():
    """手动触发抓取"""

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=4568)
```

## 启动脚本

创建 `start.py`:

```python
#!/usr/bin/env python3
import uvicorn
from src.main import app

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=4568,
        reload=True,
        log_level="info"
    )
```

## 环境变量

创建 `.env`:

```
PORT=4568
DB_PATH=../data/news.db
RSSHUB_BASE=https://rsshub-latest-5elh.onrender.com

# COS 配置（可选）
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=ap-shanghai

# 调度器配置
FETCH_INTERVAL_MINUTES=15
EVENT_IDENTIFICATION_INTERVAL_MINUTES=30
```

## 启动命令

```bash
# 安装依赖
pip install -r requirements.txt

# 启动开发服务器
python start.py

# 或使用 uvicorn 直接启动
uvicorn src.main:app --reload --port 4568
```

## 注意事项

1. **编码问题**: Python 版本需要特别注意中文编码，确保数据库读取和 API 返回都使用 UTF-8
2. **异步处理**: FastAPI 是异步框架，数据库操作建议使用 aiosqlite 或在线程池中运行 sqlite3
3. **Claude CLI**: 调用 Claude Code CLI 使用 subprocess，注意处理超时
4. **向量维度**: 保持 384 维，与前端期望一致
5. **API 兼容**: 确保所有 API 响应格式与 TypeScript 版本完全一致

## 测试命令

```bash
# 测试新闻列表
curl http://localhost:4568/api/news?limit=5

# 测试搜索
curl "http://localhost:4568/api/search?q=人工智能&type=hybrid&limit=5"

# 测试统计
curl http://localhost:4568/api/stats
```
