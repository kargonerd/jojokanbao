# Web Beta 部署

`beta.jojokanbao.cn` 是公开的提前体验通道，定位类似 Chrome Canary：愿意尝鲜的用户
可以直接访问，功能和界面可能持续调整。它绑定到 EdgeOne Makers 项目的 Preview 环境。

GitHub Actions 手动部署 Preview 时会自动以
`VITE_ENABLE_PLATFORM_REDESIGN=true` 和 `VITE_RELEASE_CHANNEL=beta` 构建新版 Web；
Production 仍由前一个变量控制，并使用 `VITE_RELEASE_CHANNEL=stable`，默认继续提供当前
旧版。合并代码本身不会让普通用户切换到新版。

## 访问与索引

Beta 不使用通行码、登录白名单或访问 Cookie。用户打开域名后会直接进入新版。

Web 部署包包含一个轻量 EdgeOne Middleware，只在 `beta.jojokanbao.cn` 的响应上增加：

```text
X-Robots-Tag: noindex, nofollow, noarchive
```

Beta 构建也会补充等价的 robots meta，并在页头显示 `BETA · 提前体验` 标识。正式构建
不会显示该标识，也不会收到 Beta 的防索引响应头。

## 外部配置

- EdgeOne Domain Management：把 `beta.jojokanbao.cn` 关联到 Preview 环境。
- Supabase Auth Redirect URLs：加入 `https://beta.jojokanbao.cn/account`。
- Reader Search SCF：代码白名单已包含 `https://beta.jojokanbao.cn`，需随本分支发布。

由于 Beta 域名会跟随 Preview 环境的当前部署，只应向 Preview 发布准备公开体验的版本。
