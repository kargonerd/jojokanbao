# 腾讯云函数（SCF）部署指南

## 当前部署形态

JOJO-RAG 现在由两部分组成：

- `frontend/`：Vue 3 单页应用，部署后提供 `/chat`、`/source/:notebookId/:sourceId`、`/admin/**`
- `scf/`：Flask API，提供聊天、catalog、后台管理接口

管理后台已经并入前端 SPA，不再单独部署 `admin.html`。

## 本地验证

```bash
pip install -r scf/requirements.txt
npm --prefix frontend install
python run_simple.py
npm --prefix frontend run dev
```

默认情况下：
- 后端：`http://127.0.0.1:9002`
- 前端：`http://localhost:3000`

## 后端部署（SCF）

### 1. 准备部署包

```bash
cd scf
pip install -r requirements.txt -t .
cd ..
zip -r deploy.zip scf/
```

将 `deploy.zip` 上传到腾讯云函数，入口保持 `scf/index.py` 对应配置。

### 2. 配置环境变量

至少配置以下内容：

| 变量名 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH`/`ADMIN_PASSWORD_SALT` | 后台登录口令 |
| `NOTEBOOKLM_AUTH_COMPRESSED` | NotebookLM 认证信息 |
| `GOOGLE_ACCOUNTS` | 后台账号配置 |
| `SELECTED_NOTEBOOKS` | 当前启用的 notebook 配置 |

如果使用明文口令，本地和云端都可直接通过 `/admin/login` 登录；不依赖前端首次设置页面。

### 3. 配置 API 网关

为 Flask API 暴露统一网关地址，并开启 CORS。

建议确保以下路径可访问：
- `/api/chat`
- `/api/chat/stream`
- `/api/catalog/**`
- `/admin/**`
- `/api/notebooks`

## 前端部署

### 1. 构建前端

```bash
npm --prefix frontend run build
```

### 2. 部署静态文件

将 `frontend/dist/` 部署到静态托管（COS、Vercel、Nginx 等）。

### 3. 配置 API 地址

前端通过 `VITE_API_BASE` 指向已部署的后端网关地址；未设置时，本地开发默认走 `127.0.0.1:9002`。

## 上线后访问

- 用户主入口：前端站点 `/chat`
- 阅读器：前端站点 `/source/:notebookId/:sourceId`
- 管理后台：前端站点 `/admin`

## 注意事项

1. 不要再部署或引用 `admin.html`。
2. 不要再暴露或依赖旧 `/api/library/**` 接口。
3. NotebookLM cookies 会过期，需要定期更新。
4. 若前端使用 history 路由，静态托管层需将未知路径回退到 `index.html`。
