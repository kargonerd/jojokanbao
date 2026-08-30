# Third-Party Notices

JOJO 看报的原创源代码使用
[GNU Affero General Public License v3.0 only](./LICENSE)。本许可证不会替代仓库
依赖项、数据或素材各自适用的许可证和权利声明。

## JavaScript 与 TypeScript 依赖

Node.js 依赖由各 workspace 的 `package.json` 和根目录 `pnpm-lock.yaml` 锁定。
依赖项保留其上游许可证；安装后的完整许可证文本位于对应包目录中。当前依赖清单
包含 MIT、Apache-2.0、BSD、ISC、MPL-2.0、CC0、CC-BY-4.0、Python-2.0、
BlueOak-1.0.0、Unlicense 及声明的多重许可证组合。

可使用以下命令检查当前锁定版本的许可证：

```bash
pnpm install --frozen-lockfile
pnpm licenses list
```

### PDF.js

本项目使用 Mozilla 的 `pdfjs-dist`（Apache License 2.0），并在
`frontend/patches/pdfjs-dist@5.7.284.patch` 中维护兼容性补丁。Web 和 Desktop
构建会分发来自该包的 worker、CMap、WASM 和 standard-font 资源。PDF.js 的原始
许可证和第三方资源声明以锁定版本包内文件为准：

- <https://github.com/mozilla/pdf.js>
- <https://www.apache.org/licenses/LICENSE-2.0>

## Python 依赖

Python 依赖及版本范围记录在 `backend/requirements*.txt`、各 `tools/` 子项目和
`infrastructure/tencent-scf/search/requirements.txt` 中。它们分别适用各自的上游
许可证，本仓库的 AGPL 许可证不会改变这些许可证。

## 数据清单

`tools/news-archive/data/bloomberg-2020-archive-manifest.jsonl.gz` 是 Bloomberg
archive 工具使用的清单数据，不是 JOJO 看报的原创软件代码，也不因本仓库采用
AGPL 而获得额外授权。使用、再分发或基于该清单访问内容前，应自行确认数据来源及
适用条款。

## 品牌、内容与报刊素材

JOJO、JOJO 看报的名称和品牌素材不因源代码许可证而授予商标权。

`frontend/web/src/archive/assets/` 中的报刊封面缩略图仅用于识别对应出版物；
相关报刊名称、版面和图像的权利属于各自权利人，不在 AGPL 源代码许可范围内。
用户通过本项目访问、导入或生成的报刊、书籍和其他内容也不因使用本软件而改变其
原有权利归属。

如果新增需要随源码或构建产物分发的第三方代码、字体、图像或数据，请在合并前
确认再分发权限，并同步更新本文件。
