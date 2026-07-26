# 项目 Handoff 文档

## 项目概述

**新闻合订本** - 基于 RSS 的 AI 新闻阅读器，支持实体抽取、时间线生成、向量搜索和事件聚合。

---

## 当前状态

### 已完成功能

1. **基础架构**
   - React 18 + TypeScript 前端
   - Express + TypeScript 后端
   - SQLite 持久化存储
   - 端口：前端 5173，后端 4568

2. **RSS 抓取**
   - 22 个新闻源配置
   - 定时抓取（每 15 分钟）
   - RSSHub 集成

3. **AI 功能**
   - Claude Code CLI 集成
   - 实体抽取（人名、组织、地点等）
   - 时间线生成

4. **搜索功能**
   - sqlite-vec 向量搜索（384维）
   - FTS5 全文搜索
   - 混合搜索策略

5. **用户功能**
   - 设备 ID 登录
   - 新闻源配置
   - 头像上传（腾讯云 COS）
   - 阅读历史、收藏功能

6. **事件聚合**
   - 同一事件不同媒体报道聚合
   - 事件生命周期管理（1天保留）

---

## 已知问题

### 🔴 严重问题

1. **中文编码问题**
   - 现象：新闻标题和内容显示为乱码（如 `\u7490\u3221\u67ca`）
   - 位置：数据库中存储的数据正常，但 API 返回时编码错误
   - 可能原因：
     - better-sqlite3 读取时的编码问题
     - 或者 JSON 序列化时的编码问题
   - 需要检查：`server/src/db.ts` 中的查询逻辑

### 🟡 中等问题

2. **向量搜索返回空结果**
   - 现象：`/api/search?q=xxx&type=vector` 返回空数组
   - 可能原因：
     - 向量索引未正确建立
     - 或者 embedding 生成有问题
   - 需要检查：`server/src/search.ts` 中的 `searchByVector` 函数

3. **部分 RSS 源抓取失败**
   - 现象：RFI、香港01、半岛电视台等返回 503 错误
   - 原因：RSSHub 实例对这些源的支持问题
   - 建议：检查 RSSHub 实例日志或更换源

### 🟢 低优先级

4. **Embedding 质量**
   - 当前使用简化版 hash-based embedding
   - 建议：集成 OpenAI API 或本地模型生成更高质量向量

5. **前端搜索界面**
   - 搜索 API 已就绪，但前端未实现搜索界面
   - 需要添加搜索框和结果展示

---

## 待办事项

### 高优先级

- [ ] **修复中文编码问题**
  - 检查数据库读取编码
  - 检查 API 响应编码设置
  - 测试修复后的数据展示

- [ ] **修复向量搜索**
  - 检查向量索引是否正确建立
  - 验证 embedding 生成逻辑
  - 测试搜索功能

### 中优先级

- [ ] **前端搜索界面**
  - 添加搜索框组件
  - 实现搜索结果页面
  - 支持搜索类型切换

- [ ] **事件聚合优化**
  - 完善事件识别算法
  - 优化事件展示 UI
  - 添加事件时间线视图

### 低优先级

- [ ] **Embedding 质量提升**
  - 集成 OpenAI text-embedding-3-small
  - 或尝试本地 embedding 模型

- [ ] **RSS 源优化**
  - 移除不稳定的源
  - 添加更多中文源

- [ ] **性能优化**
  - 添加 Redis 缓存
  - 优化数据库查询

---

## 技术债务

1. **ID 生成不一致**
   - `rss.ts` 中使用 `index + Date.now()` 生成 ID
   - `scheduler.ts` 中使用 `sourceId + linkHash` 生成 ID
   - 建议：统一使用 link-based ID

2. **错误处理不完善**
   - 部分 API 缺少错误边界
   - 前端缺少全局错误处理

3. **测试覆盖率低**
   - 缺少单元测试
   - 缺少集成测试

---

## 环境信息

### 依赖版本

```
Node.js: 18+
React: 18.2.0
Express: 4.18.2
SQLite: 3 (better-sqlite3 12.9.0)
sqlite-vec: 0.1.9
```

### 外部服务

- **RSSHub**: https://rsshub-latest-5elh.onrender.com
- **Claude Code CLI**: 本地安装，版本 2.1.109
- **腾讯云 COS**: 可选，用于头像上传

### 数据库

- 位置：`data/news.db`
- 当前数据量：24 条新闻
- 主要来源：Hacker News (13), 财新 (7), 澎湃新闻 (2)

---

## 关键文件

### 后端核心

- `server/src/index.ts` - API 路由
- `server/src/db.ts` - 数据库操作
- `server/src/rss.ts` - RSS 抓取
- `server/src/ai.ts` - AI 实体抽取
- `server/src/search.ts` - 向量搜索
- `server/src/scheduler.ts` - 定时任务
- `server/src/eventEngine.ts` - 事件聚合

### 前端核心

- `src/pages/HomePage.tsx` - 首页
- `src/pages/LoginPage.tsx` - 登录页
- `src/components/NewsCard.tsx` - 新闻卡片
- `src/components/EntityTag.tsx` - 实体标签
- `src/components/Timeline.tsx` - 时间线
- `src/services/api.ts` - API 服务

---

## 启动命令

```bash
# 启动后端（端口 4568）
cd server
npm run dev

# 启动前端（端口 5173）
cd ..
npm run dev
```

---

## 文档位置

- `README.md` - 项目主文档
- `server/API.md` - API 文档
- `docs/ARCHITECTURE.md` - 架构文档
- `docs/DATABASE.md` - 数据库文档
- `handoff.md` - 本文件

---

## 联系人

- 项目所有者：用户
- 当前开发者：Claude Code

---

## 最后更新

2026-04-18
