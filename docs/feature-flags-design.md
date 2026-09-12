# 运行配置与已退役的功能开关

当前接入与发布步骤以 [PostHog](posthog.md) 为准。

书架、共享批注、听读已成为登录后可用的常规功能，不再读取产品 Boolean flags。
Web/Desktop/Mobile 移除了这些功能的开关同步、轮询和缓存；整站新旧界面切换与
Supabase/PostHog provider 选择器也已删除。RAG/Olds 历史工作区开关没有现行调用方。

PostHog 保留五份 Remote config：注册邀请码策略、批注公开阈值、AI 限额、邮件额度、QQ群号。
服务端的前四组参数由后台同步到原有 `private.feature_flags.config`，业务读取本地数据库缓存；
QQ群号由各端独立于统计的公开配置 SDK 读取并持久缓存。注册界面和 Auth 校验读取同一份服务端策略。

`202609120002_retire_product_flags.sql` 退役三项产品与两个历史工作区的管理入口，
保留所有旧规则、参数、版本和修改历史。共享批注所在行仍承载公开阈值配置。
旧客户端继续使用 `get_my_feature_flags`，新客户端直接遵循登录、所有权和内容可见性规则。
服务端 TTS 新音频生成设置 `JOJO_TTS_ENABLED` 保留。

新参数必须复用已有配置入口，保留未知字段及当前线上值；校验类型、范围、版本，
并通过现有 Operator 审计发布。不得用规则关闭必须执行的限额，也不把密钥、计数、租约、任务状态写入配置。
详细约定见 [运行配置复用](../infrastructure/supabase/README.md#runtime-configuration-reuse)。
