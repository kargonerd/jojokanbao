# 邮件额度预警

生产适配器为 `infrastructure/tencent-scf/email-quota`，函数名
`jojokanbao-email-quota`，新加坡区事件函数。SCF 原生 Timer 每小时 00、30 分
直接查询 Resend `GET /usage`；不经过 GitHub Actions，不调用邮件发送接口。
GitHub 工作流只做离线代码验证。

## 用量与规则

仅采用官方团队级日/月 `used`、`limit`、`resets_at`，包含监控测试邮件及入站
用量。SDK 不是必需依赖。`/usage` 当前是 private beta；部署前必须用真实凭据
验证访问权限。若未开通，报告采集失败，不能把缺失值或邮件列表估算当成官方
剩余额度。当前实现不自动降级到估算。

拒绝缺失、负数、无效上限、已过期周期或超过 15 分钟的快照。日上限 `null`
表示付费套餐无限日额度；月额度仍检查。周期遵从接口的重置时间，避免自行
计算账期。请求有 8 秒超时及 64 KiB 响应上限；函数上限 55 秒，并发上限 1。

预警和紧急阈值复用 `private.feature_flags` 的 `ops.email_quota.config`：
`warningPercent` 默认 80，`criticalPercent` 默认 90；耗尽固定为 100。
发布端要求整数且 `1 <= warning < critical <= 99`。管理台功能开关页面沿用
Operator 发布、revision 冲突检查、历史与回滚，保留无关配置和规则。
每次检查读取新配置；规则不能关闭额度检查。公开 RPC 只返回这两个非敏感
阈值，不暴露实际用量、规则、账号、密钥或历史。

## 通知和去重

复用现有邮件投递监控绑定的飞书/邮件渠道。Healthchecks 保存日/月各三个
级别的状态，持续超限的重复失败 Ping 不产生重复状态转换；达到更高等级时
对应检查转为 down。额度重置或升级后恢复。新周期首个样本已超限时读取
上次告警周期，先结束旧周期再发新周期告警。这里是按状态转换去重；人为
调整阈值/套餐或用量下调后再次跨线，会产生新的告警。

另有 `jojo-email-quota` 采集心跳，半小时周期、10 分钟宽限，检测读取失败、
配置异常、通知写入失败和 SCF 停跑。条件检查使用一年心跳超时，避免一次
漏跑同时触发六条重复故障。采集失败不清除原有额度告警。Healthchecks 不可用
时保留外部心跳过期检测，不能声称通知送达。

通知内容包含已用、剩余、阈值和接口返回的重置时间。只输出汇总与安全错误
分类，不读取邮件正文、收件人、验证码，不打印 API Key 或 Ping URL。

30 分钟是采样间隔，不是通知延迟保证。Resend 数据缓存、请求重试和通知
渠道会增加延迟；突发用量仍可能在下一次采样前耗尽。

## 验证

```sh
node --test tools/email-quota/*.test.mjs
node infrastructure/tencent-scf/email-quota/build.mjs
```

测试覆盖阈值边界、日/月独立、无限日额度、跨周期、重复事件、恢复、接口
无权限/失效、失败时保留旧告警、只读探测，以及 Healthchecks HTTP 200 忽略
Ping 的情况。真实 `probe` 不发通知；`check` 按真实用量写入告警状态。
