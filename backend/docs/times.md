# JOJO Times

JOJO Times（时事）的未上线 FastAPI 业务模块，源码位于 `backend/src/app/times`。当前没有
注册到统一公网路由，仍使用临时 SQLite repository，后续启用前迁移到 Supabase。

## Run

```bash
python -m pip install -r backend/requirements-times.txt
```

Environment:

- `TIMES_DB_PATH`：临时 SQLite 数据位置。

模块只导出 `router`，不再创建自己的 FastAPI、CORS 或开发服务器。

## AI reading agent

The backend includes a deterministic Pi-agent reading layer. It does not require
an LLM key during local validation.

- `GET /ai/digest?limit=100` - source mix, hot keywords, and attention lanes.
- `GET /ai/briefing/{news_id}` - TL;DR, key points, entities, timeline,
  reading questions, stance checks, and historical-news context.
- `POST /ai/ask` - grounded Q&A for one article with citations.
- `POST /jobs/generate-scrapbook` - persistent historical-news comparison links.
