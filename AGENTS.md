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

- `auth.signup`、`reader.annotations`、`ai.usage_limits`、`ops.email_quota` 参数在 PostHog Remote config 管理，`private.feature_flags.config` 是服务端缓存和审计存储。同步由 `tools/posthog` 执行；管理台按 `configProvider` 只读展示。QQ群号使用公开的 `support_config`。部署步骤见 `docs/posthog.md`。
- 新增配置前，先查找并复用已有配置文档、存储、读取函数和管理入口。限额、阈值、超时等少量运行参数优先扩展 PostHog Remote config，服务端读取复用 `private.feature_flags.config` 缓存，不为一组参数单独建立 `*_settings` 或 `*_policy` 表。
- 同一功能的参数归入同一份配置；独立功能可新增有明确业务含义的 key。功能启用范围与运行参数的关系由业务明确规定；必须执行的限额始终生效。
- 参数修改与回滚在 PostHog 完成，JOJO 管理台展示服务端实际值、同步时间和历史。同步复用 Operator 鉴权、版本冲突检查和审计发布，保留未修改的规则与配置字段。
- 写入端校验参数类型和范围，读取端明确默认值、边界及生效时机。配置表不存密钥，也不存用户计数、并发租约、任务状态等运行数据；后者使用各自的状态存储。
- 合并旧配置时用新迁移保留线上实际值，不用默认值覆盖；保持业务状态和历史，切换读取路径后再删除冗余表。确需独立配置表时，在 PR 中说明现有机制无法满足的具体需求。
- 具体边界、现有配置示例和接入步骤见 [运行配置复用](infrastructure/supabase/README.md#runtime-configuration-reuse)。
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
