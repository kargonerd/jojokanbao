# 客户端发行、下载与自动更新

## 目标

客户端发行物继续存放在现有 Backblaze B2 桶（当前为 `jojo-newspaper`），但只使用独立的
`releases/` 前缀。内容发布任务不得读写该前缀，客户端发布任务也不得读写内容对象。

对外复用现有 `https://blacknews.jojokanbao.cn` CDN，并将客户端对象隔离在 `/releases/`。官网只读取各渠道的 `catalog.json`，不会在
构建时写死某个安装包文件名。GitHub Release 是发行记录和备用下载源，B2 + CDN 是客户端的
主下载源和自动更新源。

## 对象布局

```text
jojo-newspaper/
  releases/
    desktop/
      stable/
        win-x64/       *.exe, *.blockmap, latest.yml
        mac-arm64/     *.dmg, *.zip, *.blockmap, latest-mac.yml
        mac-x64/       *.dmg, *.zip, *.blockmap, latest-mac.yml
        linux-x64/     *.AppImage, *.deb, *.blockmap, latest-linux.yml
        catalog.json
        SHA256SUMS.txt
    mobile/
      android/
        stable/        *.apk, catalog.json, SHA256SUMS.txt
      android-eink/
        stable/        *.apk, catalog.json, SHA256SUMS.txt
```

带版本号的安装包和差分文件是不可变对象；工作流使用 `rclone --immutable`，同名内容不一致时
直接失败。`catalog.json`、`latest*.yml` 和 `SHA256SUMS.txt` 是渠道指针，只有所有安装包经 CDN
下载并校验 SHA-256、GitHub Release 已公开后才覆盖。

## CDN 与 B2 配置

1. `blacknews.jojokanbao.cn` 继续指向同一个 B2 桶，URL 路径原样映射到桶内对象，不添加或
   删除 `releases/`。为 `/releases/` 增加独立缓存规则，不改变现有内容对象规则。
2. 仅允许 `GET`、`HEAD` 和 Range 请求。对官网读取 `catalog.json` 返回
   `Access-Control-Allow-Origin: https://reader.jojokanbao.cn`；预览站需要时加入明确的预览域名，不使用
   带凭证的通配 CORS。
3. 对版本化安装包、`.blockmap` 和 `.zip` 使用一年缓存并标记 `immutable`。对
   `catalog.json`、`latest*.yml`、`SHA256SUMS.txt` 使用短缓存（建议 60 秒）并允许重新验证。
4. 保留正确的 MIME 类型、`Content-Length`、`ETag` 和 Range 响应；APK 可使用
   `application/vnd.android.package-archive`。
5. 为 GitHub Actions 创建只允许写入 `releases/` 前缀的 B2 Application Key。仓库继续使用
   `B2_KEY_ID`、`B2_APPLICATION_KEY`、`B2_BUCKET` 三个 secret；`B2_BUCKET` 应指向现有内容桶。
6. B2 生命周期规则按前缀配置。不要让内容桶现有的清理规则匹配 `releases/`；至少保留当前和上一
   个可回滚版本。渠道指针不能设置为不可覆盖对象。

CDN 完成配置前，发行工作流会在“Verify … through CDN”步骤失败，并保持 GitHub Release 为草稿，
不会向客户端发布一个不可下载的更新。

## 自动更新边界

| 客户端 | 更新内容 | 机制 | 用户确认 |
| --- | --- | --- | --- |
| Windows / macOS / Linux | 原生桌面包 | `electron-updater` 读取各平台 `latest*.yml` | 后台下载，安装前提示重启 |
| Android 标准版 / 墨水版 | JS 与静态资源 | EAS Update；按 runtime version 和渠道隔离 | 下次启动自动生效，也可在设置中手动检查 |
| Android 标准版 / 墨水版 | 原生 APK | B2 `catalog.json` 比较单调递增的 `versionCode` | 打开 CDN 下载，仍由 Android 系统确认安装 |
| iOS | JS 与静态资源 | EAS Update，同样受 runtime version 约束 | 下次启动自动生效 |
| iOS | 原生包 | App Store / TestFlight | 由 Apple 更新流程负责 |

Android 不申请 `REQUEST_INSTALL_PACKAGES`，也不尝试静默安装。这样网站分发 APK 可以由系统安装器
验证签名，同时不会把自更新能力带入将来的 Google Play 包。已安装版本与新 APK 必须始终使用同一
签名证书；否则 Android 会拒绝覆盖安装。

EAS Update 只保留两条正式渠道，普通版和墨水屏版在各自渠道内按比例灰度：

```text
standard -> production-standard
eink     -> production-eink
```

新 OTA 必须以 5%、10%、25% 或 50% 开始，不能首次直接发布给 100% 用户。GitHub Actions
会在任务摘要中记录 EAS update group ID；后续使用同一工作流的 `adjust` 操作逐步扩大到 100%，
或使用 `rollback` 撤回当前灰度。仓库不维护 preview/beta 客户端。

`runtimeVersion.policy` 使用 `appVersion`，所以涉及原生模块、权限、Expo SDK 或原生配置的修改必须先
提升 `frontend/mobile/package.json` 和 `app.json` 的版本并发布新安装包，不能只发 OTA。

## 仓库配置

GitHub Actions variables：

- `DOWNLOAD_CDN_BASE`：可选，默认 `https://blacknews.jojokanbao.cn`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

GitHub Actions secrets：

- B2：`B2_KEY_ID`、`B2_APPLICATION_KEY`、`B2_BUCKET`
- Expo：`EXPO_TOKEN`
- Windows 签名：`WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD`
- macOS 签名与公证：`MACOS_CSC_LINK`、`MACOS_CSC_KEY_PASSWORD`、`APPLE_ID`、
  `APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`

桌面工作流把签名凭据作为发行硬门槛。没有签名或 macOS 公证时不会生成可公开下载的包。

## 发行流程

1. 同步修改对应客户端的 `package.json` 版本；Mobile 还要同步 `app.json` 的 `expo.version`。
2. 合并并确认 CI 通过。客户端只发布无预发布后缀的 SemVer；`-rc`、`-beta` 等版本会被
   发行工作流拒绝。
3. 创建并推送对应 tag：`desktop-vX.Y.Z`、`mobile-vX.Y.Z` 或
   `mobile-eink-vX.Y.Z`。
4. 工作流构建、签名、校验，将安装包写入 B2，公开 GitHub Release，再发布渠道指针。
5. 检查 `https://reader.jojokanbao.cn/download`，并从真实设备完成一次升级验证。

仅修改 JS/资源且不涉及原生兼容性时，手动运行 `Release · Mobile OTA Rollout`：选择
`publish`、客户端变体、初始灰度比例和清晰的用户可读说明。观察 EAS insights 后，使用任务
摘要中的 update group ID 执行 `adjust` 放量，或执行 `rollback` 回滚。

## 回滚与紧急处置

- Mobile OTA：对正在灰度的 update group 运行工作流的 `rollback`；已经全量发布时在 EAS 中
  回滚到上一条兼容 update。不要改变 runtime version 来伪造回滚。
- Mobile APK：Android 的 `versionCode` 不能降低。基于上一个稳定提交构建修复版，并使用更高的
  `versionCode` 发布。
- Desktop：重新发布修复版本，版本号必须高于已发布版本。不要把旧二进制复制成新的渠道指针。
- CDN/B2 故障：不要单独手工推进 `catalog.json` 或 `latest*.yml`。先恢复文件可下载性，再重跑失败的
  发行任务；草稿 GitHub Release 可继续作为事务边界。

每次发布后应记录安装成功率、更新失败率和崩溃版本分布。当前仓库尚未接入客户端遥测，因此上线
初期至少保留 GitHub Actions、EAS 和 CDN 请求日志，并把首次升级作为人工发布检查项。
