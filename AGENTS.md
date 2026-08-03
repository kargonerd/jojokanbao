# AGENTS.md

## 项目结构

- `frontend/`：所有用户界面及其共享 TypeScript/CSS 包。
- `agent/`：产品无关的 Node Agent 运行层与模型适配。
- `backend/`：统一 Python API 和尚未启用的业务模块。
- `tools/`：内部工作台和人工运维工具。
- `infrastructure/`：EdgeOne 与 Supabase 配置。
- `content/`：博客等内容。
- `vendor/`、`references/`：不参与产品构建的第三方或历史参考代码。

## 常用命令

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
pnpm dev:backend
pnpm test:backend
```

## 前端约定

- React 19、TypeScript strict、函数组件和 hooks。
- 状态管理使用 Zustand。
- 测试使用 Vitest 和 Testing Library。
- `frontend/packages/ui` 同时提供 React 组件和 `@jojo/ui/styles` CSS 设计系统。
- Web 一级业务模块位于 `frontend/web/src/account`、`archive`、`rag`、`olds`。
- Archive 已上线，保持低风险演进。

## 后端约定

- 主 API 位于 `backend/src/app`，使用 FastAPI。
- 公共能力位于 `app/core`；业务按 `app/account`、`olds`、`rag` 分模块。
- Olds 和 RAG 尚未上线，默认不得加入公开路由或 EdgeOne 部署产物。
- Reader Search 位于 `infrastructure/tencent-scf/search`，保持现有 Flask/SCF 行为。
- EdgeOne 入口仅放在 `infrastructure/edgeone/functions`，不得包含业务逻辑。
- 定时、批处理和人工运维代码放入 `tools/`，不伪装成 API。
- Desktop 专属本地能力使用 TypeScript，位于 `frontend/desktop/engine`。
- 后端公共、Olds 和 RAG 依赖分别由 `backend/requirements*.txt` 管理。

## Agent 约定

- 通用 Agent 运行层位于 `agent/runtime`，使用 `pi-agent-core/Agent`，不使用
  `pi-coding-agent`，也不自行实现 Agent Loop。
- 当前只接入 Codex OAuth；其他模型后续通过 Makers Models 统一接入。
- EdgeOne 的认证、SSE 和加密凭证持久化位于 `agent/edgeone`。
- RAG、Olds 等产品只注入提示词和业务工具。
- Codex Makers Agent 只部署到不含中国大陆的独立项目；入口仅放在
  `infrastructure/edgeone/agents`，不承载业务逻辑。

## 设计系统

- 主色：`--color-red: #8b1a1a`
- 文字：`--color-ink: #202020`
- 背景：`--color-paper: #fff`
- 字体：Noto Serif SC
- 全局零圆角
- hover：`translateY(-2px)` 与红色硬阴影

```tsx
import { Button, Card } from "@jojo/ui";
```

```css
@import "@jojo/ui/styles";
```
