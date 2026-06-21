# Services

这些目录来自迁移前的独立项目，保留后端、桌面引擎、搜索和批处理工具源码。它们不在根 `pnpm-workspace.yaml` 内，避免服务端依赖影响前端 app 的 `pnpm build` / `pnpm test`。

## 目录

- `rag-backend/`：来自 `C:\Users\luoxixi\GAI\jojo-rag` 的 Flask/SCF 后端，提供 `/api/chat/stream`、`/api/catalog/**`、`/admin/**`，并保留原 `docs/` 与 `mock_cos/` 样例。
- `press-engine/`：来自 `C:\Users\luoxixi\GAI\jojo-press\engine` 的 FastAPI 后端，提供项目创建、MinerU 识别、校对、导出。
- `jiuwen-api/`：JOJO 旧闻 FastAPI 后端，提供新闻、RSS、来源、批注、评论、合订本任务。
- `jiuwen-news-reader/`：旧 React 新闻阅读器前端原型；旧 Express 后端已归档到 `references/legacy-node-backends/`。
- `reader-search/`：来自 `C:\Users\luoxixi\WebstormProjects\web\search` 的 Elasticsearch 搜索服务。
- `jojo-pipe/`：来自 `C:\Users\luoxixi\WebstormProjects\web\JoJoPipe` 的 PDF 入库/批处理工具。
- `notebooklm-py/`：来自 `jojo-rag/notebooklm-py` 的 NotebookLM Python 客户端副本。

## 启动

```bash
pnpm dev:rag-backend
pnpm dev:press-engine
pnpm dev:reader-search
pnpm dev:jiuwen-api
```

各服务仍需在自己的目录内安装 Python 依赖。`.env` 和数据库不会入库，请从对应的 example 文件或旧部署环境重新生成。
