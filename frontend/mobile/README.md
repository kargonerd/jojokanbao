# JOJO 看报 Mobile

`@jojo/mobile` 是 JOJO 看报的 Android/iOS 客户端，使用 Expo 55、React Native 0.83、React Navigation 和 Zustand。

## 产品与架构

- “今日”、资料库、搜索、“我”、设置、阅读记录均为原生 React Native 界面。“我”使用与 Web 共用的 `@jojo/auth` 登录和账号状态。
- 报刊目录、期号格式、CDN/搜索地址与特殊 PDF 文件规则来自 `@jojo/content`，Web 和 Mobile 共用一份领域代码。
- 阅读页复用 `reader.jojokanbao.cn` 的 PDF.js 阅读内核，通过轻量 WebView bridge 同步页码和阅读记录。线上 PDF 带 JOJO 字节掩码保护；这种方式可以继续使用 Range 分段加载，避免在手机内存中一次性解密整份大 PDF。
- 原生栈负责 iOS 侧滑返回、Android 系统返回、系统分享、安全区、触感反馈、日期选择和底部导航。
- 书籍阅读页的书内 AI 直接流式请求国际 Makers Agent；对话、提问范围与引用写入
  Makers Store。面板内的“历史”只列当前 Item，可恢复、删除或开始新对话。
- 标准版与 Android 墨水屏版是两个独立 release，不提供运行时切换。墨水版固定使用黑白高对比主题，关闭动画、过渡、阴影与列表回弹，并可与 Android 标准版同时安装；墨水版不发布 iOS。

## 本地开发

在仓库根目录运行：

```bash
pnpm install
pnpm dev:mobile

# 启动固定墨水屏变体
pnpm --filter @jojo/mobile start:eink
```

可选环境变量：

```dotenv
# 默认 https://reader.jojokanbao.cn
EXPO_PUBLIC_READER_BASE=https://reader.jojokanbao.cn
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
# 默认 https://agent-global.jojokanbao.cn/rag
EXPO_PUBLIC_AGENT_API_URL=https://agent-global.jojokanbao.cn/rag
```

质量检查：

```bash
pnpm --filter @jojo/mobile typecheck
pnpm --filter @jojo/mobile test
pnpm --filter @jojo/mobile run doctor
pnpm --filter @jojo/mobile build
pnpm --filter @jojo/mobile build:eink
```

`build` 生成 Android 与 iOS 的 production JS bundle，用来在 CI 中发现 Metro/跨包解析问题；商店原生包由 EAS 生成。

账号登录需要上述两个 Supabase 公共环境变量。本地构建前应写入 shell 环境；EAS 构建前应在对应 EAS environment 中创建同名变量。

## Android / iOS 构建

开发客户端：

```bash
eas build --platform android --profile development
eas build --platform ios --profile development
```

内部测试包（Android 为 APK）：

```bash
eas build --platform all --profile preview
eas build --platform android --profile eink-preview
```

正式商店包：

```bash
eas build --platform all --profile production
eas build --platform android --profile eink-production
```

标准版的 Android 包名与 iOS Bundle ID 为 `com.luoxixi.jojokanbao`，Android 墨水版包名为 `com.luoxixi.jojokanbao.eink`。两条 Android 发布线共用同一份代码和 EAS project，但各自使用独立商店应用标识；首次构建墨水版时需要为新包名生成凭据。更换证书、团队或 Expo 项目时，先执行 `eas init`/`eas credentials`，不要把签名文件提交到仓库。

## GitHub Release（Android）

标准版和墨水版各自使用独立 workflow，发布方式与桌面端一致：手动运行时生成 Actions artifact，推送匹配 `frontend/mobile/package.json` 版本的 tag 时，自动通过 EAS 构建稳定签名 APK，并把 APK 与 `SHA256SUMS.txt` 发布到 GitHub Release。

- `.github/workflows/release-mobile.yml`：标准 Android，tag 为 `mobile-v*`
- `.github/workflows/release-mobile-eink.yml`：墨水 Android，tag 为 `mobile-eink-v*`

首次启用前需要完成两项一次性配置：

1. 分别交互运行一次 `eas build --platform android --profile preview` 和 `eas build --platform android --profile eink-preview`，为两个 Android 包名建立各自稳定的 keystore；
2. 在 GitHub Actions repository secrets 中添加有权访问本 EAS project 的 `EXPO_TOKEN`。

发布示例：

```bash
git tag mobile-v0.0.1-rc1
git push origin mobile-v0.0.1-rc1

git tag mobile-eink-v0.0.1-rc1
git push origin mobile-eink-v0.0.1-rc1
```

正式发布后每个包名必须持续使用各自同一套 EAS Android 凭据，否则已安装用户无法覆盖升级。两个 GitHub Release workflow 都只构建 Android APK，不包含 iOS job。

## 鸿蒙边界

当前不能从 Expo 工程直接生成 HarmonyOS NEXT 包。OpenHarmony 的 RNOH 工具链是独立原生工程，并且第三方原生模块需要各自的鸿蒙实现。为了降低后续迁移成本，本客户端已经做到：

- 领域模型、搜索客户端、URL 规则和阅读 bridge 都是平台无关 TypeScript；
- 原生能力集中在 WebView、AsyncStorage、DateTimePicker、Haptics 与导航层；
- 主界面只使用 React Native 基础组件，不依赖 Skia、Reanimated 或私有原生 UI。

真正交付鸿蒙包仍需单独建立 RNOH/DevEco 工程，逐项替换上述 5 类原生依赖并完成签名、真机和应用市场验证；在这条链路验证前，不应宣称已经支持鸿蒙。
