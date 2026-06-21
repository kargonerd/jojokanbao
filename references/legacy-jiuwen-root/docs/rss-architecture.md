# RSS 新闻时间线产品架构

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          前端 (Next.js)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   首页feed   │  │  实体详情页  │  │      时间线展示页        │  │
│  │  (新闻列表)  │  │  (人物/机构) │  │    (历史时间线)          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         后端服务 (Node.js)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   API服务   │  │  定时任务    │  │      WebSocket          │  │
│  │  (RESTful)  │  │ (Bull Queue)│  │    (实时推送)            │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  RSS拉取器   │  │  实体抽取   │  │      搜索聚合            │  │
│  │(node-rss-parser)│ │  (Gemini)  │  │    (多源搜索)            │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          数据存储                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  PostgreSQL │  │    Redis    │  │   Elasticsearch         │  │
│  │  (主数据库)  │  │ (缓存/队列) │  │   (全文搜索)             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 数据流

### 2.1 定时拉取流程

```
定时任务 (每15分钟)
    ↓
拉取 RSS Feed (10-20个源)
    ↓
去重检查 (基于URL + 标题hash)
    ↓
AI实体抽取 (Gemini)
    ↓
保存到数据库
    ↓
推送到前端 (WebSocket/SSE)
```

### 2.2 用户浏览流程

```
用户打开首页
    ↓
加载今日新闻 (带实体标签)
    ↓
点击实体标签
    ↓
显示实体卡片 (可展开)
    ↓
点击"查看历史"
    ↓
后端搜索该实体历史
    ↓
生成时间线
    ↓
展示完整时间线
```

## 3. 数据库模型

### 3.1 核心表

```sql
-- RSS源配置表
CREATE TABLE rss_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  url TEXT NOT NULL UNIQUE,
  category VARCHAR(50), -- tech, finance, politics...
  language VARCHAR(10) DEFAULT 'zh',
  fetch_interval INTEGER DEFAULT 900, -- 秒
  last_fetch_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 新闻文章表
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES rss_sources(id),
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  url TEXT NOT NULL UNIQUE,
  image_url TEXT,
  published_at TIMESTAMP NOT NULL,
  fetched_at TIMESTAMP DEFAULT NOW(),
  
  -- AI分析结果
  entities JSONB, -- [{name, type, confidence}]
  sentiment VARCHAR(20), -- positive, negative, neutral
  keywords TEXT[],
  
  -- 统计
  view_count INTEGER DEFAULT 0,
  timeline_generated BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- 实体表 (去重后)
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  type VARCHAR(50) NOT NULL, -- person, company, policy, event
  slug VARCHAR(200) UNIQUE NOT NULL, -- URL友好的名称
  
  -- 聚合信息
  description TEXT,
  first_mentioned_at TIMESTAMP,
  last_mentioned_at TIMESTAMP,
  mention_count INTEGER DEFAULT 0,
  
  -- 时间线
  timeline_data JSONB, -- 缓存的时间线
  timeline_updated_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- 文章-实体关联表
CREATE TABLE article_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  confidence FLOAT,
  context TEXT, -- 实体在文章中的上下文
  UNIQUE(article_id, entity_id)
);

-- 时间线事件表
CREATE TABLE timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  source_title TEXT,
  article_id UUID REFERENCES articles(id),
  
  -- 验证
  is_verified BOOLEAN DEFAULT FALSE,
  verification_notes TEXT,
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- 用户行为表
CREATE TABLE user_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID, -- 可为空，匿名用户
  session_id VARCHAR(100),
  activity_type VARCHAR(50), -- view, click_entity, generate_timeline
  article_id UUID REFERENCES articles(id),
  entity_id UUID REFERENCES entities(id),
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 3.2 索引设计

```sql
-- 文章表索引
CREATE INDEX idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX idx_articles_entities ON articles USING GIN(entities);
CREATE INDEX idx_articles_timeline_generated ON articles(timeline_generated) WHERE timeline_generated = FALSE;

-- 实体表索引
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_mention_count ON entities(mention_count DESC);

-- 全文搜索
CREATE INDEX idx_articles_search ON articles USING gin(to_tsvector('chinese', title || ' ' || COALESCE(summary, '')));
```

## 4. 定时任务设计

### 4.1 任务队列 (Bull Queue)

```typescript
// queues/rss.queue.ts
import { Queue } from 'bull';

export const rssQueue = new Queue('rss-fetch', {
  redis: { host: 'localhost', port: 6379 }
});

// 任务类型
interface RSSFetchJob {
  sourceId: string;
  sourceUrl: string;
}

interface EntityExtractionJob {
  articleId: string;
  title: string;
  content: string;
}

interface TimelineGenerationJob {
  entityId: string;
  entityName: string;
  entityType: string;
}
```

### 4.2 任务处理器

```typescript
// workers/rss.worker.ts
import { rssQueue } from '../queues/rss.queue';
import { RSSParser } from '../services/rss.parser';
import { ArticleService } from '../services/article.service';

rssQueue.process('fetch-rss', async (job) => {
  const { sourceId, sourceUrl } = job.data;
  
  // 1. 拉取RSS
  const feed = await RSSParser.parse(sourceUrl);
  
  // 2. 遍历文章
  for (const item of feed.items) {
    // 3. 检查是否已存在
    const exists = await ArticleService.exists(item.link);
    if (exists) continue;
    
    // 4. 保存文章
    const article = await ArticleService.create({
      sourceId,
      title: item.title,
      summary: item.summary,
      content: item.content,
      url: item.link,
      imageUrl: item.enclosure?.url,
      publishedAt: new Date(item.pubDate)
    });
    
    // 5. 触发实体抽取任务
    await entityExtractionQueue.add('extract-entities', {
      articleId: article.id,
      title: article.title,
      content: article.content || article.summary
    });
  }
});
```

### 4.3 定时调度

```typescript
// scheduler/index.ts
import { rssQueue } from '../queues/rss.queue';
import { RSSSourceService } from '../services/rss-source.service';

export class Scheduler {
  async start() {
    // 每15分钟执行一次
    setInterval(async () => {
      const sources = await RSSSourceService.getActiveSources();
      
      for (const source of sources) {
        // 检查是否需要拉取
        const shouldFetch = await this.shouldFetch(source);
        if (!shouldFetch) continue;
        
        await rssQueue.add('fetch-rss', {
          sourceId: source.id,
          sourceUrl: source.url
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 }
        });
      }
    }, 15 * 60 * 1000); // 15分钟
  }
  
  private async shouldFetch(source: RSSSource): Promise<boolean> {
    if (!source.lastFetchAt) return true;
    const elapsed = Date.now() - source.lastFetchAt.getTime();
    return elapsed >= source.fetchInterval * 1000;
  }
}
```

## 5. API设计

### 5.1 RESTful API

```
# 新闻Feed
GET /api/feed                    # 今日新闻列表
GET /api/feed?category=tech      # 按分类筛选
GET /api/feed?entity=张雪峰       # 按实体筛选
GET /api/feed/search?q=关键词     # 搜索

# 实体
GET /api/entities                # 热门实体列表
GET /api/entities/:slug          # 实体详情
GET /api/entities/:slug/articles # 实体相关文章
GET /api/entities/:slug/timeline # 实体时间线

# 文章
GET /api/articles/:id            # 文章详情
POST /api/articles/:id/view      # 记录浏览
```

### 5.2 WebSocket (实时推送)

```
WS /ws/feed

事件:
- new_article        # 新文章推送
- entity_detected    # 检测到新实体
- timeline_updated   # 时间线更新
```

## 6. RSS源配置

```typescript
// config/rss-sources.ts
export const defaultRSSSources = [
  {
    name: '36氪',
    url: 'https://36kr.com/feed',
    category: 'tech',
    fetchInterval: 600 // 10分钟
  },
  {
    name: '虎嗅',
    url: 'https://www.huxiu.com/rss/0.xml',
    category: 'tech',
    fetchInterval: 600
  },
  {
    name: '界面新闻',
    url: 'https://www.jiemian.com/rss/feed.xml',
    category: 'news',
    fetchInterval: 900
  },
  {
    name: '财新网',
    url: 'https://www.caixin.com/rss.xml',
    category: 'finance',
    fetchInterval: 900
  },
  {
    name: '澎湃新闻',
    url: 'https://www.thepaper.cn/rss.xml',
    category: 'news',
    fetchInterval: 900
  }
];
```

## 7. 前端页面结构

```
/                          # 首页 - 新闻Feed
  ├── [分类筛选器]          # 全部/科技/财经/时政
  ├── [新闻卡片列表]        # 带实体标签
  └── [实时更新提示]        # WebSocket推送

/entity/:slug              # 实体详情页
  ├── [实体信息卡片]        # 名称/类型/描述
  ├── [相关文章列表]        # 最近提及
  └── [历史时间线]          # 可展开的时间线

/timeline/:entityId        # 完整时间线页
  ├── [时间线可视化]        # 垂直时间线
  ├── [来源验证]           # 链接有效性
  └── [分享导出]           # PDF/图片

/search                    # 搜索页
  └── [搜索结果]           # 文章+实体
```

## 8. 部署配置

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    depends_on:
      - postgres
      - redis
      - elasticsearch

  worker:
    build: .
    command: npm run worker
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    depends_on:
      - postgres
      - redis

  scheduler:
    build: .
    command: npm run scheduler
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=news
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=newstimeline

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    volumes:
      - es_data:/usr/share/elasticsearch/data

volumes:
  postgres_data:
  redis_data:
  es_data:
```

## 9. 开发计划

### Phase 1: 基础架构 (1周)
- [ ] 数据库设计
- [ ] RSS拉取服务
- [ ] 基础API

### Phase 2: AI处理 (1周)
- [ ] 实体抽取
- [ ] 时间线生成
- [ ] 任务队列

### Phase 3: 前端 (1周)
- [ ] 新闻Feed页
- [ ] 实体详情页
- [ ] 时间线展示

### Phase 4: 优化 (1周)
- [ ] 搜索功能
- [ ] 缓存优化
- [ ] 部署上线
