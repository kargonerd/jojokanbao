# JOJO Platform Feature Flag 设计

状态：首版实现，等待 review 和数据库迁移；未部署到线上。

## 1. 要解决的问题

JOJO 目前的 `frontend/web/src/rollout.ts` 只在构建时读取 `VITE_ENABLE_*`，只能做到“这一版构建开或关”。它不能动态调整比例、不能指定读者，也不能阻止用户绕过前端直接请求后端或 Supabase。

新系统需要同时满足：

- 运行时开关，不重新构建 Web 即可调整。
- 支持 `1%` 到 `100%`、最小步进 1% 的稳定灰度；不开放时直接不配置百分比规则。
- 每个 Flag 支持多条有序规则，例如“指定用户开启 → 20% 用户开启 → 全局关闭”。
- 前端只负责体验和路由，FastAPI、EdgeOne Cloud Function 与 Supabase RLS/RPC 负责真正的权限边界。
- 所有修改可追溯、可回滚，并有紧急全关能力。
- Flag 不代替登录、角色和数据权限。

## 2. 核心决策

### 2.1 一个配置源，两层执行

Supabase Postgres 是唯一配置源和唯一判定算法所在地。前端不下载原始百分比和白名单，只获取针对当前访问者已经计算好的布尔结果。

```text
                       private.feature_flags
                    /  rules JSONB / history JSONB / operator digest
                   v
Web ── GET /v1/features/evaluations ── FastAPI
 │                                           │
 │ 只控制可见性、路由、交互                  │ require_feature(...)
 │                                           v
 ├── Supabase 直连写入 ─────────────── RLS + feature_enabled(...)
 │
 └── Agent 请求 ── Cloud Function 检查 Flag ──▶ Makers Agent
```

这意味着前端即使被篡改，也只能显示入口，不能越过后端或 RLS 使用未开放能力。

### 2.2 按 Supabase 项目隔离环境

生产、预览和本地应使用不同 Supabase 项目/实例，不在同一张表里依赖客户端传入的 `environment`。原因是浏览器直连 Supabase 时，客户端声明的环境不可信，RLS 也无法可靠知道请求来自哪个 Web 部署。

### 2.3 百分比不是权限

百分比分流只决定能力是否可用。需要登录的 Flag 仍必须先登录；管理员能力仍必须检查管理员角色；资源所有权仍由原 RLS 控制。

## 3. Flag 模型

### 3.1 `private.feature_flags`

| 字段 | 含义 |
| --- | --- |
| `key text primary key` | 稳定键，例如 `library.bookshelf` |
| `description text` | 面向维护者的说明 |
| `rules jsonb` | 按数组顺序保存整条规则链，用户集合也属于对应规则 |
| `revision bigint` | 乐观锁版本，每次修改递增 |
| `history jsonb` | 每次发布后的完整规则快照、revision、原因、请求 ID 和时间 |
| `updated_at timestamptz` | 最后修改时间 |

每个 Flag 只占一行。规则、白名单和修改历史不再拆成关联表；管理台每次原子发布完整 JSONB 规则文档。

### 3.2 `rules` 文档

| 规则字段 | 含义 |
| --- | --- |
| `id uuid` | 稳定的规则 ID |
| `name text` | 例如“内部测试用户”“20% 灰度”“默认关闭” |
| `conditionType text` | `users`、`percentage`、`authenticated` 或 `global` |
| `serve boolean` | 命中后返回开启或关闭 |
| `percentage int` | 百分比规则专用，只允许整数 `1..100` |
| `bucketBy text` | `user` 或 `visitor`；高成本能力只能使用 `user` |
| `bucketSalt uuid` | 每条百分比规则独立的稳定分桶盐 |
| `startsAt / endsAt timestamptz` | 规则的可选生效窗口 |
| `enabled boolean` | 暂停一条规则而不删除 |
| `isFallback boolean` | 标记唯一的最终默认规则 |
| `userIds uuid[]` | `users` 规则的成员；不使用易变邮箱 |

数组顺序就是判定顺序。每个 Flag 必须有且只有一条 `conditionType = global`、`isFallback = true` 的最终规则，而且它必须排在最后。普通全开、全关和事故止血都用规则表达；需要立即关闭所有人时，在第一位启用 `global → OFF`。

### 3.3 revision 与回滚

`revision` 是只增不减的乐观锁版本，不是修改内容本身。管理台按 revision 读取后提交；若数据库已进入更高 revision，旧页面的写入被拒绝，防止覆盖别人刚发布的配置。

`history` 保存每次成功发布后的完整规则快照。回滚会选择旧快照并重新发布为一个新 revision，不会倒退或删除历史，因此回滚操作本身也可以再次回滚。

### 3.4 Operator

- `private.feature_flag_operator_secret`：只保存现有 `JOJO_OPERATOR_TOKEN` 的 SHA-256 摘要，不保存明文。
- 私有表不给 `anon`、`authenticated` 直接授权；只允许受控的 `security definer` RPC 访问，并固定 `search_path = ''`。

## 4. 判定规则

正常判定严格按 `rules` 数组顺序从上到下检查，跳过已暂停或不在时间窗内的规则，命中第一条后返回该规则的 `serve`，不再继续。不存在规则之外的特殊优先级。

用户提出的典型配置会直接表示成：

```text
Flag: rag.workspace

1. [users]      内部测试用户          → ON
2. [percentage] 登录用户 20%          → ON
3. [global]     默认                  → OFF  (fallback)
```

如果希望测试人员在普通关闭状态下仍可使用，就把白名单规则放在普通全局关闭规则之前。线上事故需要所有人立刻关闭时，把一条启用的 `global → OFF` 放在规则链第一位。

各条件的匹配方式：

- `users`：当前登录用户在该规则的用户集合中。
- `percentage`：有对应分桶主体，且稳定桶小于配置比例。
- `authenticated`：存在有效登录用户。
- `global`：始终匹配。

Flag 不存在、规则配置损坏或没有得到结果时统一关闭。正常配置由于强制存在最终 `global` fallback，不会走到隐式默认值。

稳定桶使用数据库 `pgcrypto.digest`：

```text
subject = 登录用户时 "user:<auth.uid()>"
          匿名用户时 "visitor:<server-validated visitor uuid>"
bucket  = uint32(sha256(flag_key + rule_id + bucket_salt + subject)) mod 100
matched = bucket < percentage
```

调整 10% → 20% 时，原 10% 用户仍在开启组，只新增下一段用户。首版管理界面始终保留已有 `bucket_salt`，不提供重新洗牌入口。

匿名 visitor ID 可以被高级用户更换，因此不能用于权限或高成本能力。Agent、书架、批注等能力的百分比规则只允许 `bucket_by = user`，并以最终 `global → OFF` 兜底。

## 5. 数据库接口与 RLS

### 5.1 只读判定 RPC

```sql
public.get_my_feature_flags(p_keys text[], p_visitor_id uuid default null)
returns table(flag_key text, enabled boolean, revision bigint)

public.feature_enabled(p_key text)
returns boolean
```

`get_my_feature_flags` 用于 Web/FastAPI 获取批量结果；`feature_enabled` 用于 RLS。两者调用同一个私有判定函数，避免多套算法。

返回值不包含规则、百分比、盐、用户集合、管理员信息或其他用户标识。

### 5.2 直连 Supabase 的强制校验

例如书架策略应从：

```sql
auth.uid() = user_id
```

收紧为：

```sql
auth.uid() = user_id
and public.feature_enabled('library.bookshelf')
```

SELECT、INSERT、UPDATE、DELETE 都要覆盖。不能只在 React 按钮或 `readerData.ts` 里判断。

本机 Operator RPC 包括：

- `operator_list_feature_flags(operator_token)`
- `operator_publish_feature_flag(operator_token, key, rules, expected_revision, reason, request_id)`：在一个事务中校验并发布整条规则链、递增 revision 并追加历史。
- `operator_rollback_feature_flag(operator_token, key, target_revision, expected_revision, request_id)`：把历史快照重新发布为新 revision。
- `operator_search_feature_users(operator_token, query)`：只返回管理界面需要的最少字段。

每个 Operator RPC 都在数据库内对令牌做 SHA-256 摘要比对，写入使用 `expected_revision` 防止覆盖较新的配置。`SUPABASE_ACCESS_TOKEN` 不参与此功能。

## 6. FastAPI 设计

新增 `backend/src/app/features/`：

```text
features/
  models.py       # API 响应和管理请求
  repository.py   # 调 Supabase RPC
  service.py      # 批量判定、短缓存、错误策略
  dependencies.py # require_feature("...")
  router.py       # /features/evaluations 与 /admin/feature-flags
```

公共读取接口：

```http
GET /v1/features/evaluations?keys=library.bookshelf,agent.chat
Authorization: Bearer <optional>
X-JOJO-Visitor-ID: <uuid, optional>
```

```json
{
  "revision": "43",
  "flags": {
    "library.bookshelf": false,
    "agent.chat": true
  },
  "expiresAt": "2026-08-14T14:01:00Z"
}
```

响应使用 `Cache-Control: private, max-age=30` 和 ETag，绝不允许 CDN 在用户间共享缓存。服务内部可以短暂缓存规则链；用户最终判定不跨用户缓存。

受控 API 使用依赖：

```python
@router.post("/example", dependencies=[Depends(require_feature("example.action"))])
```

关闭时返回 `403` 和稳定错误码 `feature_not_available`。认证、Flag、业务权限的顺序是：认证 → Flag → 资源权限 → 业务操作。

Supabase 暂时不可用时：新能力默认关闭；已经不受 Flag 控制的首页、资料库和阅读基础能力继续工作。管理写入失败时不做本地假成功。

## 7. Agent 网关设计

`/gateway/ask` Cloud Function 是浏览器访问 Agent 的平台网关，不能相信 Web 已经隐藏入口。请求顺序为：

```text
检查 agent.chat → 添加服务签名 → Makers Agent 验证服务签名与用户身份 → 初始化模型 → 执行请求
```

这样未进入灰度组的请求不会到达 Makers Agent、不会初始化模型或消耗 token。Cloud Function 使用当前用户 Bearer Token 调同一 Supabase 判定 RPC；超时或判定服务不可用时 fail closed。Makers Agent 只处理自己的运行配置，未来的 Prompt、模型或工具实验使用独立的 Agent 内部开关，不复用平台入口 Flag。

## 8. Web 前端设计

新增 Zustand `featureFlagStore`，不引入 React Context：

```ts
type FeatureFlagKey =
  | "library.bookshelf"
  | "reader.annotations"
  | "agent.chat"
  | "rag.workspace"
  | "olds.workspace";

useFeatureFlag("library.bookshelf");
```

行为约定：

- 等账号状态初始化后，一次批量请求当前 Web 需要的 Flag。
- 登录、退出和 token 刷新时重新拉取；前台停留超过 60 秒后回到页面也重新验证。
- 首次加载或请求失败时，所有新 Flag 默认关闭，入口用骨架或不显示，避免先闪现再消失。
- 只在内存中保存当前用户判定；退出立即清空，避免把白名单结果带给下一位用户。
- `FeatureRoute` 控制路由，`useFeatureFlag` 控制导航和按钮，但 API 错误仍按后端结果处理。
- 收到 `feature_not_available` 后按不可用处理；下一次短周期刷新会同步最新结果。

前端不自行计算 hash，不读取白名单，也不把 Flag 结果当作安全凭证。

## 9. JOJO 管理台

现有 “JOJO Data Workbench / 数据工作台” 对外改名为“JOJO 管理台”，因为它将同时承担内容、索引和运行控制。首版只修改产品标题、页面文案和导航信息架构；目录 `tools/data-workbench`、包名 `@jojo/data-workbench` 及开发命令暂时保留，避免无关的工程迁移扩大风险。

新增“功能开关”一级页面。管理台仅供本机使用，不再增加一套网页登录和角色：浏览器调用同源 Flask API，Flask 从根目录 `.env` 读取已有 `JOJO_OPERATOR_TOKEN` 并调用受保护的 Supabase RPC。令牌不进入 Vite 环境变量、浏览器存储或响应体。

列表页显示 Flag、规则数和 revision；编辑页同时显示描述、最后更新时间与 revision，并采用一条从上到下的红色判定轨道。每张规则卡的序号就是实际执行顺序：

- 支持新增、编辑、暂停、删除和上下重排 `users`、`percentage`、`authenticated`、`global` 规则。
- 每条规则都明确显示“命中时 ON/OFF”，不使用隐藏优先级。
- `users` 规则按读者代号、用户 UUID 或精确邮箱搜索后添加。
- 百分比只允许整数，最小步进为 1%。
- 每条规则可配置开始/结束时间；最终 fallback 固定在末尾，不允许删除或拖走。
- 页面提供 revision 修改记录，可将旧快照一键回滚为新 revision。
- 保存时一次发布完整规则链并要求填写原因；revision 冲突时禁止覆盖并要求刷新。

Flask 只监听 `127.0.0.1`。数据库只保存 Operator Token 摘要，私有配置表仍不向浏览器角色开放。

## 10. 首批 Flag 与迁移

| Flag | 初始规则链 | 替代对象 |
| --- | --- | --- |
| `library.bookshelf` | `authenticated → ON`，`global → OFF` | 新书架能力及其 RLS |
| `reader.annotations` | `authenticated → ON`，`global → OFF` | 划线、想法、AI 解释写入 |
| `agent.chat` | `users(空) → ON`，`global → OFF` | Agent 模型入口和请求；开始灰度时再插入至少 1% 的规则 |
| `rag.workspace` | `users(空) → ON`，`global → OFF` | 当前 `VITE_ENABLE_RAG`；开始灰度时再插入至少 1% 的规则 |
| `olds.workspace` | `global → OFF` | 当前 `VITE_ENABLE_OLDS`；旧闻完成前不开放任何前后端入口 |

首页、资料库、搜索、关于、登录和基础阅读不放进首批 Flag，避免控制面故障导致整个产品不可用。`VITE_ENABLE_RAG` 只在运行时系统稳定后移除；迁移期取更严格结果：构建期开关和运行时 Flag 必须同时为 true。旧闻尚未完成，`VITE_ENABLE_OLDS=false` 与 `olds.workspace=off` 同时保留，路由、导航和后端入口整体关闭，暂不拆分读取、互动或 AI 子 Flag。

## 11. 测试与可观测性

数据库 pgTAP 必测：

- 1% 与 100% 的边界正确，数据库拒绝小于 1% 或非整数比例。
- 同一用户跨请求稳定，扩大比例不踢出旧用户。
- 严格 first-match-wins，规则重排会立即改变结果，暂停与时间窗会正确跳过。
- 用户集合成员、未登录、未知 key、删除用户和最终 fallback 的行为。
- RLS 对 SELECT 与全部写操作都确实拒绝未开放用户。
- 普通用户无法读取配置、白名单和历史，也不能调用管理 RPC。

应用层必测：

- FastAPI 依赖在业务处理前拦截，错误码稳定，ETag/Vary/Cache-Control 正确。
- EdgeOne Cloud Function 在转发到 Agent 前拦截。
- Web 登录切换不复用上一用户结果；关闭时无入口且直接访问路由被拦。
- 管理更新 revision 冲突、必填原因、原子发布、历史记录、回滚和首位全局关闭。

日志只记录 Flag key、结果、revision 和聚合原因，不记录完整 token、邮箱或白名单。指标至少包括每个 Flag 的 enabled/disabled 计数、判定失败率和延迟；高基数 user id 不进入指标标签。

## 12. 实施顺序

1. Supabase 表、判定函数、管理 RPC、RLS 与 pgTAP。
2. FastAPI repository/service/依赖和管理 API。
3. EdgeOne Cloud Function 对 `agent.chat` 的服务端强制校验。
4. Web Zustand store、路由/交互门禁与后端错误同步。
5. 管理界面。
6. 先迁移 `library.bookshelf`，验证端到端后再迁移 RAG 构建期开关；Olds 保持整体关闭，不进入本轮迁移。

每一步都可独立回滚；在数据库判定与服务端校验上线前，不删除现有构建期开关。

## 13. 已确认的实现决策

- Supabase 是唯一 Flag 配置与判定源，前后端不各自维护规则。
- 规则严格按界面顺序 first-match-wins，并强制保留最后一条 `global` fallback。
- 管理台复用现有 `JOJO_OPERATOR_TOKEN`，不引入 Supabase 浏览器登录、管理员表或新的 Access Token。
- 管理界面放入更名后的“JOJO 管理台”。
- 百分比只支持整数，最小步进 1%。
- Olds 整体关闭，本轮不拆子 Flag。
- 全部行为由同一条有序规则链表达；首位 `global → OFF` 用于立即关闭所有访问。
