# References

`references/` 保存迁移源项目中的外部参考工程或大体量上游代码，不参与当前 JOJO Platform 的 pnpm workspace、Turborepo 构建或部署。

- `jiuwen-folo-analysis/`：来自 `C:\Users\luoxixi\GAI\jojojiuwen\folo-analysis`，本身是 RSSNext/Folo 的完整上游工程归档，用于后续对照 RSS、移动端、桌面端能力。
- `legacy-rag-frontend/`：来自 `C:\Users\luoxixi\GAI\jojo-rag\frontend`，旧 Vue 前端归档。当前可运行 RAG 前端在 `apps/rag`。
- `legacy-reader-web/`：来自 `C:\Users\luoxixi\WebstormProjects\web` 的旧 Vue reader 源码、主题、模板和 e2e/config 归档。当前可运行 reader 在 `apps/reader`，搜索服务在 `services/reader-search`，批处理工具在 `services/jojo-pipe`。
- `legacy-press-root/`：来自 `C:\Users\luoxixi\GAI\jojo-press` 根目录中未归入正式桌面端或 engine 的旧 server/static/诊断脚本。当前可运行 Press 桌面端在 `apps/press`，后端 engine 在 `services/press-engine`。
- `legacy-jiuwen-root/`：来自 `C:\Users\luoxixi\GAI\jojojiuwen` 根目录的 docs、demo、docker 和辅助脚本归档。当前可运行 Jiuwen Web 在 `apps/jiuwen-web`，移动端在 `apps/jiuwen-mobile`，API 在 `services/jiuwen-api`。
