# jojo-press 交接说明

## 这次已经完成的关键收口

### 1. 产品流收敛为 4 步

当前统一为：

1. 识别
2. 添加书籍信息
3. 文字和格式校对
4. 导出

页面上的 stage strip 已同步收口，`质量检查` 不再作为第 5 步对外展示。

### 2. 上传 PDF 后会立即进入识别页

之前首页会等待识别调用结束，用户体感像“没开始识别就直接跳后面”。现在首页创建项目后会：

- 创建项目
- 上传 PDF
- 启动识别任务
- 立即进入 `/projects/:projectId/recognition`

识别页会轮询任务状态，完成后自动跳到元数据页。

### 3. 后端识别改成异步状态流

`engine/jojo_press/services/mineru_service.py` 现在不是同步阻塞返回 completed，而是：

- `queued`
- `processing`
- `completed`
- `failed`

前端状态轮询基于 `GET /tasks/{project_id}/recognition/status`。

### 4. PDF 预览已改为 inline

`GET /proofread/{project_id}/source-pdf` 现在返回 inline disposition，浏览器不会把 PDF 当附件下载。

### 5. 校对页 bbox 已对齐真实 PDF.js 预览

`desktop/src/pages/ProofreadIssuesPage.tsx` 现在会用 PDF.js 把真实 PDF 页面渲染成图片，并把当前页的 `preview.pages[].blocks[].bbox` 转换到同一个 PDF.js viewport 下的像素坐标。

已完成的验收：

- `desktop/src/pages/ProofreadIssuesPage.test.tsx` 通过
- 浏览器真实页面验收通过：PDF.js data image、无 iframe fallback、bbox 像素定位
- Electron 真实窗口验收通过：PDF.js data image、无 iframe fallback、bbox 像素定位
- 仓库根目录可运行 `npm run verify:bbox` 一键覆盖上述回归

### 6. Electron 开发环境不再误连旧后端

`desktop/dev-runner.mjs` 现在会探测后端兼容性，不再盲目复用端口 8765 上的旧实例；遇到不兼容的旧服务会自动选用别的端口或拉起新后端。

## 当前真实状态

- 根文档已更新为 FastAPI + Electron 的当前实现
- 浏览器模式支持真实 PDF 上传
- mock 流程可稳定演示
- 真实流程已经打通到识别、元数据、校对、导出
- bbox 对齐已经有组件、浏览器、Electron 三层自动验收

## 仍要注意的点

### 1. 老项目/旧服务数据可能没有 layout 页块

如果某些旧项目的 `preview.pages` 为空，校对页虽然能显示 PDF，但不会画出 bbox。当前真实 MinerU 测试项目已确认 `preview.pages[].blocks[].bbox` 可用于像素级对齐。

### 2. 识别页状态文案仍然偏粗粒度

目前真实页只显示 queued / processing / completed / failed 的阶段状态，没有更细的页数级进度。

### 3. 质量检查仍保留独立路由

虽然产品上已经并入“导出”，但代码里 `/projects/:projectId/quality` 还在，后续如果要再收口，可考虑把它合并进导出页。

### 4. 少量测试仍会出现双斜杠警告

某些页面测试在未传 `projectId` 时会生成 `/projects//export` 的 React Router warning，这不是本次主流程阻塞项，但后续可以顺手清掉。

## 建议下一步

1. 用真实新项目验证后端返回的 `preview.pages` 是否完整
2. 让识别页显示更具体的阶段/页数进度
3. 决定是否把质量检查 UI 彻底折叠进导出页
4. 清理少量测试 warning 与旧文案
