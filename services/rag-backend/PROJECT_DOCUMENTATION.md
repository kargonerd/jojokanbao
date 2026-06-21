# JOJO-RAG 项目文档

## 项目定位

JOJO-RAG 当前是一套以 NotebookLM 为底层资料源的应用，主要提供：

- NotebookLM 账号管理
- 文库与 source 管理
- 文档阅读
- 基于资料的对话与检索

前端已经收敛为 Vue 3 单页应用，不再维护旧公开首页、旧图谱展示页或独立 demo 页面。

## 当前架构

### 前端

- 技术栈：Vue 3、TypeScript、Vite
- 主流程页面：
  - `frontend/src/views/ChatView.vue`
  - `frontend/src/views/BookReader.vue`
  - `frontend/src/views/AdminView.vue`
  - `frontend/src/views/AdminAccounts.vue`
  - `frontend/src/views/AdminLibraries.vue`
  - `frontend/src/views/AdminLibraryEditor.vue`
  - `frontend/src/views/AdminSourceEditor.vue`
- 路由定义：`frontend/src/router.ts`
- API 封装：`frontend/src/api/index.ts`
- 类型定义：`frontend/src/types/index.ts`

### 后端

- 技术栈：Flask、Python
- 应用入口：`scf/app.py`
- 管理后台接口：`scf/admin.py`
- catalog / 阅读接口：`scf/catalog_api.py`
- 文库服务：`scf/notebook_service.py`
- 数据层：`scf/database.py`、`scf/models.py`
- COS 资源管理：`scf/cos_manager.py`

## 当前路由

| 路由 | 说明 |
| --- | --- |
| `/` | 重定向到 `/chat` |
| `/chat` | 对话主界面 |
| `/source/:notebookId/:sourceId` | 阅读器 |
| `/admin` | 后台入口 |
| `/admin/accounts` | 账号管理 |
| `/admin/libraries` | 文库管理 |
| `/admin/libraries/:notebookId` | 文库编辑 |
| `/admin/libraries/:notebookId/sources/:sourceId` | source 编辑 |

## 当前接口分工

### 对话相关

- `POST /api/chat`
- `POST /api/chat/stream`
- `GET /api/notebooks`
- `GET /api/notebooks/<id>/sources`
- `GET /api/notebooks/<id>/conversations/<conversation_id>/history`

### catalog / 阅读相关

- `GET /api/catalog/notebooks`
- `GET /api/catalog/notebooks/<id>`
- `GET /api/catalog/notebooks/<id>/sources/<source_id>/document`
- `GET /api/catalog/notebooks/<id>/sources/<source_id>/chapters/<chapter_id>`
- `GET /api/catalog/notebooks/<id>/sources/<source_id>/analysis/persons`
- `GET /api/catalog/notebooks/<id>/sources/<source_id>/analysis/persons/<person>/events`
- `POST /api/catalog/notebooks/<id>/sources/<source_id>/analysis/timeline`
- `POST /api/catalog/notebooks/<id>/sources/<source_id>/analysis/relations`

### 管理后台相关

- `POST /admin/login`
- `GET /admin/config`
- `GET /admin/notebooks`
- `PUT /admin/notebooks/<id>`
- `POST /admin/notebooks/<id>/cover`
- `GET /admin/notebooks/<id>/sources`
- `PUT /admin/notebooks/<id>/sources/<source_id>`
- `POST /admin/notebooks/<id>/sources/<source_id>/cover`
- `POST /admin/notebooks/<id>/sources/<source_id>/document`
- `POST /admin/notebooks/<id>/sources/<source_id>/import-package`
- `POST /admin/accounts`
- `POST /admin/accounts/<id>/refresh`
- `DELETE /admin/accounts/<id>`

## 本地开发

安装依赖：

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

后端默认运行在 `http://127.0.0.1:9002`。前端端口由 Vite 启动输出决定。

## 当前维护原则

1. 保持主流程最小化：聊天、阅读器、后台管理。
2. 不再恢复旧公开前台、旧图谱分析页、旧 `/api/library/**` 链路或一次性 demo 页面。
3. 文档应始终描述当前仍存在的页面、路由与接口，不保留历史实现说明。
4. 仓库不保留调试截图、console log、静态调试 HTML、临时验证 markdown 或网络抓包文本。
5. 如果继续扩展数据导入或制书链路，应与本仓库的阅读/问答消费层解耦。
