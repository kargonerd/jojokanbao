# Web Beta 部署

`beta.jojokanbao.cn` 是公开的提前体验通道，定位类似 Chrome Canary：愿意尝鲜的用户
可以直接访问，功能和界面可能持续调整。它绑定到 EdgeOne Makers 项目的 Preview 环境。

相关 Web、共享前端、Backend 或 EdgeOne 部署文件合入 `master` 后，GitHub Actions 会
自动以 `VITE_ENABLE_PLATFORM_REDESIGN=true` 和 `VITE_RELEASE_CHANNEL=beta` 构建并
发布到 Preview。也可以从 Actions 手动重发 Preview。

Production 标签与手动 Production 发布仍由 `VITE_ENABLE_PLATFORM_REDESIGN` 控制，
并使用 `VITE_RELEASE_CHANNEL=stable`，默认继续提供当前旧版。Beta 自动发布不会切换
普通用户访问的正式站点。

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
- Reader Search SCF：发布已合入的 `https://beta.jojokanbao.cn` CORS 白名单。
- GitHub Preview Environment：配置 `EDGEONE_API_TOKEN` 和 Web 构建所需变量。
- GitHub variable：建议设置 `EDGEONE_BETA_BASE_URL=https://beta.jojokanbao.cn`，部署后
  自动校验线上静态资源版本。

工作流为 Preview 和 Production 使用独立并发队列。连续合并时部署会按队列收敛到最新
master；由于 Beta 域名会跟随 Preview 环境的当前部署，只应合入准备公开体验的版本。
