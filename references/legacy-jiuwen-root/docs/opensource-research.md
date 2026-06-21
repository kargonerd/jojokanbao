# 开源项目调研报告

## 1. 可直接使用的项目

### 1.1 RSS聚合器

#### **Refeed** (推荐)
- **GitHub**: https://github.com/michaelkremenetsky/Refeed
- **技术栈**: Next.js + tRPC + React + Prisma + Supabase + Tailwind
- **特点**: 
  - 现代化RSS阅读器
  - 支持全内容抓取
  - 书签、笔记、过滤功能
  - 支持Newsletter订阅
  - 有React Native移动端
- **可复用**: 前端架构、数据库模型、RSS解析逻辑

#### **RSS Aggregator (Go)**
- **GitHub**: https://github.com/takumade/rss-aggregator
- **技术栈**: Go + PostgreSQL
- **特点**:
  - 简单的RSS聚合器
  - REST API
  - 用户/订阅/文章管理
- **可复用**: 后端API设计、数据库schema

#### **RSSMonster**
- **GitHub**: https://github.com/VijayS1/RSSMonster
- **技术栈**: Vue.js + Express + Node.js
- **特点**:
  - Google Reader风格
  - 兼容Fever API
  - 自托管
- **可复用**: RSS解析、文章去重逻辑

### 1.2 新闻分析项目

#### **news-aggregator (Ruby)**
- **GitHub**: https://github.com/aliaizad72/news-aggregator
- **技术栈**: Ruby on Rails + PostgreSQL + Redis + Sidekiq
- **特点**:
  - RSS/Atom feed聚合
  - Google Cloud Natural Language API分类
  - 自动语言检测
  - 每小时自动更新
  - 背景任务处理
- **可复用**: 分类算法、定时任务设计、后台队列

#### **Stream-Framework (Python)**
- **GitHub**: https://github.com/tschellenbach/Stream-Framework
- **Stars**: 4.5k+
- **技术栈**: Python + Cassandra/Redis
- **特点**:
  - 构建news feed、activity streams
  - 支持大规模数据
  - 有云服务
- **可复用**: feed算法、通知系统

### 1.3 AI驱动的新闻项目

#### **Good News** (推荐)
- **GitHub**: https://github.com/alexkreidler/goodnews
- **技术栈**: TypeScript + Next.js + Supabase + Anthropic
- **特点**:
  - AI驱动的好新闻feed
  - 三agent LLM pipeline (ingest, tag, rank)
  - 多层去重
  - 个性化推荐
  - 报纸风格UI
- **可复用**: AI处理pipeline、去重算法、UI设计

#### **PulseSynopsis**
- **GitHub**: https://github.com/kulayberde/PulseSynopsis
- **技术栈**: TypeScript
- **特点**:
  - AI驱动的新闻平台
  - 精准摘要
  - 多视角分析
  - 时间线可视化
- **可复用**: 时间线UI、摘要生成

### 1.4 实体抽取相关

#### **GraphRAG**
- **GitHub**: https://github.com/microsoft/graphrag
- **组织**: Microsoft
- **特点**:
  - 知识图谱+RAG
  - 实体关系抽取
  - 多跳推理
  - 时间线/事件抽取
- **可复用**: 实体抽取算法、知识图谱构建

## 2. 推荐的技术组合

基于调研，推荐以下组合：

### 方案A: 快速启动 (推荐)
```
前端: Refeed (Next.js + Tailwind)
后端: news-aggregator API (Ruby/Rails)
AI: Good News的pipeline设计
数据库: PostgreSQL + Redis
```

### 方案B: 自研核心
```
前端: Next.js + shadcn/ui (参考Refeed)
后端: Node.js + Fastify
AI: Gemini API + GraphRAG实体抽取
数据库: PostgreSQL + Redis + Elasticsearch
队列: Bull Queue
```

### 方案C: 极简版
```
前端: RSSMonster (Vue.js)
后端: rss-aggregator (Go)
AI: 简单关键词提取
数据库: PostgreSQL
```

## 3. 可直接复用的代码模块

### 3.1 RSS解析
```javascript
// 基于 news-aggregator 的解析逻辑
const Parser = require('rss-parser');
const parser = new Parser({
  customFields: {
    item: ['media:content', 'enclosure']
  }
});

async function parseRSS(url) {
  const feed = await parser.parseURL(url);
  return feed.items.map(item => ({
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    content: item.content || item.summary,
    image: item.enclosure?.url
  }));
}
```

### 3.2 实体抽取Pipeline (参考Good News)
```typescript
// 三阶段处理
1. Ingest Agent: 抓取并清洗内容
2. Tag Agent: 提取实体、分类、情感分析
3. Rank Agent: 去重、排序、生成摘要
```

### 3.3 去重算法 (SimHash)
```python
# 基于 news-aggregator 的去重
from simhash import Simhash

def get_simhash(text):
    return Simhash(text)

def is_duplicate(text1, text2, threshold=3):
    return get_simhash(text1).distance(get_simhash(text2)) <= threshold
```

## 4. 建议的二次开发策略

### 第一阶段: Fork + 改造 (1-2周)
1. Fork **Refeed** 作为前端基础
2. 添加实体标签展示组件
3. 添加时间线页面

### 第二阶段: 集成AI (1-2周)
1. 集成 **GraphRAG** 或自研实体抽取
2. 添加时间线生成功能
3. 链接验证

### 第三阶段: 优化 (1周)
1. 性能优化
2. 部署上线

## 5. 风险提示

1. **Refeed** 使用Supabase，可能需要替换为自托管PostgreSQL
2. **Good News** 使用Anthropic API，需要改为Gemini
3. 注意开源协议 (大部分是MIT/Apache)

## 6. 结论

**最推荐**: 基于 **Refeed** (前端) + **news-aggregator** (后端架构) + **Good News** (AI pipeline) 进行改造。

这样可以：
- 节省3-4周开发时间
- 获得成熟的前端架构
- 获得可靠的后端设计
- 获得AI处理流程参考
