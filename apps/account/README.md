# JOJO Account

独立的统一账号中心。它不依赖 Reader 的路由或业务状态，其他应用通过 `@jojo/auth` 复用同一个 Supabase 用户体系。

## 本地运行

根目录 `.env.local` 需要以下公开浏览器变量：

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

然后在 monorepo 根目录运行：

```bash
pnpm --filter @jojo/account dev
```

本地地址是 `http://localhost:8081`。主要路由：

- `/login`：登录
- `/register`：凭邀请码注册与邮箱确认
- `/forgot-password`、`/reset-password`：密码找回
- `/account`：头像与显示名称

## 部署

账号中心应独立部署，并在部署平台注入同名的 `VITE_SUPABASE_*` 变量。静态托管需要把未知路径回退到 `index.html`，否则直接访问回调或重置密码路由会返回 404。

上线前需要在 Supabase Auth URL Configuration 中把 Site URL 切换为正式账号域名，并保留正式的 `/auth/callback`、`/reset-password` Redirect URLs。面向普通用户发送确认邮件前还需要配置自有 SMTP。

## 邀请注册

注册由 Supabase `Before User Created` 数据库 Hook 强制校验，不能通过绕过前端直接调用 `signUp` 来跳过。邀请码仅以 SHA-256 摘要保存，默认有效期 7 天、使用 1 次，也可以绑定邮箱。

在 monorepo 根目录创建、查看和撤销邀请码：

```bash
pnpm invite:create -- --email reader@example.com --days 7 --uses 1 --note early-reader
pnpm invite:list
pnpm invite:revoke -- <invitation-id>
```

不传 `--email` 会生成不绑定邮箱的邀请码。创建命令只显示一次明文，请立即安全发送给受邀用户。
