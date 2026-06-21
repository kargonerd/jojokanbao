# 新闻合订本产品架构设计

## 1. 系统架构

### 1.1 整体架构图

```
用户 → CDN → Next.js前端 → API Gateway → 后端服务 → 外部API
                                      ↓
                                   PostgreSQL + Redis + S3
```

### 1.2 技术栈选型

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | Next.js 14 + TypeScript + Tailwind + shadcn/ui | SSR/SSG、组件库丰富 |
| 后端 | Node.js + Fastify + TypeScript | 高性能、类型安全 |
| 数据库 | PostgreSQL + Prisma ORM | 关系型数据、迁移方便 |
| 缓存 | Redis (Upstash) | 搜索结果缓存、限流 |
| 对象存储 | Cloudflare R2 / AWS S3 | 存储生成的HTML、截图 |
| AI服务 | Gemini API / OpenAI API | 实体抽取、搜索生成 |
| 部署 | Vercel (前端) + Railway/Render (后端) |  serverless + 容器 |

## 2. 数据库模型

### 2.1 ER图

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     User        │     │   Analysis      │     │    Entity       │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ id (PK)         │◄────┤ id (PK)         │────►│ id (PK)         │
│ email           │     │ userId (FK)     │     │ analysisId (FK) │
│ name            │     │ url             │     │ name            │
│ createdAt       │     │ title           │     │ type            │
└─────────────────┘     │ contentSnapshot │     │ description     │
                        │ status          │     │ selected        │
                        │ createdAt       │     │ createdAt       │
                        └─────────────────┘     └─────────────────┘
                                  │
                                  ▼
                        ┌─────────────────┐
                        │    Timeline     │
                        ├─────────────────┤
                        │ id (PK)         │
                        │ entityId (FK)   │
                        │ htmlContent     │
                        │ jsonData        │
                        │ searchQueries[] │
                        │ sourceLinks[]   │
                        │ status          │
                        │ createdAt       │
                        └─────────────────┘
```

### 2.2 表结构

#### users - 用户表
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(100),
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### analyses - 分析任务表
```sql
CREATE TABLE analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  url TEXT NOT NULL,
  title TEXT,
  content_snapshot TEXT, -- 网页内容快照
  status VARCHAR(20) DEFAULT 'pending', -- pending, extracting, searching, generating, completed, failed
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

#### entities - 抽取实体表
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(50) NOT NULL, -- person, organization, policy, event, concept
  description TEXT,
  reason TEXT, -- 推荐理由
  selected BOOLEAN DEFAULT FALSE,
  confidence_score FLOAT, -- AI置信度
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### timelines - 生成的时间线表
```sql
CREATE TABLE timelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  html_content TEXT, -- 生成的HTML
  json_data JSONB, -- 结构化数据 [{date, title, description, source}]
  search_queries TEXT[], -- 执行的搜索查询
  source_links TEXT[], -- 所有来源链接
  validation_result JSONB, -- 链接验证结果
  view_count INTEGER DEFAULT 0,
  share_slug VARCHAR(100) UNIQUE, -- 分享短链接
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### search_results - 搜索结果缓存表
```sql
CREATE TABLE search_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash VARCHAR(64) UNIQUE, -- 查询内容的hash
  query_text TEXT NOT NULL,
  results JSONB, -- 搜索结果
  cached_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP -- 缓存过期时间
);
```

## 3. API接口设计

### 3.1 RESTful API

#### 认证相关
```
POST /api/auth/login          # 登录
POST /api/auth/register       # 注册
POST /api/auth/refresh        # 刷新token
```

#### 分析任务
```
POST /api/analyses            # 创建分析任务
GET  /api/analyses            # 获取分析列表
GET  /api/analyses/:id        # 获取分析详情
GET  /api/analyses/:id/entities  # 获取抽取的实体
POST /api/analyses/:id/select    # 选择实体并生成时间线
```

#### 时间线
```
GET  /api/timelines/:id       # 获取时间线
GET  /api/timelines/:id/export   # 导出PDF/图片
POST /api/timelines/:id/share    # 生成分享链接
GET  /t/:slug                 # 公开分享页 (短链接)
```

### 3.2 WebSocket API (实时推送)

```
WS /ws/analyses/:id           # 分析进度实时推送

事件类型:
- entity.extracted     # 实体抽取完成
- search.started       # 开始搜索
- search.progress      # 搜索进度
- timeline.generating  # 开始生成时间线
- timeline.completed   # 时间线生成完成
- error                # 错误
```

## 4. 核心服务设计

### 4.1 实体抽取服务

```typescript
class EntityExtractionService {
  async extractEntities(url: string, content: string): Promise<Entity[]> {
    // 1. 检查缓存
    const cached = await this.cache.get(`entities:${url}`);
    if (cached) return cached;

    // 2. 调用LLM抽取
    const prompt = this.buildPrompt(content);
    const response = await this.gemini.generate(prompt);
    
    // 3. 解析并验证
    const entities = this.parseEntities(response);
    
    // 4. 缓存结果
    await this.cache.set(`entities:${url}`, entities, 3600);
    
    return entities;
  }
}
```

### 4.2 搜索聚合服务

```typescript
class SearchAggregationService {
  async searchHistory(entity: Entity): Promise<SearchResult[]> {
    const queries = this.generateQueries(entity);
    const results: SearchResult[] = [];
    
    for (const query of queries) {
      // 检查缓存
      const cached = await this.getCachedSearch(query);
      if (cached) {
        results.push(cached);
        continue;
      }
      
      // 执行搜索
      const result = await this.gemini.search(query);
      await this.cacheSearch(query, result);
      results.push(result);
    }
    
    return this.mergeResults(results);
  }
}
```

### 4.3 时间线生成服务

```typescript
class TimelineGenerationService {
  async generateTimeline(entity: Entity, searchResults: SearchResult[]): Promise<Timeline> {
    // 1. 提取结构化数据
    const structuredData = await this.extractStructuredData(searchResults);
    
    // 2. 验证链接
    const validatedLinks = await this.validateLinks(structuredData);
    
    // 3. 生成HTML
    const html = this.generateHTML(entity, structuredData);
    
    return {
      html,
      jsonData: structuredData,
      validationResult: validatedLinks
    };
  }
}
```

## 5. 前端页面设计

### 5.1 页面路由

```
/                    # 首页 - 输入URL
/history             # 历史记录
/analysis/[id]       # 分析详情页
  ├── /entities      # 实体选择 (默认)
  └── /timeline      # 时间线展示
/t/[slug]            # 公开分享页
/settings            # 用户设置
```

### 5.2 关键组件

```typescript
// 实体选择卡片
interface EntityCardProps {
  entity: Entity;
  selected: boolean;
  onSelect: (id: string) => void;
}

// 时间线组件
interface TimelineProps {
  data: TimelineItem[];
  onShare: () => void;
  onExport: (format: 'pdf' | 'png') => void;
}

// 实时日志组件
interface LiveLogProps {
  analysisId: string;
}
```

## 6. 部署架构

### 6.1 开发环境

```yaml
# docker-compose.yml
version: '3.8'
services:
  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
  
  backend:
    build: ./backend
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://...
  
  postgres:
    image: postgres:15
    volumes:
      - postgres_data:/var/lib/postgresql/data
  
  redis:
    image: redis:7-alpine
```

### 6.2 生产环境

```
Vercel (Next.js Frontend)
    ↓
Cloudflare (CDN + 边缘缓存)
    ↓
Railway/Render (Node.js Backend)
    ↓
Supabase (PostgreSQL)
    ↓
Upstash (Redis)
```

## 7. 性能优化

### 7.1 缓存策略

| 数据类型 | 缓存方式 | TTL |
|---------|---------|-----|
| 实体抽取结果 | Redis | 1小时 |
| 搜索结果 | PostgreSQL + Redis | 24小时 |
| 生成的时间线 | PostgreSQL + CDN | 永久 |
| 网页快照 | S3 | 7天 |

### 7.2 限流策略

```typescript
// 基于用户等级的限流
const rateLimits = {
  free: { requestsPerHour: 10, maxEntities: 3 },
  pro: { requestsPerHour: 100, maxEntities: 10 },
  enterprise: { requestsPerHour: 1000, maxEntities: 50 }
};
```

## 8. 商业化考虑

### 8.1 付费模式

| 功能 | 免费版 | Pro版 ($9.9/月) | 企业版 |
|------|--------|----------------|--------|
| 分析次数 | 10次/月 | 无限 | 无限 |
| 实体选择 | 3个 | 10个 | 50个 |
| 历史记录 | 7天 | 永久 | 永久 |
| 导出PDF | ❌ | ✅ | ✅ |
| API访问 | ❌ | ❌ | ✅ |
| 自定义品牌 | ❌ | ❌ | ✅ |

### 8.2 成本估算

| 项目 | 月成本 (1000用户) |
|------|------------------|
| Vercel Pro | $20 |
| Railway | $50 |
| Supabase | $25 |
| Upstash | $20 |
| Gemini API | $100 |
| 总计 | ~$215/月 |

## 9. 后续迭代计划

### Phase 1: MVP (2周)
- [ ] 基础实体抽取
- [ ] 时间线生成
- [ ] 简单分享功能

### Phase 2: 优化 (2周)
- [ ] 链接验证
- [ ] 缓存系统
- [ ] 用户系统

### Phase 3: 商业化 (2周)
- [ ] 支付集成
- [ ] 导出功能
- [ ] API开放

### Phase 4: 高级功能 (4周)
- [ ] 多语言支持
- [ ] 协作编辑
- [ ] 自定义模板
