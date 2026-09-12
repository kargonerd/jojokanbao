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

## Feature flags 的范围与缓存

| 代码 / 数据库 key | PostHog key | 控制范围 | 首次无缓存默认值 |
| --- | --- | --- | --- |
| `library.bookshelf` | `library_bookshelf` | Web/Desktop 云书架，以及原生端书架入口、加入/移出与同步 | 关闭 |
| `reader.annotations` | `reader_annotations` | Web/Desktop 与内嵌 Web 阅读器的共享划线、想法功能 | 关闭 |
| `reader.speech` | `reader_speech` | Web/Desktop 与原生端听读入口 | 关闭 |

PostHog 创建接口不接受点号，SDK 返回值由共享适配器映射回原有业务 key。已创建远端开关：[云书架](https://us.posthog.com/project/604535/feature_flags/879931)、[共享批注](https://us.posthog.com/project/604535/feature_flags/879932)、[听读](https://us.posthog.com/project/604535/feature_flags/879933)。前两项 `signed_in=true` 时为 true、false 时为 false；听读按旧系统的实际全局开放规则返回 true，但客户端仍只为登录用户读取这些开关。未改变旧数据库的规则与 revision。

原生书籍阅读器的本地离线划线、笔记原本没有远程开关，继续保存在本机，不纳入共享批注开关。部署回退开关 `VITE_ENABLE_PLATFORM_REDESIGN`、服务端 TTS 开关，以及 `auth.signup`、`ai.usage_limits`、`ops.email_quota` 等运行控制仍使用现有机制。`reader.annotations.config.publicMarkThreshold` 也继续由数据库读取；规则开关不能关闭限额或改变公开阈值。

客户端恢复登录身份后，加载该账号的 SDK 本地缓存，并立即后台刷新，不等待 `/flags/` 返回再显示应用。Web/Desktop 使用 localStorage，原生端使用 AsyncStorage。账号和 PostHog 项目各有独立缓存；切换账号立即采用新账号缓存或默认值，晚到响应不能写入另一账号。仅登录用户加载这三个产品开关，跨端使用同一内部用户 UUID 作为 distinct ID，并传递 `signed_in=true`、`account_id=<UUID>` 供规则定向；不发送邮箱或昵称。

前台每 5 分钟刷新一次，回到前台也刷新；相邻刷新至少间隔 30 秒。Web/Desktop 恢复联网时触发刷新。失败继续使用上次缓存，不设置强制过期 TTL；首次无缓存、未知或成功响应中已删除的 key 均视为关闭。PostHog 返回 `false` 会覆盖旧的 `true`。因此后台关停不会在离线客户端立即生效，也不应用于权限、计费、限额或要求立即停止的服务端操作。

关闭「帮助改善 JOJO 看报」只关闭统计。开关实例仍调用 `/flags/`，但其 `before_send` 丢弃所有事件，不创建 person profile，不录屏，不上报 `$feature_flag_called`；因此本次没有接实验曝光/A/B 分析。开发构建只有显式选择 PostHog provider 才读取远程开关，统计仍关闭；现有 Web 本地开发的听读预览例外保留。

## Feature flags 迁移与回退

PostHog 规则已经配置，但数据库迁移和正式发布尚未完成，**默认仍使用 Supabase provider**。填写统计 Token 本身不会切换产品开关。以下是完整切换步骤，执行时仍须核对是否有新的规则修改：

2026-09-11 已通过现有 `operator_list_feature_flags` 只读 RPC 保存线上三个开关的完整快照到本机 `.runtime/posthog/feature-flags-before-migration.json`（Git 忽略）。当时书架 revision 1、共享批注 revision 1 均对登录用户开放；批注 `publicMarkThreshold=2`。听读 revision 2 的实际全局规则为 `serve=true`，虽然规则名称仍写着“默认关闭”，迁移必须按实际值处理。切换前重新核对快照和线上 revision，不能把初始迁移文件里的听读关闭值当作现状。

1. 先运行本次更新的 JOJO 管理台（尚未迁移的数据库仍显示原规则编辑器），进入功能开关页，刷新并点击「导出当前快照」，保存线上真实 `rules/config/history/revision`，期间暂停调整旧规则。不要从迁移文件的默认值推断当前线上开放范围。
2. 在 PostHog 配置上表三个使用下划线的 Boolean flags（当前项目已创建，不要重复建）。按导出快照配置允许范围，指定用户可按传入的 `account_id` 定向。仓库初始规则是书架/共享批注对登录用户开放、听读关闭，**实际迁移以快照为准**。旧系统有“首条命中、允许/拒绝、起止时间”等语义，不能直接把每条规则当作 PostHog 的 OR 条件；逐项核对。两者百分比分桶算法不同，相同百分比不保证同一批用户，需保留精确名单或接受重新分桶。
3. 在测试项目/测试数据库完成下方验收，然后应用 `202609110001_posthog_product_flags.sql` 。迁移不改动任何现有规则、参数、版本或历史。管理台通过数据库快照中的 `rolloutProvider` 标记迁移状态，隐藏这三个 key 的规则编辑；批注阈值仍通过原 Operator 发布、检查版本冲突、记录历史和回滚配置，保留旧规则。
4. 配置 GitHub Variable `FEATURE_FLAG_PROVIDER=posthog` 并发布 Web/Desktop/原生客户端；本地生产构建使用 `VITE_FEATURE_FLAG_PROVIDER=posthog`。EAS 对应环境也单独设置 `EXPO_PUBLIC_FEATURE_FLAG_PROVIDER=posthog`，与 Token/Host 使用同一环境。不要只配置 GitHub 而遗漏 EAS 云构建。官网没有这三个业务开关。
5. 新版本只读 PostHog，不在失败时转读 Supabase；离线时保留 SDK 缓存。旧版本仍能调用 `get_my_feature_flags` 读取原有规则，因此迁移未删除旧表和 RPC。旧版本也不会收到 PostHog 的新开放范围，需发布更新。

**数据库访问语义的变化：** `public.feature_enabled()` 对上述三个 key 只检查已登录；现有 RLS 的 `auth.uid() = user_id`、RPC 的登录校验、内容可见性和审核规则、限额继续执行。PostHog 决定客户端是否展示功能，不充当数据授权。登录用户直接调用 API 时不会再被这三个旧灰度规则阻止。服务端不信任客户端上传的旗标，也不等待海外开关请求。

回退客户端可将 provider 恢复为 `supabase` 并重新发布，旧规则和历史还在。若还要恢复数据库对旧灰度规则的强制检查，须用新的回退迁移把 `public.feature_enabled()` 恢复为 `private.feature_flag_evaluate(p_key, auth.uid(), null)`，同时从 `private.feature_flag_snapshot()` 去掉 `rolloutProvider` 标记；只回退客户端不会自动恢复数据库的灰度限制。恢复前先核对真实规则，不用初始默认值覆盖线上数据。

验收包括：同账号重启/断网保留开关；首次离线默认关闭；切换账号不串缓存；后台返回关闭或删除 key 后入口消失；关闭统计及巡检账号仍能取开关且没有采集事件；原生书架和 Web 共享批注与听读按预期开放；PostHog 打开功能后数据库不再误拒绝，同账号只能访问允许的数据；AI 限额、公开阈值和 Healthchecks.io 不受影响。

本地验证覆盖了浏览器真实 SDK 缓存/响应处理、远端下划线 key 映射、原生适配与账号切换、管理台配置回滚。公开 API 已验证真实 PostHog 项目的三个开关；浏览器 SDK 测试同时覆盖其 v2 响应结构。数据库用隔离的 PGlite/PostgreSQL 执行相关迁移和 128 项 pgTAP 断言（账号基础设施为本地替身），并比较迁移前后全部 flag 行；尚未在真实 Supabase 项目应用迁移，也没有已发布客户端与生产数据库的端到端验收。

## 小型远程配置

[PostHog Remote config](https://posthog.com/docs/feature-flags/remote-config) 可以下发 JSON。普通 flag 的 payload 可以随命中规则或变体变化，Remote config 则用于统一下发配置；客户端通过 SDK 的 `getFeatureFlagPayload` 读取。适合展示条数、界面文案、刷新间隔等允许缓存的小参数。当前适配器只读取上述三个布尔开关，尚未接入 payload 或迁移运行参数。

若加入这类配置，应给每个字段设置默认值、类型与范围校验，复用账号/项目隔离缓存及后台刷新。客户端收到的普通 payload 属于公开配置，不能放密钥。AI 配额、邮件限额、共享批注公开阈值等由服务端执行的参数目前仍使用原有配置、版本检查及历史；不能只把值移到客户端缓存就认为服务端也会生效。

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
