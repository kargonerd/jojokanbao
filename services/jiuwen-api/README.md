# jojo jiuwen api

FastAPI replacement for the old NestJS/Express jiuwen backends.

## Run

```bash
python -m pip install -r services/jiuwen-api/requirements.txt
python services/jiuwen-api/run.py
```

Environment:

- `JIUWEN_API_HOST`, default `127.0.0.1`
- `JIUWEN_API_PORT`, default `3001`
- `JIUWEN_DB_PATH`, default `services/jiuwen-api/data/jiuwen.sqlite3`

The app exposes both bare routes (`/sources`) and legacy `/api` routes
(`/api/sources`) so current Next pages and older prototypes can share one
Python backend during migration.

## AI reading agent

The backend includes a deterministic Pi-agent reading layer. It does not require
an LLM key during local validation.

- `GET /ai/digest?limit=100` - source mix, hot keywords, and attention lanes.
- `GET /ai/briefing/{news_id}` - TL;DR, key points, entities, timeline,
  reading questions, stance checks, and old-news context.
- `POST /ai/ask` - grounded Q&A for one article with citations.
- `POST /jobs/generate-scrapbook` - persistent old-news comparison links.

Fetch at least 100 real RSS news items and verify the AI features:

```bash
python services/jiuwen-api/tools/fetch_test_news.py --target 100
python services/jiuwen-api/tools/verify_ai_features.py --target 100
```

Reports are written under `services/jiuwen-api/data/`:

- `last_fetch_report.json`
- `ai_verification_report.json`
