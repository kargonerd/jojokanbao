# References

`references/` 保存迁移源项目中的外部参考工程或大体量上游代码，不参与当前 JOJO Platform 的 pnpm workspace、Turborepo 构建或部署。

- `jiuwen-folo-analysis/`：来自 `C:\Users\luoxixi\GAI\jojojiuwen\folo-analysis`，本身是 RSSNext/Folo 的完整上游工程归档，用于后续对照 RSS、移动端、桌面端能力。
- `legacy-rag-frontend/`：来自 `C:\Users\luoxixi\GAI\jojo-rag\frontend`，旧 Vue 前端归档。当前 RAG Web 模块在 `apps/web/src/rag`。
- `legacy-reader-web/`：来自 `C:\Users\luoxixi\WebstormProjects\web` 的旧 Vue reader 源码、主题、模板和 e2e/config 归档。当前 Archive 模块在 `apps/web/src/archive`，搜索服务在 `services/reader-search`，内部数据工作台在 `internal/data-workbench`。
- `legacy-press-root/`：来自 `C:\Users\luoxixi\GAI\jojo-press` 根目录中未归入正式桌面端或 engine 的旧 server/static/诊断脚本。当前统一桌面端在 `apps/desktop`，Press 后端 engine 在 `services/press-engine`。
- `legacy-jiuwen-root/`：来自 `C:\Users\luoxixi\GAI\jojojiuwen` 根目录的 docs、demo、docker 和辅助脚本归档。当前 Olds Web 模块在 `apps/web/src/olds`，移动端原型在 `apps/jiuwen-mobile`，API 在 `services/jiuwen-api`。
