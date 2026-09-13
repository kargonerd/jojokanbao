# JOJO 看报 · PostHog

PostHog 承担 Web、Desktop、Mobile 和官网的使用统计、JavaScript 错误追踪，以及小型运行参数管理。
前后端直接通过各自 SDK 读取同一份公开运行配置，使用本地或进程内缓存异步刷新。
Healthchecks.io 和维护调度器负责定时任务、AI/邮件巡检及故障告警。

## 项目与构建配置

项目使用 US 区域，API Host 为 `https://us.i.posthog.com`。
Project Token 和 API Host 是客户端公开配置。Operator Token 等服务端凭据存放在 Secret 中。

| 环境 | 变量 |
| --- | --- |
| GitHub 仓库或发布 Environment Variables | `POSTHOG_PROJECT_TOKEN`、`POSTHOG_API_HOST` |
| Web/Desktop | `VITE_POSTHOG_TOKEN`、`VITE_POSTHOG_HOST` |
| Mobile 的 EAS 环境变量 | `EXPO_PUBLIC_POSTHOG_TOKEN`、`EXPO_PUBLIC_POSTHOG_HOST` |
| Python API、Agent、邮件额度服务 | `POSTHOG_PROJECT_TOKEN`、`POSTHOG_API_HOST` |
| 官网 | `PUBLIC_POSTHOG_TOKEN`、`PUBLIC_POSTHOG_HOST` |

发布工作流负责映射 GitHub 变量；EAS 云构建需要在项目使用的 EAS environment 中配置对应变量。
本地构建通过仓库的 `.env` / worktree 配置加载器读取公开值。
Mobile 也支持 `VITE_POSTHOG_TOKEN/HOST`，以 `EXPO_PUBLIC_` 值为优先，并只将允许的字段写入 `extra.analytics`。
Token 和 Host 同时存在且 Host 为 HTTPS 时启用统计 SDK；日常开发模式关闭统计。
运行配置独立于统计启用状态，注册、批注和 AI 服务需要有效的 PostHog 配置。

Web 使用 `stable` / `beta` 发布渠道。移动端正式发布使用 `production-standard` /
`production-eink` EAS Update channel，对应统计标签 `release_channel=stable`；OTA 沿用安装包渠道。
官网 Preview 构建关闭采集。正式用户看板按 `release_channel=stable` 过滤。

## 使用统计与错误追踪

看板：[JOJO 看报 · 使用与质量](https://us.posthog.com/project/604535/dashboard/2087269)。
日期按项目时区划分。

| 问题 | 事件 / 维度 |
| --- | --- |
| 有多少客户端被打开过？ | `app_started`，按 `installation_id` 去重，过滤 `client=desktop/mobile` |
| 每天、每周有多少活跃用户？ | `app_active` 的 Unique users |
| 各平台、版本、墨水屏版使用量如何？ | `client`、`platform`、`app_variant`、`app_version` |
| 哪些页面、报刊、书籍有人使用？ | `screen_viewed.screen`、`reading_loaded.content_type/content_id` |
| 阅读和搜索的结果、耗时如何？ | `reading_loaded/reading_failed`、`search_completed/search_failed`、`duration_ms` |
| 客户端下载入口使用量如何？ | `download_clicked`，按 `target_platform`、`available_version` 分组 |
| 桌面自动更新是否正常？ | `update_available`、`update_downloaded`、`update_failed` |
| 哪些版本出现 JavaScript 错误？ | Error tracking 的 `$exception`，按客户端、平台、版本过滤 |

`installation_id` 是随机本地 ID，代表一个安装或浏览器存储实例。退出登录时保持不变；
清理存储或重装会产生新 ID。登录后 `distinct_id` 使用内部用户 ID，支持跨端关联；
退出登录和切换账号时重置 SDK 身份。邮箱和昵称不参与采集。

- `app_started`：一次页面或客户端 JS 运行中首次允许采集时记录。
- `app_active`：应用进入前台。Web/Desktop 要求页面可见且窗口获得焦点；Mobile 使用 AppState。
  桌面启动到托盘可产生 started，活跃度以 active 为准。持续前台使用不会按时钟重复产生心跳。
- `screen_viewed`：受控页面名称，连续同名去重。Mobile 内嵌 Web 阅读器由原生端计数。
- `reading_loaded/failed`：每次打开同一内容最多各记录一次。Web PDF 等待初始页渲染完成；
  Web 书籍等待当前书籍内容与访问条件就绪；Mobile 报刊按有效页数确认载入，书籍按 WebView 载入确认。
  Mobile 报刊失败事件覆盖 WebView 导航和 HTTP 错误。事件表示内容打开情况，不表示读完或完整阅读时长。
- `search_started/completed/failed`：请求开始和最终结果。`result_count` 为匹配总数，`page` 为请求页码。
  取消请求和过期响应没有完成/失败事件，因此 completed/started 不能直接作为成功率。
- 错误上报覆盖 Web/Desktop 的 React、window、Promise，以及 Mobile 的 JavaScript 未捕获异常和 Promise。
  错误信息包含类型、裁剪后的堆栈位置和应用版本；消息正文和 source map 不上传。
  Electron 主进程及 iOS/Android 原生崩溃、服务端调用链和 AI 费用在此采集范围之外。

## 采集边界

应用事件和 SDK 的 `before_send` 使用属性白名单。采集范围是使用次数、内容标识、版本和故障信息；
正文、搜索词、批注、AI 对话、凭据、完整 URL 和异常消息不上传。
自动点击、自动页面采集、录屏、问卷和 IP 地理解析关闭。
公开配置使用独立 SDK 实例和存储，统计偏好及账号变化不会清空配置缓存。

正式构建默认发送这组统计，无需用户点击开启。登录身份恢复期间暂存少量事件，确认身份与本机采集状态后上报。
`account_purpose=ai_availability_monitor/email_delivery_monitor` 的巡检账号及其缓冲事件不参与采集。

采集状态由统计运行层管理，初始化时读取本机保存值。统计服务不可用时登录与阅读正常运行。

## 小型远程配置

PostHog Remote config 是参数编辑与回滚入口，配置文档保持全局启用。
参数只包含公开的运行设置；凭据、用户计数、并发租约和任务状态使用专用存储。

| Remote config | 字段 | 使用方 |
| --- | --- | --- |
| [`auth_signup_config`](https://us.posthog.com/project/604535/feature_flags/881155) | `invitationRequired` | 注册界面与 Auth 校验 |
| [`reader_annotations_config`](https://us.posthog.com/project/604535/feature_flags/881157) | `publicMarkThreshold` | 共享批注公开展示 |
| [`ai_usage_limits_config`](https://us.posthog.com/project/604535/feature_flags/881154) | `requestsPerMinute`、`requestsPerDay`、`maxRunSeconds` | AI 请求准入 |
| [`ops_email_quota_config`](https://us.posthog.com/project/604535/feature_flags/881156) | `warningPercent`、`criticalPercent`、`usageSource`、`dailyLimit`、`monthlyLimit` | 邮件额度检查 |
| [`support_config`](https://us.posthog.com/project/604535/feature_flags/881158) | `qqGroup` | Web/Desktop 支持页、Mobile 设置页 |

前后端使用相同 key、相同 payload 和固定配置身份 `jojo-public-config`，`signed_in=false`。
这五份文档保持全局启用，不添加按用户、平台或百分比分流规则；布尔策略放在 payload 字段中。
例如允许无邀请码注册时，将 `auth_signup_config` 的 payload 改为 `{"invitationRequired":false}`。
参数范围见 [运行配置复用](../infrastructure/supabase/README.md#runtime-configuration-reuse)。

Web/Desktop 和 Mobile 的注册界面直接订阅 `auth_signup_config`，按项目持久保存已验证值。
无缓存时界面先显示邀请码，SDK 返回有效配置后更新；注册页打开和提交失败时会刷新。
后台每 5 分钟刷新，恢复前台的刷新间隔至少 30 秒；无效或失败的响应保留最后有效值。

Python API 和 Agent 用官方 SDK 读取配置，在进程内保存已验证快照。已有快照的请求立即使用缓存，
距上次成功读取 5 分钟后，下一次请求触发后台刷新；失败至少间隔 30 秒重试。
进程首次读取最多等待一次 3 秒 SDK 请求，没有有效配置则暂时拒绝相关操作。
进程重启会重新读取。各进程刷新时间不同，提交操作以处理该请求的后端配置为准。
邮件额度任务每次运行通过 Node SDK 读取完整配置；读取失败按采集故障处理。

注册先调用 `/api/v1/account/signup-authorization`，后端根据同一配置签发绑定邮箱和邀请码、
有效期 120 秒的授权凭据，再由客户端提交到 Supabase Auth。数据库 Auth hook 和触发器验证签名，
并在要求邀请码时原子核销。客户端不能自行声明免邀请码。邀请码与邮箱验证码是两项独立校验：
`invitationRequired` 控制邀请码，邮箱验证码用于确认邮箱所有权。

批注请求经 `/api/v1/annotations` 进入后端，后端从 SDK 取得公开划线阈值，并携带用户 JWT 和
服务端 Operator 凭据调用数据库原子操作。SQL 执行所有权、隐私、审核和参数边界检查。
Agent 同样将可信限额传入配额操作，数据库按账号行锁维护计数和并发租约。
PostHog 管理参数和变更历史；数据库仅保存业务状态及服务端鉴权凭据。

QQ群号由各端独立 SDK 读取 `support_config`，无需登录。
`qqGroup` 为 5–12 位数字字符串，首位非零；显示与复制使用同一值。
首次无缓存时使用 `974380749`，后续按项目持久保存已验证值。
支持/设置页打开时异步刷新，前台每 5 分钟刷新，恢复前台刷新间隔至少 30 秒；
Web/Desktop 恢复联网时也刷新。无效响应保留有效缓存，公开配置 SDK 不发送统计事件。

## 功能与服务端权限

书架、共享批注和听读是登录后可用的常规功能。
服务端按数据所有权、内容可见性、审核和使用限额执行访问控制。
听读优先复用已有音频，MiMo 使用服务端密钥，自动模式在 MiMo 不可用时回退到 Edge。
合成接口、并发限制与缓存行为见 [听读说明](../tools/speech/README.md)。

## 部署与初始化

Web 发布前查询数据库的 `get_reader_runtime_contract`。所需迁移未安装时，master 合并仍执行构建验证，
Beta 上传暂缓；正式发布报错退出。完成运行环境配置与数据库迁移后，重新运行 Deploy Web 发布。

1. 在 PostHog 核对五份全局配置，保留部署目标的实际值；确保公开项目 Token 能读取完整 payload。
2. 配置客户端构建变量。Python API、Agent 和邮件额度 SCF 的运行环境均设置
   `POSTHOG_PROJECT_TOKEN`、`POSTHOG_API_HOST`。GitHub 构建变量不会自动成为云函数运行环境变量。
3. Python API 与 Agent 设置同一个 `JOJO_OPERATOR_TOKEN`，与 Supabase Operator 摘要匹配；
   配置 Supabase URL 和 Publishable Key。服务端凭据只保存在服务端 Secret 中。
4. 在受控发布窗口协调部署 API、Agent、客户端和 `202609130002_posthog_runtime.sql`。
   迁移更新 Auth 校验和批注/配额 RPC 合约，发布前备份并核对业务数据与配置；
   新客户端依赖新的注册授权和批注 API，应与服务端一起验收。迁移保持已有账号、邀请码、批注、用量和租约。
5. 邮件额度服务重新打包发布，使每次检查从 PostHog 读取参数。验证注册两种模式、批注隐私和 AI 限额后开放流量。
6. 移动端使用包含所需原生依赖的正式安装包；OTA 必须满足项目 runtimeVersion 与原生模块兼容要求。
   已安装客户端只有在获得包含新代码的更新后才会使用这些配置。

参数修改与回滚直接在 PostHog 完成，在各服务下一次成功刷新后生效。

## 验收

1. 启动客户端，确认 `app_started`、`app_active`、`screen_viewed` 的客户端、平台、版本和安装 ID。
2. 登录、退出、切换账号，确认事件身份正确，同一安装的 installation_id 保持不变。
3. 打开报刊与书籍、翻页、切换书籍、提交搜索，核对事件归属、次数、耗时和结果数。
4. 桌面进入托盘和恢复窗口，确认只有前台状态产生 app_active；移动端阅读由原生端计数。
5. 首次启动正式构建即可上报；开发模式和巡检账号不产生事件。
6. 在测试项目中触发不含敏感内容的 JS 异常，检查错误类型、版本及裁剪后的堆栈。
7. 验证QQ群号读取与离线缓存，以及注册策略、共享批注阈值和 AI/邮件限额。
8. 确认 Healthchecks.io 与维护调度任务正常运行。

数据库契约测试使用 PGlite 执行完整迁移，覆盖业务状态保留、注册授权签名与邀请码核销、
批注隐私和配额原子操作。Auth/Storage 基础设施和 pgcrypto 入口使用测试夹具。
CI 的 Node 和数据库检查均执行 `pnpm --filter @jojo/posthog-ops test`，数据库任务另运行 pgTAP。
SDK 缓存、离线刷新、前后端策略读取和客户端注册行为由各工作区测试覆盖。

SDK 参考：[JavaScript](https://posthog.com/docs/libraries/js/config)、
[React Native](https://posthog.com/docs/libraries/react-native)、
[错误追踪](https://posthog.com/docs/error-tracking/installation/web)。
费用与免费额度以 [PostHog 定价](https://posthog.com/pricing) 为准。

## GitHub Actions 监控

[JOJO 看报 · GitHub Actions](https://us.posthog.com/project/604535/dashboard/2087480)
看板通过 PostHog GitHub 数据源读取仓库 `kargonerd/jojokanbao` 的 workflow run/job 状态。
数据源使用 PostHog 保存的 OAuth integration，启用 `workflow_runs` 与 `workflow_jobs` 两张表。

GitHub webhook 接收状态事件，两张查询表按 5 分钟周期合并最新状态，还需考虑摄取和查询延迟。
查询数据从连接后收到的事件积累，历史运行需要单独回填；完整 Job 日志在 GitHub 查看。
HogQL 表为 `github.jojo_github.kargonerd_jojokanbao__workflow_runs` 和
`github.jojo_github.kargonerd_jojokanbao__workflow_jobs`。

看板展示工作流结果、失败与超时、队列状态、Job 耗时和重跑情况。
失败率以成功、失败和超时的已完成运行计算，取消和跳过等状态单独展示。
Job 耗时排除未执行、缺时间和负时长记录。表按 ID 合并最新状态，
`run_attempt` 用于识别重跑，完整尝试历史以 GitHub 为准。
趋势按 UTC 日期分组，时间范围写在各卡片标题中。

维护任务的业务结果由调度器的 monitor-policy 判断。
Healthchecks 提供执行结果收集与外部告警，消费者通过 `/log` 读取结果，
使用 Supabase 调度状态保存游标、去重、连续失败、重试和恢复信息。
GitHub 工作流成功与业务任务成功分别统计，no-op 不会自动清除业务故障。
