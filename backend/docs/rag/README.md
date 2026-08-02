# RAG

RAG 是统一后端中尚未上线的原型模块，源码位于 `backend/src/app/rag`。

当前保留 NotebookLM、catalog、文档导入和分析逻辑，但不注册到
`app.main`，因此不会出现在公网 API，也不会影响 Reader。旧腾讯 SCF 入口、启动脚本、
内置 `typing_extensions` 和静态前端耦合已经移除。

RAG 的额外依赖与主 API 分开：

```bash
python -m pip install -r backend/requirements-rag.txt
python -m pytest backend/tests/rag
```

在正式启用前还需要：

- 将 Flask endpoint 改成 FastAPI router；
- 将 SQLite 和本地 mock COS 状态迁移到 Supabase/COS；
- 接入统一 Supabase 身份验证；
- 明确函数体积和超时后再加入部署产物。
