# JOJO Platform Feature Flag 设计

状态：首版实现，等待 review 和数据库迁移；未部署到线上。

## 1. 架构

Supabase Postgres 是唯一配置源。每个 Feature Flag 在数据库中只保存一条有序规则链；不按用户保存开关结果。

```text
                         Supabase
                    rules / revision / history
                       ↙                 ↘
Web 直接调用 get_my_feature_flags       Cloud Function 读取 rag.workspace
控制导航、页面和按钮                     拒绝未开放的 RAG 请求
                                              ↓
                                         Makers Agent
```

Web 直接调用 Supabase，不增加一次 Cloud Function 请求。浏览器只得到当前访问者的布尔结果，不会得到白名单、比例、盐或完整规则。

Cloud Function 只在用户真正发送 RAG 请求时运行。它不能信任前端的结果，所以会再次验证 Supabase 用户 Token，并读取、计算同一个 `rag.workspace`。关闭时在调用 Agent 和模型前返回 403。

FastAPI 当前不在 RAG 请求链路里，因此不承担 Feature Flag 查询或校验，也不保留通用 Flag 依赖。

## 2. 数据模型

`private.feature_flags` 每个 Flag 一行：

| 字段 | 含义 |
| --- | --- |
| `key` | 稳定键，例如 `rag.workspace` |
| `description` | 管理说明 |
| `rules jsonb` | 按执行顺序保存完整规则链，用户集合也在规则内 |
| `revision bigint` | 只增不减的乐观锁版本 |
| `history jsonb` | 每次发布后的完整快照、原因、请求 ID 和时间 |
| `updated_at` | 最后修改时间 |

不拆 Feature、规则和规则用户三张表。发布时原子替换整份 `rules` 文档。

规则字段包括：

- `id`、`name`
- `conditionType`：`users`、`percentage`、`authenticated`、`global`
- `serve`：命中后 ON 或 OFF
- `percentage`：整数 `1..100`
- `bucketBy`、`bucketSalt`
- `startsAt`、`endsAt`
- `enabled`、`isFallback`
- `userIds`

`revision` 用于防止旧页面覆盖新修改。回滚不是把 revision 倒退，而是把历史快照重新发布成一个新 revision，因此回滚操作本身也有记录。

## 3. 判定规则

规则严格从上到下执行，命中第一条后立即返回：

```text
rag.workspace
1. 指定测试用户       → ON
2. 登录用户 20%       → ON
3. 默认               → OFF
```

每个 Flag 必须有且只有一个最终 `global` fallback，并放在最后。白名单能否越过普通关闭完全由顺序决定。需要紧急全关时，在第一位放一条 `global → OFF`，不使用额外的 `emergency_disabled` 字段。

规则暂停、未到开始时间或已经过期时跳过。Flag 不存在、规则损坏、Supabase 不可用或没有得到结果时统一关闭。

百分比分桶按 Flag、规则和用户稳定计算。高成本能力只允许按已登录用户分桶；匿名 visitor ID 不作为权限依据。

## 4. 数据库接口

Web 使用：

```sql
public.get_my_feature_flags(p_keys text[], p_visitor_id uuid default null)
returns table(flag_key text, enabled boolean, revision bigint)
```

这个 RPC 根据当前 Supabase 登录身份计算布尔结果，不返回规则原文。

RLS 使用：

```sql
public.feature_enabled(p_key text)
returns boolean
```

例如书架除了校验 `auth.uid() = user_id`，还校验 `feature_enabled('library.bookshelf')`。前端隐藏按钮不能代替 RLS。

本地 JOJO 管理台使用现有 `JOJO_OPERATOR_TOKEN` 调用：

- `operator_list_feature_flags`
- `operator_get_feature_flag`
- `operator_publish_feature_flag`
- `operator_rollback_feature_flag`
- `operator_search_feature_users`

数据库只保存 Operator Token 的 SHA-256 摘要。Token 由本机 Flask API 从根目录 `.env` 读取，不进入浏览器、Vite 变量或响应体。`SUPABASE_ACCESS_TOKEN` 不参与该功能。

Cloud Function 使用 `operator_get_feature_flag` 读取 `rag.workspace` 原始规则并在函数内判定。Operator Token 只存在服务端环境中。

## 5. Web

Zustand store 一次向 Supabase 批量查询当前页面需要的 Flag：

```ts
type FeatureFlagKey =
  | "library.bookshelf"
  | "reader.annotations"
  | "rag.workspace";
```

- 登录、退出和 Token 刷新时重新查询。
- 查询失败时默认全部关闭。
- 只在内存保存当前用户结果；退出后立即清空。
- `FeatureRoute` 控制路由，`useFeatureFlag` 控制导航和按钮。
- 前端不读取或计算规则，也不把布尔结果当作安全凭证。

## 6. RAG 强制校验

RAG 页面和 RAG 请求统一使用一个 Flag：`rag.workspace`，不再另设 `agent.chat`。

```text
浏览器 POST /gateway/ask
  → Cloud Function 验证 Supabase Bearer Token
  → 读取 rag.workspace 规则
  → 按顺序计算当前用户结果
  → ON：添加服务签名并转发 Makers Agent
  → OFF：返回 403，不调用 Agent 或模型
```

配置缺失、损坏或 Supabase 不可用时 fail closed。Agent 自己未来若需要 Prompt、模型或工具实验，可以有独立的内部开关，但不复用平台入口 Flag。

## 7. 首批 Flag

| Flag | 初始规则链 | 控制范围 |
| --- | --- | --- |
| `library.bookshelf` | `authenticated → ON`，`global → OFF` | 登录书架和对应 RLS |
| `reader.annotations` | `authenticated → ON`，`global → OFF` | 划线、想法、AI 解释写入和对应 RLS |
| `rag.workspace` | `users(空) → ON`，`global → OFF` | RAG 页面和真实请求 |

首页、资料库、搜索、关于、登录、基础阅读和 RAG 路由随新版 Web 一起构建，不再维护
账号或 RAG 的独立构建开关。`rag.workspace` 是唯一的 RAG 功能权限开关；Times 仍使用
`VITE_ENABLE_TIMES` 构建开关，不依赖 Supabase 运行时配置。

## 8. 管理台与测试

“JOJO 管理台”位于 `tools/jojo-admin`，本地通过 `pnpm dev:admin` 启动。功能开关页面支持规则增删、暂停、排序、时间窗、整数百分比、发布原因、revision 冲突提示、修改记录和一键回滚。

测试覆盖：

- 数据库 first-match、1%/100%、稳定分桶、时间窗、fallback、历史和回滚。
- RLS 拒绝未开放的书架和批注读写。
- Web 登录切换不复用上一用户结果，关闭时隐藏入口并拦截路由。
- Cloud Function 在转发 Agent 前按 `rag.workspace` 拦截。
- 管理发布、revision 冲突、回滚和首位全局关闭。

所有迁移和部署在 PR review 通过前都不执行。
