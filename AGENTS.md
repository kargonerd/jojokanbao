# AGENTS.md

## 项目结构

- `frontend/`：所有用户界面及其共享 TypeScript/CSS 包。
- `agent/`：产品无关的 Node Agent 运行层与模型适配。
- `backend/`：统一 Python API 和尚未启用的业务模块。
- `tools/`：内部工作台和人工运维工具。
- `infrastructure/`：EdgeOne 与 Supabase 配置。
- `content/`：博客等内容。

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
- Web 应用外壳位于 `frontend/web/src/shell`，首页和资料库分别位于 `home`、`library`。
- 一级业务模块位于 `frontend/web/src/account`、`archive`、`rag`、`times`；不要再建立含混的 `platform` 目录。
- Archive 已上线，保持低风险演进。

## 后端约定

- 主 API 位于 `backend/src/app`，使用 FastAPI。
- 公共能力位于 `app/core`；业务按 `app/account`、`times` 分模块。
- JOJO Times（时事）尚未上线，默认不得加入公开路由或 EdgeOne 部署产物。
- RAG 由 `agent/` 承载，不在 Python 后端维护重复实现。
- Reader Search 位于 `infrastructure/tencent-scf/search`，保持现有 Flask/SCF 行为。
- EdgeOne 入口仅放在 `infrastructure/edgeone/functions`，不得包含业务逻辑。
- 定时、批处理和人工运维代码放入 `tools/`，不伪装成 API。
- Desktop 专属本地业务能力使用 TypeScript；Electron 主进程与 preload 入口位于 `frontend/desktop/electron`。
- 后端公共和 JOJO Times 依赖由 `backend/requirements*.txt` 管理。

## 运行配置约定

- 小型运行参数在 PostHog Remote config 编辑与回滚；前后端通过各自 SDK 读取同一份公开配置。配置 key、字段和部署步骤见 `docs/posthog.md`。
- 同一功能的参数归入同一份配置，新增参数优先复用已有 key、读取函数和 SDK 缓存。功能启用范围与运行参数的关系由业务明确规定，必须执行的限额始终生效。
- 客户端持久保存已验证配置，后台异步刷新；服务端保留进程内有效快照。读取端校验类型和范围，明确首次读取、断网、生效时机和异常行为。
- 安全策略由后端独立读取并执行。涉及数据库原子操作时，由受信任服务传入已验证参数，数据库继续执行身份、所有权、并发和参数边界检查。
- 配置只包含可公开的运行参数；密钥、用户计数、并发租约、任务状态和业务记录使用各自专用存储。
- 参数变更保留用户用量和业务状态。发布前核对部署目标的实际配置值，不用示例值覆盖线上配置。
- 设计与使用文档直接描述当前结构、行为和操作方法；接入过程、已删除开关和新旧设计对比放在 PR 记录中。

## Agent 约定

- Agent 是单一 `@jojo/agent` 包，通用运行层位于 `agent/src`，使用
  `pi-agent-core/Agent`，不使用
  `pi-coding-agent`，也不自行实现 Agent Loop。
- 当前接入 Codex OAuth 和 Antigravity OAuth，通过 `JOJO_AGENT_PROVIDER` 选择；
  其他模型后续通过 Makers Models 统一接入。
- EdgeOne 的认证、SSE 和加密凭证持久化位于 `agent/src/edgeone`。
- RAG、JOJO Times 等产品只注入提示词和业务工具。
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
