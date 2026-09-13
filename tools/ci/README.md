# CI 影响范围

`affected.mjs` 比较 CI 的 base/head 提交，输出各检查的开关。PR 仍验证
GitHub 的合并结果，`build-and-test`、`e2e` 和分支保护保持不变。

- Node 检查继续使用原来的路径规则；根 `package.json` 或锁文件变化仍检查所有 Node 工作区。
- Archive 发布脚本、JOJO 格式转换、人民日报审核发布脚本和同步工作流变化时，保留独立的 `archive_pdf` 检查；其结果仍进入 `build-and-test`。
- iOS、Web 和 Desktop 额外比较各自的 pnpm 依赖图，包括间接依赖、可选依赖、peer 版本、补丁和共享工作区。
- 只有其他产品使用的依赖或补丁变化时，跳过无关端的原生构建和浏览器测试。
- 根构建脚本、Node/pnpm 配置、CI 本身或未识别的锁文件格式变化时，回退到完整检查。手动运行 CI 也执行完整检查。
- `changes` 筛选安装 `@jojo/ci` 工具，并先运行分类器测试；解析失败不能让 CI 误报通过。

```sh
pnpm --filter @jojo/ci test
# 用历史提交验证范围；输出只含路径和检查开关。
EVENT_BASE_SHA=<base> EVENT_HEAD_SHA=<head> node tools/ci/affected.mjs
```

回放 Antigravity PR #276（`10735e78^1` → `10735e78`），Node、Cloud API 和
Times 检查保留，iOS/Web/Desktop 检查跳过。原先两次 PR CI 分别耗时 7 分 5 秒、
19 分 8 秒，iOS 是最长任务；其中第二次 Node 检查耗时 3 分 58 秒。
新规则可移除这类 PR 的 iOS 等待时间，实际总耗时仍取决于 runner 和其他检查。

iOS 真正受影响时仍执行 Release 编译和模拟器启动验证。CI 的 `xcodebuild`
通过 `ARCHS="$(uname -m)"` 只编译当前 runner 可运行的模拟器架构，避免重复编译
ARM 和 Intel 两套产物。正式 iOS 发布工作流使用原有设备构建配置。
成功编译的 `JOJO.app` 会缓存。缓存键包含移动端和共享源码、依赖锁文件与补丁、
CI 配置、客户端配置、Xcode、macOS 和 runner 镜像版本；不使用模糊匹配。
源码指纹在安装依赖和生成工程前计算，避免把生成文件混入缓存键。
命中缓存时跳过工程生成、Pods 安装和编译，但仍安装依赖、验证 Hermes 补丁，
并执行模拟器启动测试。编译后先保存应用，再执行启动测试，避免启动超时后的
重试或无关主分支更新重复编译相同应用。不缓存测试结果或中间 Xcode 工程。

`react-native@0.83.10` 补丁为 Hermes 下载检查增加有限重试。预编译仓库仍不可用时，
从 SDK 自带 `.hermesversion` / `.hermesv1version` 指定的标签构建，避免自动拉取
不兼容的开发分支；缺少固定标签时明确失败。iOS 任务在安装 Pods 前运行
`hermes-source.test.rb`，直接验证已安装补丁的正常下载、故障回退和显式版本覆盖。
原生任务的 45 分钟上限为仓库故障时的源码构建预留启动验证和收尾时间；它不增加正常
构建的步骤，也不影响不涉及移动端的 PR。
模拟器成功启动后复用已采集的截图和日志，仅失败时在收尾中补采诊断，避免重复
运行较慢的 `simctl` 诊断命令。

Firefox/WebKit 任务安装 Playwright 依赖前，移除临时 runner 中不使用的 Chrome
软件源，避免它的索引校验错误阻塞 Ubuntu 系统库安装。包校验仍由 APT 正常执行，
浏览器由 Playwright 下载。这个清理与 [GitHub runner 镜像的处理方式](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh)一致。
