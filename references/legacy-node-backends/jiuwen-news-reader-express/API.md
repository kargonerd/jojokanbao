# 后端 API 文档

## 基础信息

- **Base URL**: `http://localhost:4568/api`
- **Content-Type**: `application/json`

## 新闻 API

### 获取新闻列表

```http
GET /news?limit={limit}&cursor={cursor}&sourceId={sourceId}
```

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 每页数量，默认 20 |
| cursor | string | 否 | 分页游标（发布时间） |
| sourceId | string | 否 | 按来源筛选 |

**响应**:
```json
{
  "articles": [
    {
      "id": "hacker-news_aHR0cHM6Ly9t",
      "title": "新闻标题",
      "content": "新闻内容...",
      "summary": "摘要...",
      "link": "https://example.com/article",
      "pubDate": "2026-04-18T06:22:03.074Z",
      "sourceId": "hacker-news",
      "sourceName": "Hacker News",
      "icon": "���",
      "category": "科技",
      "imageUrl": "https://example.com/image.jpg",
      "eventId": null
    }
  ],
  "nextCursor": "2026-04-18T06:00:00.000Z",
  "hasMore": true
}
```

### 获取单条新闻

```http
GET /news/:id
```

**响应**: 单条新闻对象

## 搜索 API

### 搜索新闻

```http
GET /search?q={query}&type={type}&limit={limit}
```

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q | string | 是 | 搜索关键词 |
| type | string | 否 | 搜索类型: keyword/vector/hybrid |
| limit | number | 否 | 返回数量，默认 20 |

**搜索类型**:
- `keyword`: FTS5 关键词搜索
- `vector`: 向量语义搜索
- `hybrid`: 混合搜索（默认）

### Claude 专用搜索

```http
GET /search-for-claude?q={query}&limit={limit}
```

返回格式化文本，供 Claude Code CLI 使用。

## 实体 API

### 抽取实体

```http
POST /extract-entities
Content-Type: application/json

{
  "content": "新闻内容文本..."
}
```

**响应**:
```json
{
  "entities": [
    {
      "name": "实体名称",
      "type": "person|organization|location|event|product|technology",
      "confidence": 0.95
    }
  ]
}
```

### 获取实体时间线

```http
GET /timeline/:entityName?entityType={type}
```

**响应**:
```json
{
  "entity": {
    "name": "实体名称",
    "type": "person"
  },
  "events": [
    {
      "date": "2026-04-18",
      "title": "事件标题",
      "description": "事件描述",
      "source": "新闻来源",
      "link": "https://..."
    }
  ]
}
```

## 用户 API

### 获取/创建设备用户

```http
POST /users/device
Content-Type: application/json

{
  "deviceId": "设备唯一ID"
}
```

**响应**:
```json
{
  "deviceId": "...",
  "nickname": "用户昵称",
  "avatar": "头像URL",
  "sources": ["source1", "source2"],
  "createdAt": "2026-04-18T06:22:03.074Z"
}
```

### 更新用户设置

```http
PUT /users/:deviceId
Content-Type: application/json

{
  "nickname": "新昵称",
  "avatar": "头像URL",
  "sources": ["source1", "source2"]
}
```

### 上传头像

```http
POST /upload-avatar
Content-Type: multipart/form-data

avatar: File
```

**响应**:
```json
{
  "url": "https://cos.example.com/avatar/xxx.jpg"
}
```

## 事件 API

### 获取事件列表

```http
GET /events?limit={limit}&status={status}
```

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 返回数量 |
| status | string | 否 | 状态: active/archived |

**响应**:
```json
{
  "events": [
    {
      "id": "event_xxx",
      "name": "事件名称",
      "description": "事件描述",
      "newsCount": 5,
      "status": "active",
      "createdAt": "2026-04-18T06:22:03.074Z"
    }
  ]
}
```

### 获取事件详情

```http
GET /events/:id
```

**响应**:
```json
{
  "id": "event_xxx",
  "name": "事件名称",
  "description": "事件描述",
  "articles": [
    {
      "id": "...",
      "title": "...",
      "sourceName": "...",
      "link": "..."
    }
  ]
}
```

## 新闻源 API

### 获取所有新闻源

```http
GET /sources
```

**响应**:
```json
{
  "sources": [
    {
      "id": "zaobao-china",
      "name": "联合早报 - 中国",
      "category": "中文",
      "description": "新加坡联合早报中国新闻",
      "icon": "������",
      "country": "新加坡"
    }
  ]
}
```

## 统计 API

### 获取数据库统计

```http
GET /stats
```

**响应**:
```json
{
  "total": 24,
  "bySource": {
    "Hacker News": 13,
    "财新": 7,
    "澎湃新闻": 2
  },
  "recentLogs": [
    {
      "sourceId": "...",
      "sourceName": "...",
      "fetchedCount": 10,
      "newCount": 3,
      "createdAt": "2026-04-18T06:22:03.074Z"
    }
  ]
}
```

## 调度器 API

### 获取调度器状态

```http
GET /scheduler/status
```

**响应**:
```json
{
  "isRunning": false,
  "lastFetchTime": "2026-04-18T06:22:03.074Z",
  "intervalMinutes": 15
}
```

### 手动触发抓取

```http
POST /scheduler/trigger
```

**响应**:
```json
{
  "totalFetched": 50,
  "totalNew": 10,
  "errors": []
}
```
