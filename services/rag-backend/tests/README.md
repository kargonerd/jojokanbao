# 测试说明

## 当前状态

当前仓库不再维护旧静态后台 `admin.html`、旧 `/api/library/**` 链路对应的根目录测试用例。

当前更可靠的验证方式是：

1. 前端构建检查
2. 手动验证 `/chat`、`/source/:notebookId/:sourceId`、`/admin/**` 主流程
3. 如需验证 vendored NotebookLM 客户端，在 `notebooklm-py/` 目录下运行其 pytest

## 常用命令

### 前端构建

```bash
npm --prefix frontend run build
```

### 本地启动

```bash
python run_simple.py
npm --prefix frontend run dev
```

### NotebookLM 客户端测试

```bash
cd notebooklm-py
python -m pytest
```

## 新增测试时的要求

- 只为当前仍存在的页面和接口补测试：聊天、阅读器、后台管理。
- 不要新增面向 `admin.html`、旧 demo 页面、旧 `/api/library/**` 的测试。
- 如果新增 UI 自动化测试，应以当前 Vue SPA 路由为目标，而不是静态调试 HTML。
