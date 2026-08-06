# Contributing to JOJO 看报

感谢你愿意参与 JOJO 看报。提交代码前，请先阅读
[ARCHITECTURE.md](./ARCHITECTURE.md) 和对应目录下的 README。

## 开发环境

- Node.js 22.19.0 或更高版本
- pnpm 9.12.2
- Python 3.10 或更高版本（修改 Python 服务时）

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

修改 Python 后端时还需运行：

```bash
python -m pip install -r backend/requirements-dev.txt
pnpm test:backend
```

## 提交 Pull Request

1. 从最新 `master` 创建短期分支。
2. 每个 PR 只解决一个清晰问题，并补充相应测试和文档。
3. 不得提交 token、密码、私钥、生产数据或本地 `.env`。
4. 不得绕过功能开关启用尚未上线的 Account、RAG 或 Olds 功能。
5. 修改 `.github/workflows/` 时保持最小权限，并将所有 Action 固定到完整 commit SHA。
6. PR 必须通过仓库要求的检查、代码所有者审核和 review。

如果改动涉及线上行为、数据库 migration、认证、部署或数据删除，请在 PR
说明中明确风险、回滚方式和验证结果。

安全问题不要提交公开 Issue，请按照 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

向本仓库提交贡献，即表示你有权提交这些内容，并同意贡献内容按照
[GNU Affero General Public License v3.0 only](./LICENSE)（SPDX:
`AGPL-3.0-only`）发布。第三方代码必须保留原许可证和署名，并在需要时更新
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
