# 开源项目调研报告 (更新版)

## 确认可用的项目

### 1. 最推荐: Refeed
- **GitHub**: https://github.com/michaelkremenetsky/Refeed
- **技术栈**: Next.js + tRPC + Prisma + Supabase + Tailwind
- **特点**: 现代化RSS阅读器，支持全内容抓取
- **可复用**: 前端架构、数据库模型、UI组件

### 2. AI新闻聚合项目列表

#### **awesome-ai-news** (资源汇总)
- **GitHub**: https://github.com/taielab/awesome-ai-news
- **内容**: 整理了30+个AI新闻聚合项目
- **推荐项目**:
  - **ai-news-radar**: 实时AI新闻追踪，10+源
  - **clawfeed**: 多频率摘要系统(4h/日/周/月)
  - **TrendRadar**: 企业级信息推送
  - **meridian**: 爬取数百源，AI分析

#### **AI-News-Aggregator-Bot**
- **GitHub**: https://github.com/hrnrxb/AI-News-Aggregator-Bot
- **技术栈**: Python + Telegram Bot
- **特点**: 
  - 多源聚合(HuggingFace, OpenAI, DeepMind等)
  - SQLite去重
  - GitHub Actions自动运行
  - 丰富的Telegram格式化

#### **ai-news-mcp**
- **GitHub**: https://github.com/treesoop/ai-news-mcp
- **技术栈**: TypeScript + Supabase + MCP
- **特点**:
  - 30分钟缓存机制
  - 多源聚合(HN, Reddit, GitHub, Lobsters等)
  - 实时抓取+AI分析

### 3. 可直接Fork的项目

#### **meridian** (最完整)
- 爬取数百源
- AI分析
- 个性化日报
- **适合作为后端参考**

#### **clawfeed**
- 多频率摘要
- 书签功能
- Google OAuth
- **适合作为前端参考**

## 推荐的技术组合 (修正版)

### 方案A: 基于成熟项目改造
```
前端: Refeed (Next.js)
后端AI处理: 参考 meridian / ai-news-mcp
数据库: PostgreSQL (替换Supabase)
部署: Vercel + Railway
```

### 方案B: 快速MVP
```
基础: AI-News-Aggregator-Bot (Python)
改造:
- 添加Web界面 (Flask/FastAPI)
- 添加时间线生成功能
- 使用Gemini替代简单摘要
```

## 建议

由于找不到之前提到的"Good News"项目，建议：

1. **前端**: 直接使用 **Refeed** (最成熟)
2. **后端AI处理**: 参考 **meridian** 或 **ai-news-mcp** 的架构
3. **实体抽取**: 自研 (基于Gemini)
4. **时间线生成**: 自研 (基于现有demo)

这样可以节省 **2-3周** 开发时间。
