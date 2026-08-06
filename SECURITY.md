# Security Policy

## 支持范围

JOJO 看报目前只维护 `master` 上的最新版本。历史标签仅用于追溯 Reader
部署，不承诺单独提供安全修复。

## 报告漏洞

请使用 GitHub 仓库 **Security** 页面中的 **Report a vulnerability** 私下提交报告，
不要创建公开 Issue、Discussion 或 Pull Request。

报告中请尽量包含：

- 受影响的模块、版本或 commit
- 可复现步骤和最小验证样例
- 可能的影响和攻击前提
- 建议的缓解方式

请勿在报告中附带真实用户数据、生产 token、私钥或其他不必要的敏感信息。
维护者会在确认问题后协调修复和披露时间。

如果发现已经提交到 Git 或日志中的凭据，应立即撤销并轮换该凭据；仅删除文件或
commit 不能使已经暴露的凭据重新安全。
