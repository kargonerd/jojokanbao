# JOJO 看报 · PostHog 接入

本次接入产品使用统计、基础 JavaScript 错误上报，以及客户端 Feature flags。未配置项目 Token/Host 时不初始化 SDK，日常开发模式不发送统计事件。现有 Healthchecks.io 和维护调度器继续承担定时任务、同步、AI/邮件巡检及掉线告警。

2026-09-11 配置进度：已配置 GitHub 仓库的 `POSTHOG_PROJECT_TOKEN/API_HOST`、Expo 项目 `@luoxiaozhuang/mobile` 的 `preview` / `production` 环境中的 `EXPO_PUBLIC_POSTHOG_TOKEN/HOST`，以及本机主工作树现有 `.env` 的公开配置。API Host 为 `https://us.i.posthog.com`。Web/Desktop/官网构建和移动端配置解析已经验证；官网与 Web/Desktop 使用相同的工作树环境目录回退逻辑。尚未发布包含这些代码的正式版本。

手动发送的 `posthog_setup_check` 使用固定测试身份 `jojo-posthog-setup-check`、`environment=setup`，关闭 person profile 和 IP 地理解析。上报接口返回 HTTP 200 / `status: Ok`，并已通过项目 604535 的事件 schema 和趋势查询确认入库 1 条。它不是实际客户端活跃事件，不纳入 `app_active` / `app_started` 的用户统计。三个产品开关已在远端创建，并通过公开 Flags API 验证登录与未登录条件；客户端 provider 和数据库尚未切换。

## 开通与配置

1. 创建一个 [PostHog Cloud](https://posthog.com/) 项目，取得项目 **Project Token** 和该项目对应的 **API Host**（例如 `https://us.i.posthog.com` 或 `https://eu.i.posthog.com`）。这两个值是客户端公开配置；不使用 Personal API Key。
2. 在 GitHub 仓库或发布 Environment 的 Variables 中配置 `POSTHOG_PROJECT_TOKEN`、`POSTHOG_API_HOST`。现有 Web、官网、Desktop、Android、墨水屏、iOS、OTA 工作流已映射这些变量。仅接统计无需改数据库；Feature flags 按下方迁移步骤单独切换。
3. 在 Expo 项目的 EAS Environment Variables 中配置同一组值，变量名为 `EXPO_PUBLIC_POSTHOG_TOKEN`、`EXPO_PUBLIC_POSTHOG_HOST`，可见性选 Plain text。当前内部 APK profiles 没有显式 `environment`，需配置它们实际使用的 `preview` 环境；商店构建及现有 OTA 工作流使用 `production`。**GitHub runner 的环境变量不会自动成为 EAS 云构建环境变量。** 参见 [Expo 环境变量说明](https://docs.expo.dev/eas/environment-variables/)。
4. 发布包含本次变更的版本。移动端新增了 Expo 原生依赖，应先发布新的客户端安装包；不要只向旧包发 OTA。保持已有 iOS 发布开关和 runtimeVersion 策略。
5. 在实际客户端验证下方清单。配置前的使用量无法补采。

本地制作生产构建时，Web/Desktop 复用仓库现有 `.env` / worktree 配置加载：

```dotenv
VITE_POSTHOG_TOKEN=phc_your_project_token
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

Mobile 的现有配置解析器也读取这两个值，或优先使用 `EXPO_PUBLIC_POSTHOG_TOKEN/HOST`，只把允许的公开字段放入 `extra.analytics`。官网从仓库 `.env` 读取 `PUBLIC_POSTHOG_TOKEN/HOST`。Token 和 Host 必须同时设置；Host 必须为 HTTPS。`pnpm dev` / Expo 开发模式始终关闭，不因填写变量而发送。

Web 保留原有 `stable` / `beta` 发布渠道，分析正式用户时过滤 `release_channel=stable`。官网 preview 构建关闭采集。需要测试环境数据时使用单独的 PostHog 项目，不在生产看板混入测试事件。

## 当前能回答的问题

| 问题 | 事件 / 维度 |
| --- | --- |
| 有多少客户端被实际打开过？ | `app_started`，按 `installation_id` 去重，过滤 `client=desktop/mobile` |
| 每天/每周有多少用户使用？ | `app_active` 的 Unique users；结合 `screen_viewed`、`reading_loaded`、`search_completed` 看实际使用 |
| Windows/macOS/Android/iOS/墨水屏各有多少使用量？ | `platform`、`app_variant`、`client` 分组 |
| 各版本是否仍有人使用？ | `app_version` 分组；Web/官网发布版本是 Git SHA，原生客户端是应用版本 |
| 哪些页面、报刊、书籍有人使用？ | `screen_viewed` 的 `screen`；`reading_loaded` 的 `content_type/content_id` |
| 阅读打开或搜索是否经常失败、耗时多久？ | `reading_loaded/reading_failed`、`search_completed/search_failed`，查看 `duration_ms` |
| 客户端下载按钮有没有人点？ | `download_clicked`，按 `target_platform`、`available_version` 分组；只表示点击 |
| 桌面自动更新是否遇到问题？ | `update_available`、`update_downloaded`、`update_failed`，按 `available_version` 分组 |
| 哪些客户端版本有 JS 错误？ | PostHog Error tracking 中的 `$exception`，按 `client/platform/app_version` 过滤 |

已创建 [JOJO 看报 · 使用与质量](https://us.posthog.com/project/604535/dashboard/2087269) 看板，包含 12 个图表：每日/每周活跃用户、近 30 天实际打开的客户端安装实例、平台/版本分布、页面排行、阅读成功/失败、搜索完成/失败、阅读与搜索 P95 耗时、下载点击、桌面更新过程、JavaScript 错误数。查询均已通过真实项目验证，并回读确认图表归属；新版本尚未发布，当前只有独立的 setup 验证事件，业务图表的空数据不代表现有产品没有用户。图表默认过滤正式渠道，按项目时区划分日期。原有 starter dashboard 保留。

`installation_id` 是随机本地 ID，退出登录不变；清理应用数据、重装或清理浏览器存储会产生新 ID。它代表被观察到的安装/浏览器存储实例，无法统计卸载、从未打开的安装，也不等于独立自然人数。登录后 `distinct_id` 使用内部用户 ID，可以跨端关联；退出登录/切换账号时重置 SDK 身份，避免共享设备串号。不发送邮箱和昵称。

## 事件口径

- `app_started`：一次页面/客户端 JS 运行期间第一次允许采集时记录。桌面冷启动到托盘也可能产生此事件；活跃度使用 `app_active`。
- `app_active`：应用进入前台。Web/Desktop 同时要求页面可见和窗口获得焦点，托盘/后台不算活跃；Mobile 使用 AppState。持续不切换前台的使用不按时钟重复产生心跳。
- `screen_viewed`：受控页面名称；连续同名去重，不包含 URL 查询串、哈希、动态路由参数。移动端内嵌 Web 阅读器禁用 Web SDK，避免重复计算为 Web 用户。
- `reading_loaded/failed`：每次打开同一内容最多各记录一次，重渲染、翻页不重复。Web PDF 等待初始页渲染完成；Web 书籍等待内容与访问条件就绪；Mobile 报刊按有效页数报告确认载入，书籍按 WebView 成功载入确认。Mobile 报刊的失败事件目前覆盖 WebView 导航/HTTP 错误，尚不覆盖内嵌网页内部的 PDF 请求错误。它们表示打开内容，并不表示读完或完整阅读时长。
- `search_started/completed/failed`：真实请求的开始和最终结果。被取消或旧请求的响应不算失败；`result_count` 是接口返回的匹配总数，`page` 是请求页码。不要直接将 `completed/started` 当成功率，因为取消请求也有 started。
- 基础错误上报覆盖 Web/Desktop React、window、Promise，以及 Mobile JavaScript 未捕获异常/Promise。不会上传 Electron 主进程崩溃 dump 或 iOS/Android 原生崩溃，也没有服务端链路追踪与 AI token/费用统计。本次未上传 source map，错误文本被省略，仅保留类型、裁剪后的堆栈位置和版本，诊断精度有限。

## 采集边界与关闭

通过统计 SDK 的 `before_send` 再次执行属性白名单，过滤 SDK 自动添加的 URL、referrer、设备详情和 person 属性。关闭自动点击采集、页面自动采集、录屏、问卷和统计实例的远程功能配置；关闭 IP 地理解析。Feature flags 使用独立 SDK 实例，避免统计 opt-out 或身份重置清空功能开关缓存。应用层不上传搜索词、正文、批注、AI 输入输出、令牌或完整异常消息。错误堆栈去除查询串、目录路径和上下文变量。

默认允许这组有限的统计，用户可以关闭；登录身份尚未恢复时先暂存少量应用事件，只有确认身份和本机偏好后才上报。带 `account_purpose=ai_availability_monitor/email_delivery_monitor` 的自动巡检账号不采集，缓冲事件也会丢弃。

- Web：关于/支持页「帮助改善 JOJO 看报」。
- Desktop：设置页「帮助改善 JOJO 看报」。
- Mobile：设置的数据部分「帮助改善 JOJO 看报」。
- 官网：页脚使用统计复选框。

偏好仅保存在当前浏览器或客户端。关闭后禁止新的采集并通知 SDK opt-out；已发送到服务端的数据不会因此自动删除。缺少配置、离线、SDK 初始化或上报失败不会阻塞登录与阅读。

## 上线验收

1. 使用配置正确的生产构建，在 PostHog Activity 中确认 `app_started`、`app_active`、`screen_viewed`，检查 client/platform/version/installation_id。
2. 登录后检查内部用户 ID；退出后确认新事件不再属于刚才账号；同一安装的 installation_id 保持不变。
3. 打开一期报刊/一本书，翻页数次只产生一次 reading_loaded；提交搜索，确认 completed 的耗时与结果总数，事件里没有查询内容。
4. 桌面最小化到托盘不增加 app_active，恢复窗口才增加。移动端阅读不会额外产生 Web 客户端事件。
5. 关闭统计、重新启动、再次操作，确认没有新事件；恢复开关后重新产生事件。用巡检账号确认没有事件。
6. 在测试项目的生产构建触发一个不含敏感内容的 JS 异常，确认 Error tracking 能收到，正文/完整 URL/输入内容被过滤。恢复生产配置后发布。
7. 观察既有 Healthchecks.io 告警和调度任务继续运行。本次没有替换它们。

SDK 参考：[JavaScript 配置](https://posthog.com/docs/libraries/js/config)、[React Native](https://posthog.com/docs/libraries/react-native)、[Web 错误追踪](https://posthog.com/docs/error-tracking/installation/web)。费用与免费额度按 [PostHog 定价页](https://posthog.com/pricing) 为准；本次未开启录屏。

## 已退役的产品开关

书架、共享批注和听读不再使用 Boolean feature flags。新版客户端直接保留登录校验、内容可见性和数据所有权规则，不等待远程开放范围；移除了产品开关的 SDK 适配、账号缓存、轮询与 provider 选择器。原生阅读器的本地离线划线、笔记保持原行为。Web 正式版与预览版统一使用当前界面，删除了整站新旧版本切换及旧版路由、导航和搜索分支，旧报刊深链接仍重定向到现有阅读器。

2026-09-12 已在客户端脱离开关、测试通过后归档 `library_bookshelf`（879931）、`reader_annotations`（879932）、`reader_speech`（879933），并读回归档列表确认。三个开关均未关联实验、问卷、早期访问功能或录屏设置。下节五份 Remote config 保留。已发布的老版本仍使用 Supabase 规则，未切换到这三个 PostHog 产品开关。

按顺序应用三份迁移：`202609110001_posthog_product_flags.sql`、`202609120001_posthog_runtime_config.sql`、`202609120002_retire_product_flags.sql`。三项产品的 SQL 入口只检查登录，RLS 所有权、内容可见性、审核与限额照常执行。最后一份迁移将三项产品及历史 `rag.workspace`、`olds.workspace` 标为退役；管理列表隐藏没有运行参数的四行。`reader.annotations` 仍保留公开阈值配置。

所有旧行、实际规则、参数、revision、history 和 `get_my_feature_flags` 保留，兼容已安装旧客户端；退役不删除用户书架、批注或历史。管理台在数据库迁移前也隐藏废弃入口，批注只保留参数编辑/展示。退役记录可通过原有 Operator 单项快照接口审计。

`JOJO_TTS_ENABLED` 保留为服务端新音频合成设置：false 停止生成新音频，已存在的缓存仍可播放。修改后需要重新加载服务配置；它不控制客户端入口，也不是授权或用户限额。

验收：登录后直接使用书架、共享批注和听读；退出登录停止音频、清理账号状态；匿名或其他账号不能读写个人书架/批注；旧客户端接口继续返回原规则；配置同步不会改变数据、历史、用量计数和并发租约。

## 小型远程配置

[PostHog Remote config](https://posthog.com/docs/feature-flags/remote-config) 统一下发 JSON，不依赖已退役的产品 Boolean flags。2026-09-12 已重新导出全部线上 flag 到本机 `.runtime/posthog/runtime-config-before-migration.json`，按所有非空 `config` 的实际值创建以下配置，并通过公开 `/flags/?v=2` 逐项核对 payload：

| Remote config | 迁移时实际值 | 读取位置 |
| --- | --- | --- |
| [`auth_signup_config`](https://us.posthog.com/project/604535/feature_flags/881155) | `invitationRequired: false` | 注册与 Auth 校验 |
| [`reader_annotations_config`](https://us.posthog.com/project/604535/feature_flags/881157) | `publicMarkThreshold: 2` | 服务端共享批注公开阈值 |
| [`ai_usage_limits_config`](https://us.posthog.com/project/604535/feature_flags/881154) | 每分钟 3 次、每天 100 次、单次 300 秒 | 服务端 AI 准入 |
| [`ops_email_quota_config`](https://us.posthog.com/project/604535/feature_flags/881156) | `warningPercent:80, criticalPercent:90, usageSource:"records", dailyLimit:100, monthlyLimit:3000` | 既有邮件额度检查 |
| [`support_config`](https://us.posthog.com/project/604535/feature_flags/881158) | `{"qqGroup":"974380749"}` | Web/Desktop 支持页、Mobile 设置页 |

前四份配置的 PostHog key 是原业务 key 将点换成下划线，再加 `_config`；不要把它们放到产品开关的 true/false 变体中。所有配置保持全局启用，禁止存密钥、用户计数、并发租约或任务状态。删除/关闭配置不表示取消限额。

**注册策略：** `auth_signup_config.invitationRequired` 是统一的注册参数，不是独立前端开关。PostHog 同步到服务端缓存后，客户端通过 `signup_invitation_required()` 决定是否显示邀请码字段；Auth hook/trigger 读取同一策略强制校验。前后端共用一个来源，业务请求不等待海外网络，前端隐藏字段也不能绕过服务端校验。表单加载后若策略改变，提交仍以服务端最新缓存为准。

**服务端路径：** `tools/posthog/sync-runtime-config.mjs` 读取公开 flag payload，与 Operator 当前快照一起校验，通过一次 `operator_sync_posthog_configs` 事务写入现有 `private.feature_flags.config`。没有新配置表，业务请求不访问 PostHog。同步使用原有 Operator 鉴权、revision 冲突检查和发布历史；保留旧规则、未修改的配置字段、已有历史、计数和执行中的租约。迁移只增加来源/远端版本/同步时间元数据，不覆盖当前参数。首次同步必须与当前数据库值一致，若导出后线上又发生修改，会拒绝绑定，需重新核对 PostHog 配置。

字段类型、整数范围和阈值关系在导入程序及数据库两处验证。任一配置缺失、关闭、非法或出现版本冲突时，整个批次失败，继续使用上次有效值。远端 flag ID 首次绑定后不能静默替换；版本必须单调递增，同版本不同内容拒绝更新。同版本同内容重试只更新时间，不重复写历史；在 PostHog 回滚参数会以新的远端版本及数据库 revision 记录。

`.github/workflows/sync-runtime-config.yml` 每 5 分钟计划同步一次，仅在 master 且 `POSTHOG_RUNTIME_CONFIG_SYNC_ENABLED=true` 时运行。GitHub 定时任务可能延迟或漏跑，不能保证 5 分钟内生效。服务端保留最后有效缓存，没有强制过期；参数在成功同步后的下一次业务读取生效，邮件额度仍在下一次半小时检查读取。JOJO 管理台按 `configProvider=posthog` 显示只读配置、最后同步时间及历史，修改和回滚均在 PostHog 完成，数据库拒绝旧编辑入口修改这些配置。

**QQ群号路径：** 两端 SDK 通过 `getFeatureFlagPayload("support_config")` 读取，无需登录，也不受统计 opt-out 影响。群号必须是 5–12 位数字字符串，首位非零；显示和复制使用同一值。首次无缓存时使用 `974380749`；随后按项目保存已验证的 localStorage/AsyncStorage 缓存，即使 SDK 无法加载也能恢复。支持/设置页打开时异步刷新，停留前台每 5 分钟刷新，恢复前台刷新间隔至少 30 秒；Web/Desktop 恢复联网也刷新。无效响应不会覆盖有效缓存。公开配置 SDK 不发送采集事件。

### 运行参数切换步骤

1. 重新导出实际值并核对上表五份 PostHog 配置。保持现有服务端参数不变，不能用默认值覆盖后来调整的配置。
2. 合并包含同步工作流的代码。顺序应用 `202609110001_posthog_product_flags.sql`、`202609120001_posthog_runtime_config.sql`、`202609120002_retire_product_flags.sql`，使用更新后的管理台读取 `configProvider` 和当前值。
3. GitHub 已配置公开 `POSTHOG_PROJECT_TOKEN/API_HOST` 和原有 Supabase Variables；同步所需 `JOJO_OPERATOR_TOKEN` 保存为 GitHub Secret，客户端只包含公开项目 Token。不要把 Operator Token 放到 PostHog payload 或 `VITE_` / `EXPO_PUBLIC_` 变量。
4. 在已有凭据的受控环境运行 `node tools/posthog/sync-runtime-config.mjs` 做首次同步，预期 `checked=4, changed=[]`。回读四份配置的同步时间、远端版本，以及业务读取值。脚本只读取进程环境，不自动加载 `.env`。再设置 `POSTHOG_RUNTIME_CONFIG_SYNC_ENABLED=true`，执行一次工作流并检查结果。
5. 发布客户端后验证QQ群号和离线缓存。验证限额执行、邀请码注册、共享批注阈值，以及原有监控正常工作。无需配置产品开关 provider。

停止同步时将 `POSTHOG_RUNTIME_CONFIG_SYNC_ENABLED` 设为 false，现有服务端值继续生效。若要恢复数据库编辑源，用新的回退迁移将四行 `config_provider` 改为 `supabase`，保留当前 config、规则和历史；不要删除配置行或恢复初始默认值。

**当前状态：远端五份配置已创建并读回验证；迁移、同步工作流和客户端接入代码已完成，但生产数据库尚未应用本次三份迁移，自动同步尚未启用，客户端尚未发布。** 本地 13 项导入/PostgreSQL 测试覆盖值保留、首次绑定、幂等重试、非法配置、旧版本、事务回滚及真实 AI 准入函数；SDK 测试覆盖断网缓存和无事件采集。Auth 基础设施及 pgcrypto 入口为测试替身，不能代替生产切换验收。

## GitHub Actions 监控

GitHub Actions 纳入本次监控范围，使用 [PostHog GitHub 数据源](https://posthog.com/docs/data-warehouse/sources/github)，连接仓库 `kargonerd/jojokanbao`。2026-09-12（北京时间）已完成 GitHub App 授权，创建 source `01a09148-3506-0000-90a7-35037e0e7212`，表前缀为 `jojo_github`。连接使用 PostHog 保存的 OAuth integration，不把本机 GitHub CLI 的个人凭据转存到 PostHog。

实际只启用 `kargonerd/jojokanbao.workflow_runs` 和 `kargonerd/jojokanbao.workflow_jobs`，均为 Webhook 同步；其余表关闭，`auto_sync_new_schemas=false`。当前 GitHub App 不具备 Deployments read 权限，因此没有启用 deployments / deployment statuses；部署及发布工作流本身仍包含在运行表中。发现真实表结构后再创建数据源，不能省略 schemas 而让一键 setup 默认启用所有表。

| 问题 | 看板口径 |
| --- | --- |
| 哪些工作流失败？ | 按 workflow 路径分组最新运行结果，链接回 GitHub run；显示失败、超时、取消、跳过等实际状态 |
| 失败率是否升高？ | 对已完成的成功、失败与超时运行计算；取消、跳过、中性和其他结论单独展示，不默认为成功或失败 |
| 哪个 Job 最慢？ | 完成且实际执行的 Job，以 completed_at - started_at 计算 P50/P95；缺少时间、跳过或负时长样本排除 |
| 是否反复重跑？ | 区分 run_id 与 run_attempt；一个 run 的最新结论不能冒充每次尝试的完整历史 |
| 是否排队或卡住？ | 分开观察 queued / waiting / in_progress，并结合 Job 状态；不把工作流 updated_at 当作准确完成时间 |
| 哪次发布出了问题？ | 分开查看 CI、Web/官网部署、Desktop/Android/iOS/OTA 发布及维护任务；保留分支和触发方式维度 |

在只读核对的最近 100 次 GitHub 运行样本中，存在真实 failure 和多条 cancelled；一个成功 CI 中的 skipped Job 还出现 completed_at 早于 started_at 的记录。因此不能将所有非 success 都算失败，也不能直接对所有 Job 时间差求平均。样本仅用于验证字段与口径，不作为已接通 PostHog 的证据。

PostHog 已自动创建并注册 GitHub webhook `677774538`，签名校验密钥由平台生成并保存。回读确认 handler enabled、GitHub hook active，真实 workflow_run / workflow_job 推送已返回 HTTP 201。官方连接器默认订阅多种 GitHub 事件，但 handler 只将上述两个已启用 schema 的数据入库，其余事件直接跳过。

Webhook 接收后仍需要合并到查询表：两张表已从默认每 6 小时调整为每 5 分钟同步，因此这不是秒级实时看板，还会叠加入库和查询刷新延迟。当前这两张表为 webhook-only，从连接后接收的新事件开始积累，历史运行不会自动回填。运行状态表不等于完整 Job 控制台日志。PostHog 内仍需单独建立告警规则、检查同步新鲜度及通知渠道，单纯连接数据源不代表告警已经生效。

专用看板：[JOJO 看报 · GitHub Actions](https://us.posthog.com/project/604535/dashboard/2087480)。卡片包括最近 24 小时概览、30 天结果趋势、各工作流状态/失败率、失败与超时清单、未完成 Job、Job 耗时 P50/P95、最新运行、重跑清单和已接收数据的新鲜度。SQL 的时间范围固定在各卡片标题中，趋势按 UTC 日期分组；仓库表按 `id` 合并最新状态，run 表不保存每次重跑的完整历史。

查询使用实际发现的 HogQL 表 `github.jojo_github.kargonerd_jojokanbao__workflow_runs` 和 `github.jojo_github.kargonerd_jojokanbao__workflow_jobs`。两表的时间字段实际为字符串，查询时解析 ISO 时间。Job 耗时额外排除没有 runner、缺失时间和负时长；未完成 Job 排除父 run 已完成或已进入新尝试的旧记录。「最新业务时间」不能单独证明同步健康，没有新运行也会变旧。

2026-09-12 00:33（北京时间）首批实际入库 6 个 run、16 个 Job；后续自动同步已经增加 run 并更新其完成状态。9 张卡片已保存，并通过 `dashboard-insights-run` 强制重新计算全部查询，回读时为 11 个 run、19 个 Job。查询到成功、取消、排队、执行中、跳过及有效耗时样本；当时没有失败/超时和重跑样本，相应清单为空。已核对 run 与 Job 的行数等于各自去重 ID 数，不重复累加状态推送。尚未配置 PostHog 自动告警和通知渠道，Healthchecks 继续运行。

维护任务的业务结果继续按既有 monitor-policy 判断：GitHub 工作流 success 不一定表示发布了新内容，no-op 不能自动清除业务故障。外部 SCF 调度器失联、任务没有被触发、连续失败/重试/恢复，以及独立 Process 队列拥堵仍走现有监控链路。手动禁用的 iOS 发布工作流没有固定运行预期，不加入缺运行告警。完成下节替代验收前保留 Healthchecks。

## Healthchecks.io 替代评估（2026-09-11）

目标是将监控查看与通知收拢到 PostHog。当前尚未迁移维护监控；以下是根据现有代码和官方文档确认的迁移边界，不表示已上线或已完成故障演练。

[PostHog Logs 告警](https://posthog.com/docs/logs/alerts)支持匹配日志数量低于阈值，能够表达“最近 5 分钟健康心跳少于 1 条”。规则由 PostHog 每 5 分钟评估，即使 SCF 或 Supabase 完全不可用，也有外部系统检测心跳缺失。按该规则推算，最后一次心跳后约 5–10 分钟触发，另加摄取及通知延迟；这是规则推算，尚未实测，不等同于当前调度器每分钟 cron 加 3 分钟宽限的策略。

现有 Healthchecks 同时承担执行结果收件箱和外部告警。`TaskMonitor`、邮件监控通过 `/log` 读取有游标的结果，再在已有 Supabase 调度状态中去重、判断连续失败、保存待发送状态。直接替换 ping 地址会使这些消费者失去输入。PostHog 的统计日志也不能未经验证就作为可靠执行结果队列。

| 现有能力 | 替代时需要完成的工作 |
| --- | --- |
| 调度器与监控消费者失联 | 独立的 PostHog 缺心跳规则；只有全部监控消费成功才上报调度器健康 |
| 任务成功期限、连续失败、永久错误 | 复用 `monitor-policy.ts` 和任务定义中的阈值；向 PostHog 输出持续健康/故障状态 |
| 执行结果收件箱 | 为 GitHub 工作流、AI/邮件巡检迁移结果传递路径，保留去重、顺序、历史缺口检测和失败重试；继续使用已有调度状态机制 |
| Process/Cleanup 队列拥堵 | 保留独立队列探测及 5 分钟持续拥堵判断；业务成功不能清除队列故障 |
| 故障恢复 | 必须由新业务成功、真实健康队列或邮件验证结果解除；不能因故障日志离开查询窗口就误报恢复 |
| 通知 | Logs 文档列出 Slack、Teams、Webhook；核对实际收件渠道，验证告警及恢复通知，不假定与现有 Healthchecks 集成等价 |

Logs 查询窗口目前最长 60 分钟，每日任务不能直接使用“窗口内没有任务成功日志”规则；需要现有调度器按任务期限计算持续状态，并由外部缺心跳规则兜底。Metrics 仍是 [private alpha](https://posthog.com/docs/metrics)，此次替代方案不依赖它。

费用方面，[Logs 每月免费摄取 10 GB，默认保留 14 天](https://posthog.com/docs/logs/pricing)。以 7 个监控对象、每分钟各 1 条、每条约 1 KB 估算，30 天约 0.30 GB；仅是心跳预算，不包括业务日志、传输记录和其他产品用量。[免费方案](https://posthog.com/pricing)达到用量上限后停止使用，因此必须核对日志配额耗尽时告警规则和通知的实际行为。

停用 Healthchecks 前，需要在真实 PostHog 项目验证：正常心跳、完全停止发送（包括零匹配数据）、任务连续失败及重试、成功后的恢复、调度器/状态数据库不可用，以及通知送达与故障去重；覆盖至少一次每日同步周期。还要验证重复、迟到和缺失结果不会错误恢复事故。目前已配置客户端公开 Token，但维护任务日志、结果传递路径、远端告警规则和通知渠道尚未迁移，未验证这些条件，因此保留现有生产告警及其凭据。
