# 邮件投递监控

启用必须完成凭据配置、现有 SCF 部署、一次真实 SMTP 验证和一次自然自动调度。
代码合并或离线测试通过都不等于生产监控已经启用；运维验收需保留对应的运行链接。

## 检查什么

任务和 Healthchecks slug 均为 `jojo-email-delivery`，工作流是
[`monitor-email.yml`](../../.github/workflows/monitor-email.yml)。现有 SCF 维护调度器
在每个 UTC 小时的 **08、23、38、53 分**触发它。运行器通过 Resend API 的
`GET /emails` 读取邮件记录，按 `JOJO_EMAIL_SENDER` 限定发件人；不读取邮件正文
或 Resend `/logs`，也不调用 Resend 发送、修改或删除接口。

其中 UTC **00:08、04:08、08:08、12:08、16:08、20:08** 的运行还检查 SMTP 链路：
向专用 Supabase 监控账号调用一次 `/auth/v1/recover`，再确认 Resend 出现本次请求
之后的新邮件且状态为 `delivered`。只接受 `/recover` 成功响应不足以判定通过。
正常自动调度每天发 **6 封测试邮件**；人工强制验证会额外占用发送额度。

监控账号地址采用 `delivered+<随机标记>@resend.dev`。随机标记在初始化账号时生成，
随后固定使用同一地址，不在每次运行时创建账号。它是 Resend 官方测试地址，
投递事件属于模拟结果，测试邮件仍计入发送额度。
[Resend 测试地址说明](https://resend.com/docs/dashboard/emails/send-test-emails)。

`/recover` 只发送该测试账号的验证码；程序不读取或验证验证码、不登录该账号、
不提交新密码，也不产生书架、评论或信箱记录。账号使用
`raw_app_meta_data` 与 `raw_user_meta_data` 的 `account_purpose = 'email_delivery_monitor'`；统计用户增长和
邮件用量时应排除这个明确标记的监控账号及其测试邮件。

## 覆盖边界

- Resend 的 GET 轮询可观察进入其邮件记录的投递结果，轮询间隔为 15 分钟，
  不等于每封邮件都有即时告警。每次向前检查 24 小时，最多读取 10 页、保留 200
  条匹配记录；未覆盖查询窗口时返回 `scanComplete:false`，不把部分样本当作
  完整检查通过。记录保留、分页上限和运行队列也会影响可见范围。
- 主动探测覆盖 Supabase Recovery → 配置的 SMTP → Resend 测试投递，间隔为
  4 小时；只在两个探测之间短暂出现的 SMTP 故障可能漏过。
- `delivered@resend.dev` 模拟成功投递，不能保证 QQ/163/Gmail 等真实邮箱收件、
  垃圾箱位置或用户实际看到邮件，也不验证验证码校验和密码更新页面。
- 运行时没有 Supabase Management Token、Service Role 或管理员账号。当前运维
  账号没有可用的细粒度 PAT 选项，本方案不读取全量 Auth 请求日志，因此邮箱
  格式错误、Auth 拒绝请求、限流等发生在 Resend 收到邮件之前的错误，不会逐条
  被这项监控捕获。主动探测只能验证自己的请求。

## 配置与权限

| 配置名 | GitHub 存放位置 | 用途 |
| --- | --- | --- |
| `RESEND_MONITOR_API_KEY` | Secret | 专供监控读取 Resend 记录 |
| `JOJO_EMAIL_MONITOR_ADDRESS` | Secret | 已确认的专用 Supabase 测试账号地址 |
| `JOJO_EMAIL_SENDER` | Variable | 与 Supabase 自定义 SMTP 一致的发件人邮箱 |
| `VITE_SUPABASE_URL` | Variable | 复用现有生产项目 URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Variable | 复用公开 Auth 调用所需的 Key |
| `JOJO_EMAIL_HEALTHCHECK_PING_URL` | Secret | 专用 Healthchecks 检查的 Ping URL，只写 `/log` |

Resend 当前只提供 `full_access` 和 `sending_access` 两类 API Key。
`sending_access` 不能读取邮件记录，所以此处需要独立的 `full_access` Key；
**Resend 调用只读并不等于凭据本身只读**。该 Key 具备额外管理能力，必须与生产 SMTP
发送凭据分开，限于受信任的默认分支工作流使用，不注入外部 PR 或前端。
[Resend API Key 权限说明](https://resend.com/docs/api-reference/api-keys/create-api-key)。

调度器沿用已有受限的状态 RPC，状态保存在现有 SCF monitor JSON 中，不新增表。
工作流把 `mail_observation:v1` 脱敏执行事件写入 Healthchecks `/log`，仅包含
执行身份、时间、扫描完整性、邮件 ID/时间/状态及安全错误分类；**现有 monitor consumer 是唯一
的 up/down 状态写入者**。不要再给工作流增加直接成功或 `/fail` Ping，否则会
绕过统一告警、去重和恢复判断。

## 告警和恢复

调度任务允许 5 分钟补跑，每个槽位只尝试一次，不自动重试；已有邮件监控工作流
排队或运行时不重复触发。调度检查的 grace 为 20 分钟，GitHub 排队和调度器故障
仍可能延迟实际观察。

consumer 分开保存采集、投递和 SMTP 探测状态：

- API 请求失败、响应不合法或扫描不完整属于采集故障；空结果不会丢弃仍在
  统计范围内的异常记录，也不能清除 SMTP 故障。
- 业务邮件异常统一按邮件 ID 去重，**满 3 封**才触发服务告警：超过 10 分钟仍
  等待投递的邮件，加上近 30 分钟创建且为 `failed` / `suppressed` / `canceled` /
  `complained` / `bounced` 的邮件，合并计数。同一封的重复扫描、状态变化不累加；
  专用 SMTP 测试邮件不计入。1–2 封保留异常记录，并在监控摘要中报告
  `abnormalMessages` 和 `alertThreshold`，不单独拉红服务状态。
- 未确认解决的延迟继续保留并计数，即使已离开 24 小时扫描窗口；其他邮件
  成功、空扫描或部分扫描中的成功不能证明它已送达。终态异常沿用原退信的
  30 分钟创建时间窗口。完整扫描确认计数低于 3 后可解除业务告警；单纯时间
  流逝、部分扫描或派发成功不发送恢复。解除服务告警不修改原邮件的投递状态。
  旧版单封告警也在下一次完整扫描按此阈值重新评估，不清空历史或手动置绿。
  这里的“观察到”仍受 15 分钟轮询和随后 consumer 处理时间限制。
- SMTP 探测失败单独告警；最近成功证据超过 **4 小时 30 分钟**即失效。
  首次取得真实 SMTP 探测成功之前，主检查保持 unknown，不因普通 API 读取
  成功就显示为健康。

恢复必须同时满足对应状态的恢复条件及有效的 SMTP 成功证据；普通 GET 成功
不能清除 SMTP 故障。策略目前是代码常量，与现有 task 定义一起审查、测试和
部署；以后若提供后台调参，复用已有 feature flags，不新增配置表。

## 首次接入

1. 获得专用 Key 创建和 GitHub Secrets 存储的授权后，在 Resend 创建名称明确
   的监控专用 Key，权限选 `full_access`。立即存入 `RESEND_MONITOR_API_KEY`，
   运维记录只保留 Key 名称、ID、创建日期和用途，不记录明文。不要复用或修改
   当前 Supabase SMTP 的发送 Key。
2. 由操作者通过现有账号运维流程创建一个已确认的普通 Supabase 监控账号，
   采用随机标记的测试地址并标记监控用途。遵守现有邀请码规则，不关闭生产
   Hook/触发器。运行器不保存账号密码，也不保存创建账号用的管理凭据。
3. 配置上表的 Secrets/Variables，核对 `JOJO_EMAIL_SENDER` 是实际 SMTP 发件人。
   沿用现有 Healthchecks 告警渠道与调度器 consumer，不创建第二套状态写入路径。
4. 合并代码后部署现有 SCF 调度器的新任务注册；仅合并代码不会更新线上 SCF。
   首次先人工运行记录检查，再强制执行一次 SMTP 验证，确认匹配到新测试邮件，
   工作流产出结构化结果，consumer 消费事件并更新对应 Healthchecks 检查。
5. 等待一次自动运行，核对计划时间、任务槽位和 Healthchecks 状态，确认没有
   并行重复发送。记录上线时间、工作流运行链接及检查名称。
   只保留脱敏分类和运行链接，不上传邮件正文、验证码、收件人列表或
   原始 API 响应；本仓库是公开仓库，不上传这些内容作为 artifact。

工作流输入约定：

| 输入 | 用途 |
| --- | --- |
| `automatic` | 由调度器运行时为 `true`；人工检查为 `false` |
| `scheduled_at` | 调度器提供的 UTC 计划时间 |
| `schedule_slot` | 调度器提供的唯一时间槽位，用于识别重复执行 |
| `verify_transport` | 人工需要额外验证 SMTP 时启用；自动运行按上述 4 小时时间表执行 |

这些输入依次映射到 `JOJO_EMAIL_AUTOMATIC`、`JOJO_EMAIL_SCHEDULED_AT`、
`JOJO_EMAIL_SCHEDULE_SLOT`、`JOJO_EMAIL_VERIFY_TRANSPORT`。自动发信还校验槽位
时效及首次运行身份；GitHub 的 Re-run 不重复发测试邮件。需要重新验证时创建
一个新的人工 dispatch，不复用旧结果。

接入后人工检查只在 `master` 上运行；PR 只运行离线测试，不注入监控凭据。
下面第一条只观察已有记录，第二条额外发送一封 SMTP 测试邮件：

```sh
gh workflow run monitor-email.yml --ref master -f automatic=false
gh workflow run monitor-email.yml --ref master -f automatic=false -f verify_transport=true
```

离线测试使用模拟请求，不发送邮件：

```sh
node --test tools/email-healthcheck/probe.test.mjs tools/email-healthcheck/run.test.mjs
```

人工操作不伪造自动运行的槽位。已有调度、交付去重和部署说明见
[维护调度器](../maintenance-scheduler/README.md)。

## 凭据轮换、撤销与故障处理

轮换 Resend Key 时先创建新的监控专用 Key，更新同名 GitHub Secret，人工验证
读取权限并完成一次 SMTP 检查；确认下一次自动运行使用新 Key 成功后，再撤销旧
监控 Key。SMTP 发送 Key 不随这一步轮换。Key 泄露时立即撤销泄露的 Key，随后
补新 Key 和验证；不要将凭据错误标记为健康或为了恢复绿灯降低检查要求。

轮换监控地址时先建立并标记新的测试账号，更新地址 Secret、验证新邮件，再
通过现有账号清理流程停用旧账号。Healthchecks Ping URL 轮换后同步更新 Secret
并确认 `/log` 仍写入同一个受 consumer 管理的检查。

停用整项监控时，先停用对应调度注册并部署，确认没有在途运行，再撤销专用
Resend Key、移除监控 Secrets、清理专用账号，并暂停对应 Healthchecks 检查，
避免把有意停用当成系统故障。不要撤销共享 SMTP 凭据或调度器公共凭据。

发生告警时先查工作流的脱敏错误分类：API 认证失败检查监控 Key；读取失败检查
Resend API 和配额；`/recover` 失败检查 Supabase Auth/限流/SMTP；没有找到本次
新邮件或未达到 `delivered` 时，在 Resend Dashboard 核对该次测试记录。需要
查看真实收件人或邮件内容的人工调查应留在受控后台，不复制进公开日志或 Issue。
修复后运行一次 SMTP 验证，由 consumer 根据真实成功证据和其余状态决定恢复。
