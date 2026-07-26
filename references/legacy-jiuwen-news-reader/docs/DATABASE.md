# 数据库结构文档

## 数据库配置

- **数据库**: SQLite 3
- **文件路径**: `data/news.db`
- **扩展**: sqlite-vec (向量), FTS5 (全文搜索)
- **WAL 模式**: 已启用

## 表结构

### 1. articles 表

新闻文章主表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 新闻唯一ID (sourceId_linkHash) |
| title | TEXT | NOT NULL | 新闻标题 |
| content | TEXT | | 新闻内容 |
| summary | TEXT | | 内容摘要 (前200字) |
| link | TEXT | NOT NULL | 原文链接 |
| pub_date | DATETIME | NOT NULL | 发布时间 |
| source_id | TEXT | NOT NULL | 来源ID |
| source_name | TEXT | NOT NULL | 来源名称 |
| icon | TEXT | | 来源图标 |
| category | TEXT | | 分类 |
| image_url | TEXT | | 封面图片URL |
| event_id | TEXT | | 关联事件ID |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

**索引**:
```sql
CREATE INDEX idx_articles_pub_date ON articles(pub_date DESC);
CREATE INDEX idx_articles_source_id ON articles(source_id);
CREATE INDEX idx_articles_event_id ON articles(event_id);
CREATE INDEX idx_articles_created_at ON articles(created_at DESC);
```

### 2. events 表

事件表，聚合同一事件的不同报道

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 事件ID (event_xxx) |
| name | TEXT | NOT NULL | 事件名称 |
| description | TEXT | | 事件描述 |
| first_seen_at | DATETIME | | 首次发现时间 |
| last_updated_at | DATETIME | | 最后更新时间 |
| news_count | INTEGER | DEFAULT 0 | 关联新闻数 |
| status | TEXT | DEFAULT 'active' | 状态: active/archived |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |

### 3. event_news 表

事件-新闻关联表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| event_id | TEXT | | 事件ID |
| news_id | TEXT | | 新闻ID |
| relationship_type | TEXT | DEFAULT 'primary' | 关系类型 |
| confidence | REAL | | 关联置信度 (0-1) |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |

**主键**: (event_id, news_id)

### 4. fetch_logs 表

RSS 抓取日志

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 日志ID |
| source_id | TEXT | | 来源ID |
| source_name | TEXT | | 来源名称 |
| fetched_count | INTEGER | DEFAULT 0 | 抓取数量 |
| new_count | INTEGER | DEFAULT 0 | 新增数量 |
| error_message | TEXT | | 错误信息 |
| started_at | DATETIME | | 开始时间 |
| completed_at | DATETIME | | 完成时间 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |

### 5. users 表

用户表（基于设备ID）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| device_id | TEXT | PRIMARY KEY | 设备ID |
| nickname | TEXT | | 昵称 |
| avatar | TEXT | | 头像URL |
| sources | TEXT | | 订阅源JSON数组 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 更新时间 |

### 6. read_history 表

阅读历史

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | ID |
| device_id | TEXT | NOT NULL | 设备ID |
| article_id | TEXT | NOT NULL | 文章ID |
| read_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 阅读时间 |

**索引**: (device_id, read_at DESC)

### 7. favorites 表

收藏表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | ID |
| device_id | TEXT | NOT NULL | 设备ID |
| article_id | TEXT | NOT NULL | 文章ID |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 收藏时间 |

**唯一约束**: (device_id, article_id)

### 8. articles_vec 虚拟表

向量表 (sqlite-vec)

| 字段 | 类型 | 说明 |
|------|------|------|
| rowid | INTEGER | 关联 articles.rowid |
| embedding | float[384] | 384维向量 |

### 9. articles_fts 虚拟表

全文搜索表 (FTS5)

| 字段 | 说明 |
|------|------|
| title | 标题 |
| content | 内容 |

## 向量搜索

### 向量生成

使用简化版 hash-based embedding:
- 提取关键词
- 生成 384 维向量
- 归一化处理

### 相似度计算

```sql
SELECT a.*, distance
FROM articles_vec v
JOIN articles a ON v.rowid = a.rowid
WHERE v.embedding MATCH ?
ORDER BY distance
LIMIT ?
```

## 全文搜索

### FTS5 查询

```sql
SELECT * FROM articles_fts
WHERE articles_fts MATCH ?
ORDER BY rank
LIMIT ?
```

### 混合搜索

结合向量相似度和关键词匹配分数排序

## 数据保留策略

| 数据类型 | 保留时间 | 清理方式 |
|----------|----------|----------|
| 新闻文章 | 永久 | 手动清理 |
| 事件 | 1天 | 自动归档 |
| 抓取日志 | 7天 | 自动清理 |
| 阅读历史 | 30天 | 自动清理 |

## 备份建议

```bash
# 备份数据库
cp data/news.db data/news.db.backup.$(date +%Y%m%d)

# 恢复数据库
cp data/news.db.backup.xxx data/news.db
```
