# Web Beta 部署

`beta.jojokanbao.cn` 绑定到 Makers 项目的 Preview 环境。GitHub Actions 手动部署
Preview 时会构建新版 Web；Production 仍由 `VITE_ENABLE_PLATFORM_REDESIGN` 控制。

## Preview 环境访问保护

Web 部署包包含 EdgeOne Middleware。请只在 Makers 的 **Preview** 环境配置：

```text
JOJO_BETA_ACCESS_MODE=required
JOJO_BETA_ACCESS_PASSWORD_SHA256=<通行码的 UTF-8 SHA-256，小写十六进制>
JOJO_BETA_HOSTS=beta.jojokanbao.cn
JOJO_BETA_SESSION_HOURS=168
```

不要把通行码或其哈希放进 `VITE_` 变量。Production 环境不要设置
`JOJO_BETA_ACCESS_MODE=required`。即使 Preview 环境变量漏配，Beta 自定义域名也会
返回 503，而不是公开页面。

Middleware 在 `POST /__beta/access` 验证通行码，成功后签发 `HttpOnly`、`Secure`、
`SameSite=Strict` Cookie。Cookie 的到期时间也由服务端签名校验；修改 Cookie 或延长
到期时间都会失效。所有通过门禁的响应带 `noindex` 和 `no-store`。

变更 Preview 环境变量后需要创建一次新部署。通行码需要轮换时，修改哈希并重新部署；
已有 Cookie 会立即失效。

## 外部配置

- EdgeOne Domain Management：把 `beta.jojokanbao.cn` 关联到 Preview。
- Supabase Auth Redirect URLs：加入 `https://beta.jojokanbao.cn/account`。
- Reader Search SCF：代码白名单已包含 `https://beta.jojokanbao.cn`，需随本分支发布。
