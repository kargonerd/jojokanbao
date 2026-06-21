# 新闻合订本重构设计（React 前端 + FastAPI/SQLite 后端）

## 1. 调查目的与范围

### 目的
在不沿用现有 Express/TypeScript 后端实现的前提下，为 `news-reader` 制定一次面向可用产品的重构设计：
- 保留 React Web 前端技术栈
- 将后端改为 Python/FastAPI + SQLite
- 明确第一版的核心产品路径是“刷新闻流”
- 保留 AI 增强能力：实体抽取、时间线生成、语义搜索
- 让 API 和设计体系为未来手机 App 复用做好准备

### 范围
本设计覆盖：
- 现有项目事实调查
- 新产品信息架构
- 新前端页面与组件结构
- 新后端模块边界
- SQLite 新数据模型
- AI 能力在第一版中的落点
- 迁移与实施边界

本设计不覆盖：
- 正式账号体系（邮箱/手机号）
- 云端 PostgreSQL/Redis/S3 架构
- 复杂后台管理系统
- iOS/Android App 具体实现

---

## 2. 调查结论：事实 / 推断 / 存疑

### 2.1 确认事实
1. 当前需要重构的目标项目是 `news-reader`，不是仓库里的其他目录。
2. 当前前端是 React + Vite + TypeScript，见 `news-reader/package.json`。
3. 当前后端是 Express + TypeScript + better-sqlite3，见 `news-reader/server/package.json`。
4. 当前数据库已经是 SQLite，数据库文件路径是 `news-reader/data/news.db`，见 `news-reader/server/src/db.ts:11`。
5. 当前后端入口把路由、调度、搜索、AI、Folo 抓取都堆在一个文件里，见 `news-reader/server/src/index.ts`。
6. 当前首页只有 `/` 和 `/login` 两个页面，见 `news-reader/src/main.tsx:34-52`。
7. 当前首页主路径是新闻列表流，但信息架构仍然很薄，主要由 `HomePage` + `NewsCard` + 弹窗组成，见 `news-reader/src/pages/HomePage.tsx`。
8. 当前用户体系并没有真实后端用户系统，登录态、阅读历史、收藏都主要存在前端本地持久化里，见 `news-reader/src/stores/userStore.ts`。
9. 当前新闻主列表接口返回分页结构 `{ articles, nextCursor, hasMore }`，见 `news-reader/server/src/index.ts:85-91`，但前端部分服务函数仍保留旧接口假设，见 `news-reader/src/services/api.ts:34-36` 与 `news-reader/src/services/rssService.ts:16-17`。
10. 当前代码与文档存在不一致：文档中写了 `/api/news/:id`、`/api/users/device`、`/api/timeline/:entityName` 等，但当前服务实际有 `/api/articles/:id`、没有完整用户 API、时间线是 `POST /api/generate-timeline`，见 `news-reader/server/API.md` 与 `news-reader/server/src/index.ts`。
11. 当前 AI 能力依赖本地 `claude --print` 命令调用，而不是稳定的后端服务接口，见 `news-reader/server/src/ai.ts:7-17`。
12. 当前向量搜索使用 `sqlite-vec`，维度来自环境变量，默认 `1024`，见 `news-reader/server/src/search.ts:6-8`。
13. 当前首页通过 query string 传多个 source，但后端暂时只取第一个 source，见 `news-reader/src/services/rssService.ts:12-17` 和 `news-reader/server/src/index.ts:81`。
14. 当前项目确实已经暴露出“文档描述的产品”和“代码里的产品”分叉的问题。

### 2.2 合理推断
1. 这次重构不应该继续在现有 Express 代码上修补；更合适的路径是保留数据资产和产品目标，但重建 API 边界与前端信息架构。
2. 第一版最应该先救活的是新闻阅读体验，而不是把 AI 做成主入口；因为现有代码已经天然以新闻流作为首页主路径。
3. 未来手机 App 复用的关键不在于今天换 React Native，而在于现在就把 API、实体模型、设计 token、列表/详情结构做稳定。
4. 现有“设备 ID / 本地持久化”思路适合作为 V1，因为它能最小化范围，同时不阻碍以后增加正式账号绑定。
5. 现有向量搜索失败，很可能不仅是索引质量问题，也和接口边界、阈值策略、重建流程、嵌入生成方式耦合过深有关，因此应在重构中一起改模块边界，而不是只改一两个 SQL。
6. 当前 UI 差的问题不是单个组件样式差，而是整体缺少稳定的信息层级、卡片密度策略、筛选模式和详情阅读体验。

### 2.3 存疑事项
1. 现有 `data/news.db` 是否要原地迁移，还是允许导入到新 schema 后重新抓取补齐，没有用户明确要求。
2. 现有 Folo 集成是否是必须保留的一等功能，还是可降级为后续扩展，信息还不足。
3. 头像上传到 COS 是否仍然是刚需；当前需求里用户没有强调这一点。
4. 时间线生成在第一版是“从单篇文章触发”还是“从实体页触发并缓存结果”为主，用户没有继续细分。

因此以下设计只在确认事实基础上给出最小必要假设；对存疑事项不提前扩大范围。

---

## 3. 产品定位

### 核心定位
把当前项目重构成一个 **内容流优先、AI 增强的新闻产品**：
- 用户先打开首页刷新闻流
- 然后通过筛选、收藏、搜索、事件聚合提高效率
- AI 提供实体抽取、时间线和语义搜索作为增强层
- 整体结构对未来手机 App 友好

### 第一版成功标准
1. 首页新闻流稳定、可读、加载快。
2. 来源筛选、时间筛选、收藏、已读这些高频功能可用。
3. 搜索不再是空壳，关键词搜索和语义搜索都能返回可理解结果。
4. 实体抽取和时间线可以从文章或实体入口触发，并有明确加载/空状态。
5. 后端从 Express 切到 FastAPI 后，接口结构更清晰，前后端契约统一。

---

## 4. 推荐方案

### 方案选择
采用 **React 前端保留 + FastAPI/SQLite 后端重建 + 新闻流优先的信息架构**。

### 为什么是这个方案
- 最符合用户已明确选择的路线。
- 能保留现有数据和前端基础，不必同时更换太多技术栈。
- SQLite 仍然满足本地优先开发需求，也符合用户之前偏好“简单本地 setup”。
- 未来做手机 App 时，最重要的是稳定 API 与清晰的数据模型，而不是今天就上更重的基础设施。

---

## 5. 新信息架构

### 5.1 顶层页面
重构后的 Web 保持少而清晰的页面：

1. `/login`
   - 轻登录 / 设备身份创建
   - 只负责进入产品，不承载复杂设置

2. `/`
   - 首页新闻流
   - 第一入口，承担主要 DAU 路径

3. `/search`
   - 搜索页
   - 支持关键词 / 语义 / 混合搜索

4. `/events`
   - 事件聚合列表页
   - 展示近期活跃事件和聚合专题

5. `/events/:id`
   - 事件详情页
   - 多来源报道、时间线、相关文章

6. `/article/:id`
   - 文章详情页
   - 全文阅读、实体、收藏、关联事件、时间线入口

7. `/library`
   - 我的收藏、阅读历史、已保存时间线

8. `/settings`
   - 来源偏好、显示模式、账号占位、数据管理

### 5.2 导航原则
- 顶部保留品牌、全局搜索入口、用户入口
- 主导航控制在 4 项：新闻、搜索、事件、资料库
- 设置从用户菜单进入，不占主导航
- 未来移动端可以直接映射为底部 Tab：新闻 / 搜索 / 事件 / 我的

---

## 6. 前端设计

### 6.1 视觉方向
这次不做“管理后台感”的界面，而做更接近消费型内容产品的 UI：
- 浅底深字，强调内容优先
- 更强的留白和阅读密度控制
- 卡片层级清楚，不靠大面积边框堆砌
- 通过颜色 token、间距 token、圆角 token 统一视觉
- 设计上兼顾未来移动端，因此避免只在桌面成立的复杂布局

### 6.2 设计系统基础
建立一套可复用的基础 token：
- 颜色：背景、前景、弱文本、边框、强调色、来源标签色、状态色
- 间距：4 / 8 / 12 / 16 / 24 / 32
- 圆角：卡片、按钮、输入框、弹层统一分级
- 阴影：只保留 2-3 档，不滥用
- 字体层级：页面标题、区块标题、正文、辅助信息、标签

### 6.3 关键页面结构

#### 首页 `/`
结构：
- 顶栏：品牌、搜索入口、用户菜单
- 筛选栏：来源、分类、时间范围、排序、仅未读/仅收藏
- 亮点区：可选展示“正在发酵的事件”或“编辑推荐”
- 新闻流：主内容
- 右侧栏（仅桌面）：热门关键词、活跃事件、最近使用的筛选

新闻卡片信息层级：
- 标题
- 摘要/导语
- 来源 + 发布时间 + 分类
- 实体标签
- 操作：收藏、标记已读、打开详情、查看事件

#### 搜索页 `/search`
- 顶部大搜索框
- 搜索模式切换：关键词 / 语义 / 混合
- 左侧筛选：来源、时间、分类
- 主区域结果列表
- 空状态解释不同搜索模式含义

#### 文章详情 `/article/:id`
- 顶部：标题、来源、时间、原文链接
- 正文阅读区
- 侧栏或底部：实体、关联事件、相关推荐
- 时间线卡片：对单个实体触发生成或查看缓存

#### 事件页 `/events` 与 `/events/:id`
- 事件列表以专题卡形式展示
- 详情页以“事件摘要 + 时间线 + 报道列表”组织
- 不把事件做成纯数据库概念，而是做成用户能消费的专题页

#### 资料库 `/library`
- 标签切换：收藏 / 阅读历史 / 已保存时间线
- 先支持本地身份下的基础数据，再为后续账号同步留接口

### 6.4 组件层级
建议拆出：
- `AppShell`
- `TopNav`
- `MainTabs`
- `FilterBar`
- `SourceFilterSheet`
- `ArticleCard`
- `ArticleList`
- `ArticleDetailHeader`
- `EntityChips`
- `TimelinePanel`
- `EventCard`
- `SearchInput`
- `SearchModeTabs`
- `EmptyState`
- `LoadingBlock`
- `ErrorBlock`

当前的 `SettingsModal` 和 `EntityModal` 不再承担过多主流程；优先把核心内容放到真实页面，而不是全部塞在弹窗里。

---

## 7. 后端设计（FastAPI）

### 7.1 总体原则
新后端不是把旧 Express 路由翻译成 Python，而是重建为清晰模块：
- API 层只负责输入输出和错误码
- Service 层负责编排业务
- Repository 层负责 SQLite 读写
- Ingestion / AI / Search / Event 聚合作为独立领域模块

### 7.2 建议目录

```text
backend/
  app/
    main.py
    api/
      health.py
      articles.py
      search.py
      events.py
      entities.py
      timelines.py
      user.py
      preferences.py
      admin.py
    core/
      config.py
      db.py
      logging.py
    models/
      article.py
      source.py
      event.py
      entity.py
      user.py
    schemas/
      article.py
      search.py
      event.py
      entity.py
      timeline.py
      user.py
    repositories/
      articles.py
      events.py
      entities.py
      users.py
      preferences.py
      timelines.py
    services/
      article_feed.py
      search_service.py
      entity_service.py
      timeline_service.py
      event_service.py
      auth_service.py
    ingestion/
      rss_fetcher.py
      source_registry.py
      scheduler.py
      folo_importer.py
    ai/
      client.py
      prompts.py
      entity_extractor.py
      timeline_generator.py
      embeddings.py
    tasks/
      refresh_feed.py
      reindex_search.py
      rebuild_events.py
```

### 7.3 API 边界

#### 健康与元信息
- `GET /api/health`
- `GET /api/meta`

#### 新闻流
- `GET /api/articles`
  - 支持 `cursor`, `limit`, `source_ids`, `category`, `published_after`, `published_before`, `read_state`, `favorite_state`
- `GET /api/articles/:id`
- `POST /api/articles/:id/read`
- `POST /api/articles/:id/favorite`
- `DELETE /api/articles/:id/favorite`

#### 搜索
- `GET /api/search`
  - `q`, `mode=keyword|semantic|hybrid`, `limit`, `cursor`, `source_ids`, `date_range`
- `GET /api/search/hot-keywords`

#### 实体与时间线
- `POST /api/entities/extract`
- `GET /api/articles/:id/entities`
- `POST /api/timelines/generate`
- `GET /api/timelines/:id`
- `GET /api/entities/:name/timeline`

#### 事件
- `GET /api/events`
- `GET /api/events/:id`

#### 用户与偏好
- `POST /api/device-sessions`
- `GET /api/me`
- `PUT /api/me/preferences`
- `GET /api/me/library`

#### 管理/运维
- `POST /api/admin/fetch`
- `POST /api/admin/reindex`
- `POST /api/admin/rebuild-events`
- `GET /api/admin/jobs`

### 7.4 为什么这样拆
- 把“文章流”和“文章实时抓 RSS”分开。用户消费的是统一文章流，不该再按旧接口思路去请求单个源的实时 RSS。
- 把“用户资料/偏好”和“内容接口”分开，方便未来 App 接入。
- 把 AI 能力挂在实体/时间线领域下，而不是散在任意路由。
- 把管理接口集中到 `/admin`，避免污染主产品 API。

---

## 8. SQLite 数据模型

### 8.1 保留并升级的核心表

#### `sources`
存新闻源元数据与启用状态。

#### `articles`
核心内容表。
建议字段：
- `id`
- `source_id`
- `external_id`
- `title`
- `summary`
- `content`
- `link`
- `image_url`
- `author`
- `language`
- `category`
- `published_at`
- `fetched_at`
- `canonical_hash`
- `event_id`
- `created_at`
- `updated_at`

#### `article_entities`
保存文章实体抽取结果。
- `id`
- `article_id`
- `name`
- `type`
- `description`
- `confidence`
- `context`
- `created_at`

#### `events`
保存事件聚合结果。
- `id`
- `title`
- `summary`
- `status`
- `primary_entity`
- `first_seen_at`
- `last_seen_at`
- `article_count`
- `created_at`
- `updated_at`

#### `event_articles`
事件与文章关联。
- `event_id`
- `article_id`
- `relationship_type`
- `score`

#### `timelines`
实体或事件时间线缓存。
- `id`
- `subject_type`（entity/event/article）
- `subject_key`
- `title`
- `payload_json`
- `status`
- `generated_at`
- `updated_at`

#### `fetch_jobs`
抓取与导入任务日志。

### 8.2 为设备身份补上的表

#### `device_sessions`
- `id`
- `device_id`
- `display_name`
- `avatar_url`
- `created_at`
- `last_seen_at`

#### `user_preferences`
- `device_session_id`
- `source_ids_json`
- `theme`
- `density`
- `language`
- `updated_at`

#### `saved_articles`
- `device_session_id`
- `article_id`
- `created_at`

#### `read_history`
- `device_session_id`
- `article_id`
- `read_at`
- `read_count`

### 8.3 搜索表
继续使用 SQLite 本地能力，但边界更清晰：
- FTS 表：全文搜索
- 向量表：语义检索
- 嵌入元表：记录 embedding 版本、维度、模型来源

### 8.4 数据迁移原则
- 旧 `articles / events / event_news / fetch_logs` 可迁移，不直接丢弃
- 旧数据如果字段不足，可做“导入 + 补字段默认值”
- 不强求保留旧表名；重构时以新 schema 为准

---

## 9. AI 能力设计

### 9.1 实体抽取
第一版必须保留。

落点：
- 文章详情页展示实体
- 搜索和事件聚合可复用实体结果
- 后端缓存抽取结果，避免每次打开文章重新跑模型

### 9.2 时间线生成
第一版保留，但要降噪：
- 只在用户明确进入文章/实体上下文时触发
- 生成后缓存到 `timelines`
- UI 上把它展示为增强阅读，不当成主列表的一部分

### 9.3 语义搜索
第一版保留，但要可解释：
- 搜索页明确区分关键词/语义/混合模式
- 返回结果里给出来源、时间、摘要
- 不再允许“接口成功但结果永远空数组”成为默认体验

### 9.4 AI 客户端原则
当前后端直接 shell 调 `claude --print`，可作为过渡方案参考，但不适合作为长期边界。
新实现应抽象出统一 AI client：
- 能切换 provider 或本地命令实现
- 统一重试、超时、日志与结构化返回
- prompt 放到独立模块，不再写死在路由附近

---

## 10. 交互与错误处理

### 原则
- 用户动作要有明确反馈：加载中、成功、失败、空状态
- 搜索、时间线、实体提取都要区分“暂无结果”和“生成失败”
- 文章流失败时仍保留最后成功加载的数据，而不是全白屏
- 对未来 App 兼容，错误响应统一结构

### API 错误格式
统一为：
```json
{
  "error": {
    "code": "SEARCH_FAILED",
    "message": "搜索失败",
    "details": null
  }
}
```

---

## 11. 测试策略

### 后端
- repository 层：SQLite 集成测试
- service 层：文章流、搜索、时间线缓存、事件聚合测试
- API 层：关键路由契约测试

### 前端
- 核心状态流测试：登录、筛选、收藏、搜索
- 关键组件测试：ArticleCard、FilterBar、SearchPage、ArticleDetail
- 手工验证首页、搜索页、详情页黄金路径

### 产品验证顺序
1. 登录并进入首页
2. 能稳定拉到新闻流
3. 来源筛选正确工作
4. 收藏/已读持久化
5. 搜索可返回结果
6. 文章详情可触发实体与时间线
7. 事件页可打开专题详情

---

## 12. 迁移策略

### Phase 1：后端基础重建
- 建 FastAPI 项目骨架
- 建新 SQLite schema
- 迁移/导入旧文章数据
- 先跑通 `/health`、`/articles`、`/articles/:id`

### Phase 2：前端壳与新闻流
- 建新 AppShell、导航、页面路由
- 替换旧 `HomePage` 单页结构
- 先完成首页新闻流、详情页、设置页基础版

### Phase 3：搜索与 AI
- 接入关键词搜索
- 接入语义搜索
- 接入实体抽取与时间线缓存

### Phase 4：事件与资料库
- 接入事件聚合页面
- 接入收藏、阅读历史、已保存时间线

### Phase 5：清理与收口
- 删除旧 Express 后端
- 删除与旧 UI 耦合过深的前端模块
- 统一 API 类型与错误格式

---

## 13. 明确不做的事
- 不把 Web 一次性改成 Next.js
- 不先做复杂账号和权限体系
- 不先做云端分布式架构
- 不为“可能以后会需要”提前做过度抽象
- 不把所有功能继续塞进单页 + 弹窗模式

---

## 14. 最终设计结论

### 结论
基于当前代码事实，最合理的重构路线是：

1. 保留 React 前端技术栈，但重做信息架构与视觉系统；
2. 彻底用 FastAPI + SQLite 重建后端；
3. 以“新闻流优先”作为第一产品路径；
4. 将实体抽取、时间线、语义搜索作为稳定可用的增强层；
5. 把设备身份、偏好、收藏、阅读历史纳入新的数据模型；
6. 从第一天起让 API 和设计 token 具备未来手机 App 复用能力。

### 为什么这个结论成立
它同时满足：
- 用户已明确选择的技术路线
- 当前代码真实存在的结构问题
- 本地优先、快速救活产品的现实约束
- 面向未来 App 的演进空间

如果后续发现 Folo、头像上传或旧数据迁移策略需要调整，可以作为实现阶段的边界修订，而不改变本设计主方向。
