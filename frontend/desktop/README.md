# JOJO Desktop

`@jojo/desktop` 是 JOJO 桌面产品的 Electron 运行时。目前运行 Press 工作流，并为
Archive、Account、RAG 和 Olds 保留 renderer 模块位置。

当前目录边界：

- `electron/main.js`：唯一的 Electron 主进程入口；项目声明了 `"type": "module"`，
  因此普通 `.js` 即按 ESM 运行。
- `electron/preload.cjs`：唯一的 preload bridge；CommonJS 是 Electron sandbox
  preload 的运行时边界，不维护同名 TypeScript 或 ESM 副本。
- `e2e/`：Playwright 端到端测试。
- `tests/`：不依赖真实桌面运行时的应用级测试。
- `scripts/`：仅供 Desktop 本地开发使用的 Electron/TypeScript engine 启动器。
- `src/main.tsx`：统一 Desktop Shell 的 React renderer 入口。
- `src/shell/`：桌面首页和顶层模块路由。
- `src/press/`：当前可运行的 Press 页面、组件、路由和数据访问。
- `src/archive/`、`src/account/`、`src/rag/`、`src/olds/`：尚未接入的桌面模块占位目录。
- `src/electron.d.ts`：renderer 使用的 preload bridge 类型。
- `src/test-setup.ts`：renderer 测试环境配置。
- `engine/`：Press 使用的 Desktop 专属 TypeScript engine。

Engine 保持按运行职责拆分的扁平结构：

- `application.ts`：不依赖传输协议的业务命令入口。
- `project-repository.ts`：项目文档与识别状态的文件持久化。
- `mineru-service.ts`：MinerU 上传、轮询、产物保存和超长 PDF 分片。
- `export-service.ts`：Markdown、HTML、EPUB 和 jojo-rag 导出。
- `model.ts`、`validation.ts`：领域类型、清理规则和命令输入校验。

测试与实现文件同目录放置，方便确认每项本地引擎能力的覆盖范围。MinerU
原始压缩包和规范化后的 `content_list.json` 保存在项目 `artifacts/` 下；超过
600 页的 PDF 会按 300 页分片识别，并在合并时恢复原始页码。

Electron preload 只暴露系统 PDF 选择器、MinerU 设置接口和白名单 Engine 命令。Renderer
通过 IPC 调用 Worker 内的 `EngineApplication`，不启动 loopback HTTP
Server，也不向页面暴露 Node.js、`ipcRenderer` 或本地文件路径读取能力。
项目 PDF 预览通过受控的 `jojo-pdf://project/<id>` 协议读取，协议只能解析
项目仓储中已经登记的源 PDF。

MinerU 使用官方固定 API 地址。每位用户在工作台 `/settings` 中填写自己申请的
API Key；主进程使用 Electron `safeStorage` 加密后写入 `userData`，Renderer
只能查询“是否已配置”，无法读回明文。保存或清除后会立即同步到 Engine Worker，
不依赖 `.env`，也不需要重启应用。

开发模式先编译 engine，再由 `scripts/dev-runner.js` 启动 Vite 和
Electron；生产构建同样将 engine 编译到 `dist/engine/`，由 Electron 主进程
启动独立 Worker 加载，避免 PDF 分片和压缩阻塞窗口线程。项目和导出数据写入
Electron `userData/press`，不会写入应用安装目录。

Desktop 顶层路由：

- `/`：统一工作台。
- `/press/*`：当前已启用的 Press。
- `/settings`：MinerU API Key 等本机设置。
- `/archive/*`、`/account/*`、`/rag/*`、`/olds/*`：已保留模块边界，
  目前只显示“尚未启用”，不加载业务代码。

## 本地开发

```bash
pnpm --filter @jojo/desktop dev
pnpm --filter @jojo/desktop dev:electron
pnpm --filter @jojo/desktop typecheck
pnpm --filter @jojo/desktop test
pnpm --filter @jojo/desktop test:e2e
pnpm --filter @jojo/desktop build
```
