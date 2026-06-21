# jojo-press

jojo-press 是一个把扫描版 PDF 整理成结构化书稿的桌面工具。当前主流程已经收敛为 4 步：`识别` → `添加书籍信息` → `文字和格式校对` → `导出`。

## 当前状态

- 前端：Electron + React + Vite + TypeScript
- 后端：Python FastAPI
- 识别：通过 MinerU HTTP 网关异步启动任务
- 校对：支持真实 PDF.js 页面预览、块级文本保存、bbox 像素级叠框定位
- 导出：支持 Markdown 与 jojo-rag 包

## 当前产品流

1. 在首页创建项目并选择 PDF
2. 上传后立即进入“识别”页
3. 轮询识别状态，完成后自动跳到“添加书籍信息”
4. 确认元数据后进入“文字和格式校对”
5. 校对完成后进入“导出”

说明：
- `质量检查` 相关能力仍保留路由，但产品感知上归入“导出”阶段，不再作为单独步骤展示
- mock 路由仍保留，用于稳定演示与前端验收

## 启动方式

### 1. 浏览器模式

分别启动后端与前端：

```bash
# terminal 1
cd engine
python -m uvicorn jojo_press.app:app --host 127.0.0.1 --port 8765 --reload

# terminal 2
cd desktop
npm run dev
```

默认访问：

- 前端：`http://127.0.0.1:4173`
- 后端：`http://127.0.0.1:8765`

说明：`desktop/dev-runner.mjs` 和 bbox 验收脚本会在内部使用独立的 Vite 端口（当前为 `5180`），避免和手动启动的浏览器模式互相抢端口。

如果后端不在默认端口，可通过查询参数覆盖：

```text
http://127.0.0.1:4173/?apiBaseUrl=http://127.0.0.1:8766
```

### 2. Electron 开发模式

```bash
cd desktop
npm run electron
```

`desktop/dev-runner.mjs` 会：

- 启动 Vite
- 探测并复用兼容的 FastAPI 后端，必要时自动拉起新实例
- 把真实 API base URL 注入 Electron 渲染层

如果 Electron 出现多窗口或残留进程，可使用：

- `desktop/restart-electron.ps1`
- `desktop/restart-electron.bat`

## MinerU 配置

后端通过环境变量连接 MinerU：

- `MINERU_API_BASE`
- `MINERU_API_TOKEN`

可写入 `engine/.env`。

如果未配置，启动识别会返回 `503 mineru gateway is not configured`。

## 关键 API

- `GET /health`
- `POST /projects`
- `POST /projects/{project_id}/source-pdf`
- `POST /tasks/{project_id}/recognition/start`
- `GET /tasks/{project_id}/recognition/status`
- `GET /projects/{project_id}/metadata`
- `POST /projects/{project_id}/metadata`
- `GET /proofread/{project_id}/workspace`
- `GET /proofread/{project_id}/source-pdf`
- `POST /proofread/{project_id}/blocks/{block_id}`
- `GET /quality/{project_id}`
- `GET /export/{project_id}/options`
- `POST /export/{project_id}/{option_id}`

## 测试

前端：

```bash
cd desktop
npm test
```

bbox / PDF 预览一键验收（从仓库根目录运行）：

```bash
npm run verify:bbox
```

该命令会依次验证：

- `ProofreadIssuesPage` 组件回归
- 浏览器真实页面 PDF.js 预览与 bbox 对齐
- Electron 真实窗口 PDF.js 预览与 bbox 对齐

后端：

```bash
cd engine
python -m pytest
```

## 目录说明

- `desktop/`：Electron + React 前端
- `engine/`：FastAPI 后端与 MinerU 集成
- `projects/`：项目数据与识别结果落盘目录
- `exports/`：导出产物
- `samples/`：样例 PDF
- `schema/`：结构化数据 schema
- `docs/`：补充设计文档

## 当前已落地的重要行为

- 上传 PDF 后不再卡住等待，而是立刻进入识别页
- 识别任务后端改为异步状态流，前端轮询状态
- PDF 预览接口改为 inline，浏览器不再把 PDF 当附件下载
- 校对页使用 PDF.js 渲染真实页面，并把 MinerU bbox 转成同一视口下的像素叠框
- `npm run verify:bbox` 可一键覆盖组件、浏览器真实页和 Electron 真实窗口验收
- 浏览器模式支持真实文件上传，不再只依赖 Electron 的本地文件选择
