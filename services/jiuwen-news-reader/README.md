# 新闻合订本 (News Reader)

> Backend migration note: the active backend is now the FastAPI service in
> `services/jiuwen-api`. The old Express server has been archived under
> `references/legacy-node-backends/jiuwen-news-reader-express`.

一个基于 RSS 的新闻聚合阅读器，支持 AI 实体抽取、时间线生成、向量搜索和事件聚合功能。

## 功能特性

### 核心功能
- **RSS 新闻聚合** - 从多个 RSS 源抓取新闻，支持 22+ 新闻源
- **AI 实体抽取** - 使用 Claude Code CLI 自动识别新闻中的人名、组织、地点等实体
- **时间线生成** - 为每个实体生成相关事件的时间线
- **向量搜索** - 基于 sqlite-vec 的语义搜索，支持混合搜索（向量 + 关键词）
- **事件聚合** - 自动聚合不同媒体对同一事件的报道

### 用户功能
- **设备 ID 登录** - 无需注册，基于设备 ID 的匿名登录
- **新闻源配置** - 用户可自定义选择关注的新闻源
- **阅读历史** - 记录用户已读新闻
- **收藏功能** - 支持收藏感兴趣的新闻
- **头像上传** - 支持上传自定义头像到腾讯云 COS

## 技术栈

### 前端
- React 18 + TypeScript
- Vite 构建工具
- Tailwind CSS 样式
- Zustand 状态管理
- React Query 数据获取

### 后端
- FastAPI via `services/jiuwen-api`
- SQLite + better-sqlite3 (持久化存储)
- sqlite-vec (向量搜索)
- RSSHub (RSS 聚合)
- Claude Code CLI (AI 处理)
- 腾讯云 COS (图片存储)

## 项目结构

```
news-reader/
├── src/                          # 前端源码
│   ├── components/               # React 组件
│   │   ├── EntityModal.tsx       # 实体详情弹窗
│   │   ├── EntityTag.tsx         # 实体标签
│   │   ├── NewsCard.tsx          # 新闻卡片
│   │   ├── SettingsModal.tsx     # 设置弹窗
│   │   └── Timeline.tsx          # 时间线组件
│   ├── pages/                    # 页面组件
│   │   ├── HomePage.tsx          # 首页
│   │   └── LoginPage.tsx         # 登录页
│   ├── services/                 # API 服务
│   │   ├── aiService.ts          # AI 相关 API
│   │   ├── api.ts                # 通用 API
│   │   └── rssService.ts         # RSS 相关 API
│   ├── stores/                   # 状态管理
│   │   ├── rssStore.ts           # RSS 状态
│   │   └── userStore.ts          # 用户状态
│   └── utils/                    # 工具函数
├── server-python/                # Python backend notes/types kept for migration reference
│   └── src/
│       ├── index.ts              # 入口文件
│       ├── rss.ts                # RSS 抓取逻辑
│       ├── ai.ts                 # AI 实体抽取
│       ├── db.ts                 # 数据库操作
│       ├── search.ts             # 向量搜索
│       ├── scheduler.ts          # 定时任务
│       ├── eventEngine.ts        # 事件聚合
│       ├── cos.ts                # 腾讯云 COS
│       └── types.ts              # 类型定义
└── data/                         # 数据库文件
    └── news.db                   # SQLite 数据库
```

## 快速开始

### 环境要求
- Node.js 18+
- Claude Code CLI (用于 AI 功能)
- 腾讯云 COS 账号 (用于图片上传，可选)

### 安装依赖

```bash
# 安装前端依赖
npm install

# 安装统一 Python 后端依赖
python -m pip install -r ../jiuwen-api/requirements.txt
```

### 配置环境变量

前端 `.env`:
```env
VITE_API_URL=http://localhost:3001/api
```

后端环境变量:
```env
# 腾讯云 COS 配置（可选）
COS_SECRET_ID=your_secret_id
COS_SECRET_KEY=your_secret_key
COS_BUCKET=your_bucket
COS_REGION=ap-shanghai
```

### 启动开发服务器

```bash
# 启动后端（端口 3001）
cd ../jiuwen-api
python run.py

# 启动前端（端口 5173）
cd ../jiuwen-news-reader
npm run dev
```

### 构建生产版本

```bash
# 构建前端
npm run build
```

## API 文档

### 新闻相关

#### 获取新闻列表
```
GET /api/news?limit=20&cursor={cursor}&sourceId={sourceId}
```

#### 搜索新闻
```
GET /api/search?q={query}&type=hybrid&limit=20
```
搜索类型: `keyword` | `vector` | `hybrid`

#### 获取单条新闻
```
GET /api/news/:id
```

### 实体相关

#### 抽取实体
```
POST /api/extract-entities
Body: { "content": "新闻内容" }
```

#### 获取实体时间线
```
GET /api/timeline/:entityName?entityType={type}
```

### 用户相关

#### 获取/创建设备用户
```
POST /api/users/device
Body: { "deviceId": "设备ID" }
```

#### 更新用户设置
```
PUT /api/users/:deviceId
Body: { "nickname": "昵称", "avatar": "头像URL", "sources": ["source1", "source2"] }
```

#### 上传头像
```
POST /api/upload-avatar
Content-Type: multipart/form-data
Body: { "avatar": File }
```

### 事件相关

#### 获取事件列表
```
GET /api/events?limit=20&status=active
```

#### 获取事件详情
```
GET /api/events/:id
```

### 统计信息

#### 获取数据库统计
```
GET /api/stats
```

## 数据库结构

### articles 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PRIMARY KEY | 新闻唯一ID |
| title | TEXT | 标题 |
| content | TEXT | 内容 |
| summary | TEXT | 摘要 |
| link | TEXT | 原文链接 |
| pub_date | DATETIME | 发布时间 |
| source_id | TEXT | 来源ID |
| source_name | TEXT | 来源名称 |
| event_id | TEXT | 关联事件ID |

### events 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PRIMARY KEY | 事件ID |
| name | TEXT | 事件名称 |
| description | TEXT | 事件描述 |
| status | TEXT | 状态: active/archived |

### event_news 表
| 字段 | 类型 | 说明 |
|------|------|------|
| event_id | TEXT | 事件ID |
| news_id | TEXT | 新闻ID |
| confidence | REAL | 关联置信度 |

### fetch_logs 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 日志ID |
| source_id | TEXT | 来源ID |
| fetched_count | INTEGER | 抓取数量 |
| new_count | INTEGER | 新增数量 |
| error_message | TEXT | 错误信息 |

## 配置的新闻源

### 中文媒体
- 联合早报 (中国/国际/东南亚/美中)
- 南方周末
- 财新
- 澎湃新闻
- 第一财经
- 金十数据

### 国际媒体
- BBC 中文网
- 路透社
- 纽约时报
- 半岛电视台
- 香港 01
- 法国国际广播电台
- 德国之声

### 科技媒体
- Hacker News
- TechCrunch
- 36氪
- 即刻

## 开发说明

### 添加新的 RSS 源

在 `server/src/rss.ts` 中的 `DEFAULT_SOURCES` 数组添加：

```typescript
{
  id: 'unique-id',
  name: '源名称',
  url: `${RSSHUB_BASE}/path/to/feed`,
  category: '分类',
  description: '描述',
  icon: '🔖',
  country: '国家',
}
```

### 向量搜索配置

向量维度: 384
搜索策略: 混合搜索（向量相似度 + FTS5 关键词匹配）

### 定时任务

- **RSS 抓取**: 每 15 分钟
- **事件识别**: 每 30 分钟
- **数据保留**: 事件数据保留 1 天

## 注意事项

1. **Claude Code CLI** 必须已安装并可用，用于 AI 实体抽取和时间线生成
2. **RSSHub** 实例需要可访问，默认使用用户部署的实例
3. **腾讯云 COS** 配置为可选，不配置则无法上传头像
4. **SQLite 数据库** 位于 `data/news.db`，会自动创建

## License

MIT
