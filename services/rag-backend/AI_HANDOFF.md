# AI Handoff

本文件用于帮助后续接手 `jojo-rag` 的 AI 快速理解当前边界与约束。

## 当前定位

`jojo-rag` 当前聚焦三条主线：

- 账号管理
- 文库 / source 管理
- 阅读与问答

扫描版 PDF 的 OCR、结构化制书、人工校对与导出链路不应继续在本仓库内扩张，应交由独立项目承接。

## 当前前端主流程

当前保留的页面只有：

- `frontend/src/views/ChatView.vue`
- `frontend/src/views/BookReader.vue`
- `frontend/src/views/AdminView.vue`
- `frontend/src/views/AdminAccounts.vue`
- `frontend/src/views/AdminLibraries.vue`
- `frontend/src/views/AdminLibraryEditor.vue`
- `frontend/src/views/AdminSourceEditor.vue`

对应主路由：

- `/chat`
- `/source/:notebookId/:sourceId`
- `/admin/**`

旧公开首页、旧图谱页和旧 demo 页面已经不应再作为产品范围的一部分。

## 关键实现点

- `frontend/src/composables/useChat.ts` 会直接打开 `/source/:notebookId/:sourceId`，说明阅读器仍是当前主流程的一部分。
- `frontend/src/views/BookReader.vue` 依赖 catalog 文档、人物、时间线、关系接口。
- `frontend/src/api/index.ts` 里的 catalog analysis API 需要与阅读器保持一致。
- 管理后台围绕 notebook / source 的编辑与发布配置展开。
- source 现在有两条内容接入路径：Markdown 直传与结构化导入包导入；导入包规范见 `docs/import-package/jojo-press-import-package-spec.md`。

## 当前工作树注意事项

当前仓库长期不是干净工作树，处理改动时必须增量阅读后再改，不要粗暴回退。

因此：

- 不要执行 `git reset --hard`
- 不要批量撤销未确认修改
- 删除文件前先确认仍无主流程引用
- 不要把调试截图、临时日志、静态调试 HTML、抓包文本重新放回仓库根目录

## 项目方向约束

- 本仓库优先做已校对文档的导入、管理、阅读和问答消费。
- 如果涉及 `jojo-press` 对接，优先遵循现有 zip 导入包规范与 source 边界，不要直接把制书内部中间态暴露给阅读器。
- 不要再把一次性原型页、旧展示页和旧路线图重新挂回前端入口。
- 文档应只描述当前仍存在的页面、接口和流程，不保留历史实现说明。

## 外部关联

如果任务涉及扫描版 PDF 制书能力，优先转去 `jojo-press`，不要继续在本仓库里扩张该链路。
