# 运行配置设计

PostHog Remote config 是小型运行参数的编辑入口。配置字段、部署步骤和验收方法见
[PostHog 接入](posthog.md)。

## 配置与读取路径

| 配置 | 使用方 | 生效路径 |
| --- | --- | --- |
| `auth_signup_config` | 注册界面与 Auth 校验 | 同步到服务端缓存，前后端读取同一策略 |
| `reader_annotations_config` | 共享批注服务 | 同步到服务端缓存，控制公开展示阈值 |
| `ai_usage_limits_config` | AI 请求准入 | 同步到服务端缓存，控制频率、日额度和执行时限 |
| `ops_email_quota_config` | 邮件额度检查 | 同步到服务端缓存，在检查任务执行时读取 |
| `support_config` | Web/Desktop 支持页、Mobile 设置页 | 客户端 SDK 异步读取并持久缓存 |

服务端缓存位于 `private.feature_flags.config`。`tools/posthog` 负责校验并同步前四组参数，
通过 Operator 鉴权、版本冲突检查和数据库事务保存配置及审计历史。
管理台展示服务端实际值、同步时间、远端版本和历史；参数调整与回滚在 PostHog 完成。

QQ群号配置与使用统计采用独立 SDK 实例和存储；关闭统计时仍能读取公开配置。
网络失败或配置非法时使用最后有效缓存，首次启动使用代码定义的默认值。

## 功能与权限

书架、共享批注和听读是登录后可用的常规功能。内容可见性、数据所有权、审核和使用限额
由各自的服务端规则执行。原生阅读器的离线划线和笔记按账号保存在本机。
听读优先使用已有音频，按服务端声音能力请求合成。

AI 限额统一作用于所有账号。注册是否需要邀请码由
`auth_signup_config.invitationRequired` 决定，Auth 校验以服务端生效配置为准。

## 配置约定

同一功能的参数归入同一份 Remote config，新增参数优先复用已有 key、服务端缓存和读取函数。
写入端校验字段类型、范围和版本；读取端定义默认值、边界及生效时机。
同步保留未修改字段、审计历史、用户用量和执行中的租约。
配置只存运行参数，凭据、计数、租约和任务状态使用各自的专用存储。

详细边界见 [运行配置复用](../infrastructure/supabase/README.md#runtime-configuration-reuse)。
