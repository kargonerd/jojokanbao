# Backend

JOJO 的统一 Python 后端。源码采用标准 `src` 布局，不依赖任何云平台的部署目录。

```text
src/app/
  main.py       FastAPI 入口
  core/         配置、认证、错误和 HTTP 中间件
  account/      已启用的账号 API
  times/        通过受保护 RSSHub 聚合时事内容的只读 API
tests/
```

## 本地运行

```bash
python -m pip install -r backend/requirements-dev.txt
pnpm dev:backend
```

本地 RSSHub 密钥放在仓库根目录的 `.env.local`（该文件不会提交）：

```dotenv
JOJOKANBAO_RSSHUB_ACCESS_KEY=<RSSHub 的 ACCESS_KEY>
```

接口：

- `GET http://127.0.0.1:8088/v1/health`
- `GET http://127.0.0.1:8088/v1/me`
- `GET http://127.0.0.1:8088/v1/times/news`
- `GET http://127.0.0.1:8088/v1/times/news/{news_id}`
- `GET http://127.0.0.1:8088/v1/times/stats`

Times 使用 `JOJO_TIMES_RSSHUB_URL` 和服务端专用的
`JOJOKANBAO_RSSHUB_ACCESS_KEY`；它的值就是 Render 上 RSSHub 服务的 `ACCESS_KEY`，
不是另一把新密钥。访问密钥只存在于 Python API 环境，不能放入任何 `VITE_*` 变量或
浏览器请求。Times 路由还会校验 JOJO 登录 access token。

## 测试

```bash
pnpm test:backend
```

## 部署

EdgeOne 薄入口位于 `infrastructure/edgeone/functions/api/index.py`。它只导入
`app.main:app`。`pnpm prepare:web-deploy` 在部署时组装源码、依赖、平台入口和 Web
静态产物。RAG 使用独立的 Node Agent 运行层，不随 Python API 部署。
