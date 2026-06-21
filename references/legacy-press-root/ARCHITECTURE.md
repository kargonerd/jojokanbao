# Architecture

## 一句话架构

`PDF -> MinerU 识别任务 -> 归一化书稿 JSON -> 人工校对 -> 导出产物`

## 技术栈

- 前端：Electron + React + Vite + TypeScript
- 后端：Python FastAPI
- 识别：MinerU HTTP 网关
- 预览：浏览器内联 PDF + bbox 叠框
- 存储：项目文件落盘到 `projects/`

## 产品阶段

当前产品阶段固定为 4 步：

1. 识别
2. 添加书籍信息
3. 文字和格式校对
4. 导出

说明：
- `质量检查` 相关数据和页面仍存在，但在产品分期上归入“导出”阶段
- `上传 PDF` 是触发动作，不再作为单独阶段展示

## 前端架构

### 路由

主路由在 `desktop/src/router.tsx`：

- `/projects`
- `/projects/new`
- `/projects/:projectId/recognition`
- `/projects/:projectId/metadata`
- `/projects/:projectId/proofread`
- `/projects/:projectId/quality`
- `/projects/:projectId/export`

此外保留 `mock-1` 路由用于演示和视觉验收。

### 创建项目流

首页创建项目时：

1. 选择 PDF
2. `POST /projects`
3. 浏览器模式下上传文件到 `POST /projects/{project_id}/source-pdf`
4. `POST /tasks/{project_id}/recognition/start`
5. 立即导航到 `/projects/:projectId/recognition`

### 识别页

识别页使用 `GET /tasks/{project_id}/recognition/status` 轮询状态：

- `queued`
- `processing`
- `completed`
- `failed`

当状态变成 `completed`，前端自动跳转到元数据确认页。

### 校对页

校对页由 `desktop/src/pages/ProofreadIssuesPage.tsx` 渲染。

核心能力：

- 显示 PDF 页面预览
- 读取 `preview.pages[].blocks[].bbox`
- 在 `.page-canvas` 上绘制 bbox 叠框
- 点击 bbox 切换当前块
- 保存当前块文本到 `POST /proofread/{project_id}/blocks/{block_id}`

当前 bbox 使用后端提供的百分比坐标直接绘制。对于 layout 数据完整的项目，这已经能工作；如果某个旧项目缺少 `preview.pages` 或 `layout`，页面仍可显示 PDF，但不会出现叠框。

## 后端架构

FastAPI 入口：`engine/jojo_press/app.py`

主要路由：

- `projects.py`：项目创建、元数据读写、PDF 上传
- `tasks.py`：识别任务启动、重试、恢复、状态查询
- `proofread.py`：校对工作区、源 PDF 预览、块保存
- `quality.py`：质量检查
- `export.py`：导出选项与执行

### 识别任务状态机

`engine/jojo_press/services/mineru_service.py` 负责识别任务。

当前实现：

- `start_task()` 立即写入 `queued` 状态并拉起后台线程
- 后台线程进入 `processing`
- 识别完成后写入 `completed`
- 异常时写入 `failed`

任务状态文件落在：

```text
projects/<project_id>/state/recognition-task.json
```

### MinerU 网关

当前通过环境变量构建网关：

- `MINERU_API_BASE`
- `MINERU_API_TOKEN`

后端会：

1. 提交批任务
2. 轮询 MinerU 结果
3. 下载 zip 输出
4. 提取 `content_list.json` / `layout.json`
5. 归一化成项目书稿文档

### 书稿与校对数据

校对工作区由 `proofread.py` 从书稿文档构造：

- `issues`
- `preview.documentUrl`
- `preview.pages`
- `block` / `blocks`
- `toc`

其中 `GET /proofread/{project_id}/source-pdf` 返回 `Content-Disposition: inline`，保证浏览器内联预览 PDF。

## 数据与文件布局

```text
projects/
  <project_id>/
    book.json
    state/
      recognition-task.json
    source/
    mineru/
```

导出产物写入 `exports/`。

## 开发辅助

### 浏览器开发

- `desktop/src/lib/api.ts` 默认访问 `http://127.0.0.1:8765`
- 也支持从 Electron preload 或查询参数读取 API base URL

### Electron 开发

`desktop/dev-runner.mjs` 会探测兼容后端，避免错误复用旧的、不兼容的本地服务实例。这一层是当前开发体验稳定的关键。

## 当前架构上的已知边界

- 真实识别页目前显示的是阶段状态文案，不是细粒度页级百分比
- 旧项目如果没有 layout 页块数据，校对页不会自动补出 bbox
- `quality` 路由仍存在，但属于导出前检查，不代表单独产品阶段
