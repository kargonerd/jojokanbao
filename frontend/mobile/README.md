# JOJO Times mobile

## 当前状态
- 技术栈：Expo 55 + React Native 0.83
- App 名称：`JOJO Times`
- Android 包名：`com.luoxixi.jojotimes`
- Expo owner：`luoxiaozhuang`
- EAS projectId：`ce6a6762-1d7b-464e-9622-cf1591b4cb02`

## 已落地的 APK 构建方式
本项目当前走 **EAS 云构建** 出 Android APK。

相关配置：
- `app.json`：应用名、包名、EAS projectId
- `eas.json`：`preview` profile 使用 `buildType: "apk"`
- `.env`：`EXPO_PUBLIC_API_BASE`

`eas.json` 当前配置：

```json
{
  "cli": {
    "version": ">= 18.5.0",
    "appVersionSource": "local"
  },
  "build": {
    "preview": {
      "android": {
        "buildType": "apk"
      }
    }
  }
}
```

## 构建命令
在 `frontend/mobile` 目录执行：

```bash
eas build -p android --profile preview
```

构建成功后会得到一个 APK 下载链接。

本次已验证成功的构建产物：
- Build URL: `https://expo.dev/accounts/luoxiaozhuang/projects/mobile/builds/9fa36972-9e63-461f-b361-5cfed7c4a3ce`
- APK URL: `https://expo.dev/artifacts/eas/kHkVZemxZQmbnwD823Jc45.apk`

## 环境变量
当前移动端 API 地址：

```env
EXPO_PUBLIC_API_BASE=http://192.168.1.16:3002
```

注意：
- 这个值适合真机连同一局域网调试
- 如果电脑 IP 变化，必须同步更新
- 如果改回模拟器或本机调试，需要换成对应地址

## 图标资源
当前不维护 Times 专用图标，后续统一接入 JOJO 看报品牌图标。

## 这次踩过的坑

### 1. 本地 Android 打包链路不如 EAS 直接
虽然环境里有 `adb` 和 `java`，但当前项目没有已提交的原生 `android/` 工程，直接走 EAS 更快。

### 2. EAS CLI 需要单独可用
如果终端里出现：

```bash
bash: eas: command not found
```

说明当前 shell 没拿到 EAS CLI，需要重新安装或确认全局 npm bin 在 PATH 中。

### 3. Expo 依赖版本要对齐
构建前需要让 `expo-doctor` 能过。移动端依赖最终对齐到了：
- `expo`: `55.0.11`
- `expo-status-bar`: `55.0.5`
- `react`: `19.2.6`
- `react-native`: `0.83.4`

### 4. 真机联调不能用 127.0.0.1
真机安装 APK 后，`127.0.0.1` 指向的是手机自己，不是开发机，所以 API base 必须换成电脑局域网 IP。

## 后续如果重新打包
1. 确认 `app.json` 名称、包名无误
2. 确认 `.env` 里的 `EXPO_PUBLIC_API_BASE` 可被手机访问
3. 执行：

```bash
eas build -p android --profile preview
```

4. 下载生成的 APK 安装到手机验证
