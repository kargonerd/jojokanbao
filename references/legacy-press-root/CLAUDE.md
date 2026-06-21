# Claude 开发笔记

## Electron 重启脚本（AI 开发专用）

为避免多窗口问题，提供一键重启脚本：

### PowerShell 脚本
- 文件：`desktop/restart-electron.ps1`
- 用法：`cd desktop && .\restart-electron.ps1`

### 批处理文件（双击运行）
- 文件：`desktop/restart-electron.bat`
- 用法：直接双击运行

### 功能说明
两个脚本都会：
1. 强制终止所有 Electron 进程（多重保险：PowerShell + taskkill）
2. 等待进程完全退出
3. 重新启动 Electron（只开一个窗口）

### 注意事项
- DevTools 已设置为不自动打开
- 如需调试请通过菜单 `视图` -> `开发者工具` 手动开启
