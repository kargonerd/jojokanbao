# JOJO-RAG

JOJO-RAG 是一个围绕 NotebookLM 组织资料、阅读文档与对话检索的本地应用。当前前端主流程已经收敛为三部分：聊天、阅读器和管理后台。

## 当前前端路由

| 路由 | 用途 |
| --- | --- |
| `/` | 重定向到 `/chat` |
| `/chat` | 对话与检索主界面 |
| `/source/:notebookId/:sourceId` | 文档阅读器，支持目录、人物、时间线、关系侧栏 |
| `/admin` | 管理后台入口，重定向到 `/admin/accounts` |
| `/admin/accounts` | NotebookLM 账号管理 |
| `/admin/libraries` | 文库管理 |
| `/admin/libraries/:notebookId` | 文库编辑页 |
| `/admin/libraries/:notebookId/sources/:sourceId` | source 编辑页 |

## 当前后端接口分层

- `/api/chat`、`/api/chat/stream`：对话与流式回答
- `/api/notebooks`、`/api/notebooks/:id/sources`：Notebook 与 source 查询
- `/api/catalog/**`：阅读器与文库消费的 catalog 数据、文档、章节与分析接口
- `/admin/**`：管理后台登录、账号、文库、source 管理接口

## 本地启动

要求：Node.js 18+，Python 3.9+

```bash
pip install -r scf/requirements.txt
npm --prefix frontend install
```

启动后端：

```bash
python run_simple.py
```

启动前端：

```bash
npm --prefix frontend run dev
```

默认情况下，后端监听 `http://127.0.0.1:9002`。前端使用 Vite 开发服务器，端口以实际启动输出为准。

## 使用顺序

1. 启动后端与前端。
2. 打开前端地址，进入 `/chat` 进行对话。
3. 在 `/admin` 登录后台后管理账号、文库与 source；source 支持 Markdown 直传或导入结构化 zip 包。
4. 从聊天引用或 source 链接进入 `/source/:notebookId/:sourceId` 阅读器。

## 代码结构

```text
jojo-rag/
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   ├── composables/
│   │   ├── views/
│   │   ├── router.ts
│   │   └── types/
├── scf/
│   ├── app.py
│   ├── admin.py
│   ├── catalog_api.py
│   ├── notebook_service.py
│   ├── database.py
│   ├── models.py
│   └── cos_manager.py
├── tests/
└── run_simple.py
```

## 当前边界

- 本仓库当前聚焦资料管理、阅读与问答，不再继续扩张旧公开展示页、旧 demo 页面或旧 `/api/library/**` 链路。
- 扫描版 PDF 的 OCR、结构化制书与导出链路不应继续堆在本仓库内，相关方向应由独立项目承接。
- 仓库不保留调试截图、临时日志、静态调试 HTML 或一次性验证产物；这类文件应留在本地临时目录，不进入版本库。
