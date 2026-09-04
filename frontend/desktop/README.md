# JOJO看报 Desktop

`@jojo/desktop` 是 JOJO看报新版 Web 体验的 Electron 客户端。Renderer 直接复用 Web 的
`AppLayout`、`AppHeader`、首页、资料库、搜索、报刊/书籍阅读器、AI 和 Account；
旧版 Archive 首页、暂时关闭的 JOJO Times（时事）与尚待重做的 Press 不进入桌面导航或 renderer 构建。

当前目录边界：

- `electron/main.js`：唯一的 Electron 主进程入口；项目声明了 `"type": "module"`，
  因此普通 `.js` 即按 ESM 运行。
- `electron/preload.cjs`：唯一的 preload bridge；CommonJS 是 Electron sandbox
  preload 的运行时边界，不维护同名 TypeScript 或 ESM 副本。
- `e2e/`：Playwright 端到端测试。
- `tests/`：不依赖真实桌面运行时的应用级测试。
- `scripts/`：仅供 Desktop 本地开发使用的 Electron/TypeScript engine 启动器。
- `src/main.tsx`：统一 Desktop Shell 的 React renderer 入口。
- `src/shell/`：桌面运行时适配和顶层模块路由，不实现第二套 UI 框架。
- `src/press/`：暂未启用的 Press 源码，当前不会进入路由或 renderer 构建。
- `../web/src/desktop.ts`：从新版 Web 向 Desktop 暴露的稳定模块入口。
- `../web/src/desktop.css`：完整的跨运行时样式入口，统一加载 UI token、基础控件样式，
  并为 Web 业务模块生成 Tailwind utilities；Desktop 不单独复制页面样式。
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

Press 的 engine、页面与测试代码暂时保留，供下一轮体验重做；当前生产构建不会注册
Press 路由、菜单和快捷键，也不会暴露 PDF 选择、MinerU 或 Engine IPC，不会启动 Worker
或打包其 renderer 资源。Renderer 始终无法访问 Node.js、`ipcRenderer` 或任意本地文件路径。

Desktop 顶层路由：

- `/`：今日阅读工作台。
- `/library`、`/archive/*`、`/book/*`：与 Web 共用的报刊/书籍资料库和阅读器。
- `/search`：与 Web 共用的报刊正文搜索。
- `/rag/*`：AI，仅登录读者可见、可访问。
- `/times/*`：JOJO Times 时事时间线、新闻阅读和随文 AI，仅登录读者可见、可访问。
- `/notifications`：与 Web 共用的站内通知信箱。
- `/account`、`/account/times-sources`：登录、注册、账号中心、书架同步和时事阅读偏好；未配置 Supabase 时显示可操作的配置提示。

生产环境从 `dist/index.html` 以 hash 路由启动，开发环境使用 browser 路由。主进程启用
`contextIsolation` 和 sandbox，禁用 renderer 的 Node.js，并拒绝页面权限请求；外部链接
交由系统浏览器打开。Web 的共享 Header 同时作为窗口拖拽区，Windows/Linux 使用原生
Window Controls Overlay 把最小化、最大化和关闭按钮融入同一栏；应用菜单默认隐藏，
按 `Alt` 可临时调出，已有快捷键保持有效。窗口会记忆正常尺寸、位置和最大化状态，
显示器变化后会自动回退到安全位置；可编辑区域使用系统原生右键菜单。
系统托盘复用 JOJO 品牌图标。首次点击窗口关闭按钮时会用简洁的应用内设置框选择
最小化到托盘或直接退出；选择写入本机偏好，后续关闭直接执行，不再重复询问。用户可在
`/settings`、标题栏右侧调节图标、应用菜单或托盘菜单重新进入设置并改为每次询问，也可设置是否开机启动。
设置不占用主导航频道，页面使用紧凑的桌面偏好列表。
首页、资料库、搜索、AI、时事、通知、关于、账号与阅读器均直接复用 Web 运行时；桌面端只维护窗口与系统能力。
Web 与桌面端通过 `@jojo/pdf-viewer/vite` 共用 PDF.js 字体、CMap 与 WASM 打包清单。
单击托盘图标可恢复窗口。

打包版从 `file://` 运行，不能使用 Web 的同源 `/gateway/*`。桌面构建会把馆藏 AI 与
时事随文解释请求交给 `jojo-agent://reader`；主进程只允许 `/gateway/ask` 和
`/gateway/times/explain` 两个路径，并通过 Chromium 网络栈流式转发到当前承载新版 Web 的
`https://beta.jojokanbao.cn` Reader 网关。其余路径、
请求头和响应头不会透传，renderer 仍保持 sandbox、无 Node.js 与无 `ipcRenderer` 访问。
Windows 开发窗口、任务栏、托盘与 NSIS 包统一使用 `electron/assets/icon.ico`；该文件包含
16、20、24、32、40、48、64、128、256 像素表示，避免高 DPI 托盘把单张 16px 图标二次放大。

## 本地开发

```bash
pnpm --filter @jojo/desktop dev
pnpm --filter @jojo/desktop dev:electron
pnpm --filter @jojo/desktop typecheck
pnpm --filter @jojo/desktop test
pnpm --filter @jojo/desktop test:e2e
pnpm --filter @jojo/desktop test:electron
pnpm --filter @jojo/desktop build
pnpm --filter @jojo/desktop run pack
pnpm --filter @jojo/desktop dist:win
pnpm --filter @jojo/desktop dist:mac
pnpm --filter @jojo/desktop dist:linux
```

`pack` 生成可直接运行的 `release/win-unpacked/jojo-kanbao.exe`；`dist:win` 生成 NSIS
安装包，macOS 生成 DMG/ZIP，Linux 生成 AppImage/DEB。产物都写入被 Git 忽略的
`release/`。推送与 `package.json` 版本匹配的 `desktop-v*` tag 会自动构建三平台产物并
发布 GitHub Release；首个版本使用 `desktop-v0.0.1`。发行工作流不接受带 `-rc`、`-beta`
等预发布后缀的版本。

当前自动构建默认不签名，适合 RC 验证。正式对外发布前应配置 Windows 代码签名和
Apple Developer ID/notarization，避免 SmartScreen 或 Gatekeeper 安全提示。
