# Folo 项目架构分析报告

## 1. 项目概览

**Folo** 是一个 AI 驱动的 RSS 阅读器，支持 Web、移动端(iOS/Android)、桌面端(Windows/macOS/Linux)。

- **仓库**: https://github.com/RSSNext/follow
- **技术栈**: TypeScript 95.7%, Rust, Swift, Java
- **架构**: Monorepo + Turborepo
- **数据库**: SQLite (Drizzle ORM)
- **AI**: 内置 AI 聊天、翻译、摘要功能

## 2. 项目结构

```
folo/
├── apps/                          # 应用层
│   ├── cli/                       # 命令行工具
│   ├── desktop/                   # 桌面端 (Electron)
│   ├── landing/                   # 官网落地页
│   ├── mobile/                    # 移动端 (React Native)
│   ├── ota/                       # 热更新服务
│   └── ssr/                       # SSR服务端渲染
├── packages/                      # 共享包
│   ├── internal/
│   │   ├── atoms/                 # 状态管理 (Jotai)
│   │   ├── components/            # 共享组件
│   │   ├── constants/             # 常量
│   │   ├── database/              # 数据库 (Drizzle)
│   │   ├── hooks/                 # 自定义 Hooks
│   │   ├── logger/                # 日志
│   │   ├── models/                # 数据模型
│   │   ├── shared/                # 共享工具
│   │   ├── store/                 # 状态存储
│   │   ├── tracker/               # 埋点追踪
│   │   ├── types/                 # TypeScript 类型
│   │   └── utils/                 # 工具函数
│   ├── configs/                   # 配置文件
│   └── readability/               # 文章可读性提取
├── icons/                         # 图标资源
└── locales/                       # 国际化
```

## 3. 技术栈详解

### 3.1 前端技术栈

| 技术 | 用途 | 版本 |
|------|------|------|
| React 19 | UI框架 | 19.2.0 |
| Next.js | Web应用 | 15.x |
| Tailwind CSS | 样式 | 3.4.17 |
| Jotai | 状态管理 | 2.17.1 |
| TanStack Query | 数据获取 | 5.90.21 |
| React Router | 路由 | 7.13.0 |
| i18next | 国际化 | 25.8.6 |
| Fastify | SSR服务端 | 5.7.4 |

### 3.2 数据库 (Drizzle ORM)

**核心表结构**:

```typescript
// feeds - RSS源
feedsTable: {
  id, title, url, description, image,
  siteUrl, ownerUserId, subscriptionCount,
  updatesPerWeek, latestEntryPublishedAt
}

// entries - 文章条目
entriesTable: {
  id, title, url, content, description,
  author, publishedAt, feedId,
  media, categories, attachments,
  sources, settings
}

// subscriptions - 用户订阅
subscriptionsTable: {
  feedId, userId, view, isPrivate,
  title, category, createdAt
}

// summaries - AI摘要
summariesTable: {
  entryId, summary, readabilitySummary,
  language, createdAt
}

// translations - 翻译
translationsTable: {
  entryId, language, title,
  description, content, createdAt
}

// ai_chat_sessions - AI聊天
aiChatTable: {
  chatId, title, createdAt, updatedAt, isLocal
}

// ai_chat_messages - AI消息
aiChatMessagesTable: {
  id, chatId, role, content,
  createdAt, status, finishedAt
}
```

### 3.3 AI功能实现

**AI 服务集成**:
- 使用 `ai` 包 (Vercel AI SDK)
- 支持多种 AI 提供商
- 内置 AI 聊天界面
- 自动翻译和摘要

**AI 数据库表**:
- `ai_chat_sessions` - 聊天会话
- `ai_chat_messages` - 聊天消息
- `summaries` - 文章摘要
- `translations` - 翻译缓存

## 4. 核心功能实现

### 4.1 RSS抓取流程

```
1. 用户添加 RSS URL
2. 后端抓取 Feed 信息
3. 解析 RSS/Atom 格式
4. 存储到 feeds 表
5. 用户订阅存储到 subscriptions 表
6. 定时任务抓取 entries
7. AI 处理 (摘要、翻译)
8. 前端展示时间线
```

### 4.2 时间线展示

- 统一时间线 (所有订阅源合并)
- 按时间倒序排列
- 支持分类筛选
- 支持视图切换 (列表/卡片/杂志)

### 4.3 AI 功能

- **AI 聊天**: 与文章对话
- **自动摘要**: 生成文章摘要
- **自动翻译**: 多语言支持
- **智能推荐**: 基于阅读历史

## 5. 部署和打包

### 5.1 构建命令

```bash
# 构建所有包
pnpm run build:packages

# 构建 Web
pnpm run build:web

# 开发模式
pnpm run dev:web

# 构建桌面端
pnpm run build:desktop

# 构建移动端
pnpm run build:mobile
```

### 5.2 部署配置

**Web (SSR)**:
- 使用 Vercel 部署
- Cloudflare Workers 支持
- 配置: `wrangler.jsonc`

**桌面端**:
- Electron Forge 打包
- 支持 Windows/macOS/Linux
- 自动更新 (OTA)

**移动端**:
- Expo 构建
- iOS/Android 双端
- App Store / Google Play 发布

### 5.3 CI/CD

GitHub Actions 工作流:
- `build-web.yml` - Web构建
- `build-desktop.yml` - 桌面端构建
- `build-ios.yml` - iOS构建
- `build-android.yml` - Android构建
- `publish-ota.yml` - 热更新发布

## 6. 可复用的模块

### 6.1 强烈推荐复用

#### 1. 数据库架构 (packages/internal/database)
- **可复用度**: ⭐⭐⭐⭐⭐
- **说明**: 完整的 RSS 数据库设计
- **改造点**: 添加 entities 表和 timeline_events 表

#### 2. RSS解析 (packages/readability)
- **可复用度**: ⭐⭐⭐⭐⭐
- **说明**: 文章可读性提取
- **直接使用**: 无需改造

#### 3. AI 服务集成
- **可复用度**: ⭐⭐⭐⭐
- **说明**: AI SDK 封装
- **改造点**: 添加实体抽取 Prompt

#### 4. 前端组件 (packages/internal/components)
- **可复用度**: ⭐⭐⭐⭐
- **说明**: UI组件库
- **改造点**: 添加实体标签组件

#### 5. 状态管理 (packages/internal/atoms)
- **可复用度**: ⭐⭐⭐⭐
- **说明**: Jotai 状态管理
- **直接使用**: 无需改造

### 6.2 需要自研的部分

1. **实体抽取服务**
   - 基于 Gemini API
   - 从文章内容抽取人名/机构/事件
   - 存储到 entities 表

2. **时间线生成服务**
   - 搜索实体历史
   - 生成时间线数据
   - 链接验证

3. **时间线展示组件**
   - 垂直时间线 UI
   - 来源验证显示
   - 交互功能

## 7. 改造建议

### 7.1 数据库改造

```typescript
// 添加 entities 表
export const entitiesTable = sqliteTable("entities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<"person" | "organization" | "event">(),
  description: text("description"),
  firstMentionedAt: integer("first_mentioned_at", { mode: "timestamp_ms" }),
  mentionCount: integer("mention_count").default(0),
});

// 添加 entry_entities 关联表
export const entryEntitiesTable = sqliteTable("entry_entities", {
  entryId: text("entry_id").references(() => entriesTable.id),
  entityId: text("entity_id").references(() => entitiesTable.id),
  confidence: integer("confidence"),
});

// 添加 timeline_events 表
export const timelineEventsTable = sqliteTable("timeline_events", {
  id: text("id").primaryKey(),
  entityId: text("entity_id").references(() => entitiesTable.id),
  date: integer("date", { mode: "timestamp_ms" }),
  title: text("title"),
  description: text("description"),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
});
```

### 7.2 服务改造

```typescript
// 新增 EntityExtractionService
class EntityExtractionService {
  async extractFromEntry(entry: Entry): Promise<Entity[]> {
    const prompt = buildEntityPrompt(entry);
    const result = await this.ai.generate(prompt);
    return this.parseEntities(result);
  }
}

// 新增 TimelineGenerationService
class TimelineGenerationService {
  async generateTimeline(entity: Entity): Promise<TimelineEvent[]> {
    // 1. 搜索历史
    // 2. 提取结构化数据
    // 3. 验证链接
    // 4. 返回时间线
  }
}
```

### 7.3 前端改造

```typescript
// 新增 EntityTag 组件
const EntityTag: React.FC<{ entity: Entity }> = ({ entity }) => {
  return (
    <span className="entity-tag" onClick={() => showTimeline(entity)}>
      {entity.name}
    </span>
  );
};

// 新增 TimelineView 组件
const TimelineView: React.FC<{ entityId: string }> = ({ entityId }) => {
  const { data: timeline } = useTimeline(entityId);
  return (
    <div className="timeline">
      {timeline.map(event => (
        <TimelineItem key={event.id} event={event} />
      ))}
    </div>
  );
};
```

## 8. 开发计划

### Phase 1: 基础集成 (1周)
- [ ] Fork Folo 项目
- [ ] 添加数据库表 (entities, entry_entities)
- [ ] 集成实体抽取服务

### Phase 2: 时间线功能 (1周)
- [ ] 添加 timeline_events 表
- [ ] 实现时间线生成服务
- [ ] 添加时间线展示组件

### Phase 3: 优化 (1周)
- [ ] 链接验证
- [ ] 性能优化
- [ ] UI美化

### Phase 4: 部署 (1周)
- [ ] 配置环境变量
- [ ] Vercel 部署
- [ ] 测试上线

## 9. 总结

**Folo 是一个非常适合作为基础的项目**:
- ✅ 完整的 RSS 基础设施
- ✅ 现代化的技术栈
- ✅ 内置 AI 功能
- ✅ 多端支持
- ✅ 活跃维护

**改造工作量预估**:
- 复用 Folo 基础: 节省 4-6 周
- 新增功能开发: 2-3 周
- 总计: 6-9 周 (vs 从0开始 12-16 周)
