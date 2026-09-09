# Supabase account backend

`migrations/` contains the database schema used by the shared JOJO account.
`config.toml` keeps hosted Auth settings, redirect URLs, and the
`Before User Created` invitation hook under version control.

## Local configuration

The repository root `.env` must contain:

```dotenv
# Local administration only. Never expose this in a browser build.
SUPABASE_ACCESS_TOKEN=
SUPABASE_PROJECT_REF=

# Public browser configuration.
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=

# Existing local operator secret. Do not prefix it with VITE_.
JOJO_OPERATOR_TOKEN=
```

`.env.local` may override values for one machine. Both files are ignored by
Git.

## Apply to a hosted project

Do not apply an unreviewed feature branch to the production project. After the
relevant PR is merged, run these commands from `infrastructure/`:

```bash
cd infrastructure
pnpm dlx supabase link --project-ref <project-ref>
pnpm dlx supabase db push --dry-run
pnpm dlx supabase db push
pnpm dlx supabase config push --project-ref <project-ref>
pnpm dlx supabase functions deploy delete-account
```

The database migration must be pushed before the Auth config because the config
enables a hook backed by `public.hook_require_signup_invitation`.

### Configure the local feature-flag operator

Feature-flag administration reuses the existing `JOJO_OPERATOR_TOKEN`; it does
not use `SUPABASE_ACCESS_TOKEN` and does not require a browser login. After the
feature-flag migration has been reviewed and pushed, register the SHA-256 digest
of that same token once in the target project:

```sql
insert into private.feature_flag_operator_secret (singleton, token_digest)
values (true, extensions.digest('<same JOJO_OPERATOR_TOKEN>', 'sha256'))
on conflict (singleton) do update
set token_digest = excluded.token_digest,
    updated_at = timezone('utc', now());
```

The JOJO Console Flask server reads the plaintext token from the repository
`.env` and sends it only to the protected operator RPC. The Vite client receives
neither the token nor its digest. Keep the console bound to `127.0.0.1`.

The config-aware operator console requires migration
`202608290002_annotation_threshold_feature_config.sql` as well as the original
feature-flag migration. It moves the existing annotation public threshold into
`private.feature_flags.config`, preserves the effective value in historical
revisions, and replaces the publish RPC with the config-aware signature.
Apply the whole migration and record its version in the same transaction;
adding only the column leaves publishing and rollback incomplete. Check pending
migrations before applying a missing older version to an existing project, and
do not reapply a migration already recorded as complete. The migration preserves
all current rollout rules and revisions. After application, run the
[feature configuration smoke test](../../tools/beta-smoke/README.md#feature-configuration).

The database also enforces the signup policy with a trigger. When invitations
are required, new user creation fails closed if somebody disables or bypasses
the hosted hook. Existing users are unaffected.

### Temporarily open registration

Migration `202609090001_optional_signup_invitations.sql` temporarily opens email
registration using `auth.signup.config.invitationRequired = false`. The Auth
hook and redemption trigger remain installed and read the same setting for
each new account. Open registration ignores submitted invitation codes and
does not consume allocations or change existing redemption history. Email
confirmation and password requirements remain enabled.

To restore invitations, open JOJO 管理台 → 功能开关 → `auth.signup` → 注册设置,
enable **注册需要邀请码**, enter a reason, and publish. This reuses Operator
authorization, revision conflict checks, history, and rollback. The setting
applies to all new accounts independently of rollout rules. The migration
records the former required state as revision 1 and the open state as revision 2.

`public.signup_invitation_required()` exposes only this boolean to clients.
Web/Desktop and Mobile refresh it when the account page or registration form
opens, and after a failed registration. Backend checks always read the current
setting. Missing/invalid configuration or an unavailable policy RPC retains
the invitation requirement. Writes require a boolean. Apply the database
migration before releasing the updated clients; already installed Mobile or
Desktop versions retain their old form until updated.

The Auth config explicitly preserves the hosted one-minute email request
interval, 100-email-per-hour project allowance, six-digit OTP setting, TOTP
enrollment, and disabled Vector Storage. Keep these values checked in: omitted
CLI defaults may otherwise appear as unrelated hosted config changes during
`config push`.

Registration, recovery, reauthentication, and password-change email sources
are in `supabase/templates/` relative to the Supabase workdir. They share one
JOJO-branded layout and use the same hosted logo. Hosted templates must be
updated through `config push` or the Management API; committing HTML alone does
not change emails already sent by Supabase. To apply all four templates through
the Management API with credentials from the repository `.env`, run:

```powershell
pwsh infrastructure/supabase/scripts/update-auth-email-templates.ps1
```

The three verification templates display `{{ .Token }}` so Web, Desktop, and
Mobile complete the flow with the same six-digit code and do not depend on an
app link or Deep Link. The legacy `/account/confirm` route remains temporarily
available for confirmation links sent before this rollout.

The `delete-account` Edge Function validates the caller's access token before
using the server-only service role. It removes the reader's avatar objects and
Auth user. Never expose `SUPABASE_SERVICE_ROLE_KEY` to any frontend environment.

The trigger applies to every new Auth user, including users created from the
Supabase dashboard and OAuth identities. Keep those signup paths disabled
while invitations are required unless they supply an invitation. An invitation is redeemed
when the Auth user is created, before the reader confirms their email.

## Runtime configuration reuse

少量、由管理员调整的运行参数优先复用 `private.feature_flags.config` 和现有
JOJO 管理台。新增配置前先查已有 key、读取函数和编辑界面；同一功能的参数放在
同一份配置中，独立功能可以新增 key，不必为每组参数新建一张表。

### 存储边界

| 内容 | 存放位置 | 例子 |
| --- | --- | --- |
| 功能启用范围、灰度规则 | `private.feature_flags.rules` | `reader.annotations` 的开放范围 |
| 限额、阈值、执行时限等运行参数 | 对应 flag 的 `config` | `ai.usage_limits`、`reader.annotations.publicMarkThreshold` |
| 用户用量、并发租约、任务状态和业务记录 | 各自的业务或状态表 | `private.agent_usage_state` |
| 部署地址、环境相关设置、密钥 | 现有部署配置及服务端凭据存储 | 环境变量、Agent 凭据存储 |

`config` 必须是 JSON 对象，现有写入校验限制其序列化文本最多 16,384 字节。
它适合小型参数文档；需要关联查询、独立行级权限或大量独立记录的模型，应使用
适合该数据的结构，并在 PR 中说明现有配置机制不足的原因。
普通客户端 RPC 返回开关结果与版本，原始配置及历史通过受保护的 Operator RPC
读取并在管理台展示；`config` 不是密钥库，不存放密钥或凭据。

`rules` 与 `config` 是两个独立概念；同一 key 的配置是统一参数，不会自动按用户或
灰度规则产生不同值。业务代码需要明确它们的关系。例如
`ai.usage_limits` 始终对所有账号执行，读取 `config` 决定限额，不受规则开关控制；
管理台因此只显示其参数编辑器。不要把必须执行的限额随灰度规则一起关闭。

### 现有配置示例

| Flag key | Config 字段 | 默认值与范围 |
| --- | --- | --- |
| `auth.signup` | `invitationRequired` | 布尔值；缺失时默认 true，本次迁移设为 false |
| `reader.annotations` | `publicMarkThreshold` | 默认 2；整数 1–100 |
| `ai.usage_limits` | `requestsPerMinute` | 默认 3；整数 1–60 |
| `ai.usage_limits` | `requestsPerDay` | 默认 100；整数 1–10,000 |
| `ai.usage_limits` | `maxRunSeconds` | 默认 300 秒；整数 30–600 |

这些是代码默认值，线上实际值以对应 flag 的当前版本为准。AI 限额从
`202609080004_agent_usage_feature_config.sql` 起使用这一配置来源；旧
`private.agent_usage_policy` 已移除，使用计数与租约保留在
`private.agent_usage_state`。每次请求准入读取当前配置，已准入请求沿用当次取得的
执行时限。配置发布或回滚不会清空已有用量，也不会释放正在使用的租约。

### 接入与修改

1. 确认参数归属，复用已有 flag 或创建明确的业务 key，约定字段名、单位、类型、
   范围、默认值和生效时机。保持配置精简，不建立第二份配置来源。
2. 用新迁移初始化配置及对应版本历史。整合旧配置时复制线上实际值，保留已有
   规则、配置字段、历史和业务状态，切换全部读取路径后再删除冗余表；不要修改
   已应用的迁移。线上应用仍遵循本文的合并后迁移流程。
3. 复用 `private.feature_flag_config_integer` 等现有读取能力，并传入明确的默认值
   和边界。写入端也要校验业务字段；通用 JSON 校验不代替参数类型与范围校验。
   AI 限额的数据库校验会同时约束发布、回滚及直接更新。
4. 在 JOJO 管理台现有功能开关页面补参数输入与提示，保留未修改的规则和配置字段。
   通过 Flask 代理调用现有 Operator RPC，浏览器不接收 Operator Token。
5. 日常调整通过 `operator_publish_feature_flag` 提交完整规则、配置、预期版本和
   修改原因。沿用版本冲突检测、修改历史及 `operator_rollback_feature_flag`，
   不另建配置 API 或绕过历史直接更新表。回滚恢复目标版本的规则和配置，并生成
   一个新版本。`requestId` 用于审计，不保证幂等重试；遇到不确定的提交结果先
   读取当前版本核对，不直接重复发布。
6. 根据实际变更验证非法参数拒绝、发布后的业务取值、回滚效果，以及迁移时的状态
   保留。线上验证使用隔离数据并清理，可复用 [已有配置及限额检查](../../tools/beta-smoke/README.md)。

管理入口见 [JOJO 管理台](../../tools/jojo-admin/README.md)。

## Manage invitations

The management commands use the Supabase Management API and the local
`SUPABASE_ACCESS_TOKEN`. They never use a browser key:

```bash
pnpm invite:create
pnpm invite:list
pnpm invite:revoke -- <invitation-id>
```

The create command generates a 6-character code that is valid for 7 days,
can be used once, and is not bound to an email address. Codes are
case-insensitive.

Each authenticated reader also has one lifetime personal invitation allocation
through authenticated database RPCs. Administrator and personal invitations
share the private `signup_invitations` table; `kind` and `owner_user_id`
distinguish them. Codes are stored as 6-character plaintext so an administrator
or the owning reader can retrieve an existing code. Browser roles still have no
direct table access.

A personal code expires after 30 days. An unused code may be regenerated by
rotating the same row; after it is redeemed, that account cannot generate
another. The database serializes generation per account, so concurrent requests
cannot create two usable codes. Administrator-created invitations continue to
use the management commands above. Administrator revocation is persistent:
the owner cannot rotate a disabled code. Deleting an account disables its
personal invitation before removing the ownership link.

The Web account center reads only the authenticated personal-invitation RPCs;
it never receives direct access to the private invitation tables.

## Reader nicknames

Every profile has a unique `display_name` such as `雪豹-TGH`, selected by a
database trigger from a private pool of 3,000 animal and plant names.
The three-letter suffix omits `I` and `O` to avoid confusion with digits. It
provides 41,472,000 possible generated names without loading the pool into the
Web client. Exactly 2,700 base names are three Chinese characters or fewer;
the remaining 300 longer names preserve some variety without requiring a
separate weighting rule in the database trigger.

The checked-in pool includes 173 curated familiar names such as `东北虎`,
`牡丹`, and `蒲公英`, together with 2,827 names derived from *The National
Checklist of Taiwan (Catalogue of Life in Taiwan, TaiCOL)* Version 1.13. The derived names
use accepted species records, are normalized to Simplified Chinese, and are
distributed across taxonomic classes instead of being dominated by insects.
Source attribution:

- Shao K, Chung K (2024), Taiwan Biodiversity Information Facility (TaiBIF)
- DOI: https://doi.org/10.15468/auw1kd
- License: https://creativecommons.org/licenses/by/4.0/

The SQL pool is reproducible from the pinned Darwin Core archive:

```bash
python -m pip install -r supabase/scripts/requirements.txt
python supabase/scripts/build_profile_name_pool.py
```

The builder verifies the source archive checksum before replacing the checked-in
migration, so an upstream dataset change cannot silently alter assigned-name
inputs.

The trigger ignores client-supplied signup metadata, so accounts created
outside the Web client follow the same rule. The migration assigns generated
names to existing profiles and enforces uniqueness in the database.
Authenticated browser clients cannot update them. A future reviewed migration
may introduce reader-controlled renaming without weakening the current
default.

## Database backup and recovery plan

2026-09-08 22:20（北京时间）的只读核查确认：项目使用 Free 计划、PostgreSQL
17.6.1.147；备份 API 没有列出可选恢复点，PITR 未启用，本机两份仓库也没有找到
实际数据备份。因此目前**没有经过确认、可以使用的恢复点**；这不代表平台内部
从未保留备份。以下是待执行的自建方案，本轮没有导出数据或创建备份任务。
[Supabase 官方建议 Free 项目定期自行导出并异地保存](https://supabase.com/docs/guides/platform/backups)。

### 首次备份怎么做

1. 在 Dashboard 的 Connect 面板取得数据库连接信息，默认选 **Session pooler
   的 5432 端口**；网络支持 IPv6 时也可用直连。需要数据库登录密码，浏览器
   Publishable Key、Service Role Key 和 Management API Token 都不能代替它。
   连接串只放在本机私密配置或任务 Secrets 中，不粘贴到聊天、命令历史或日志。
   使用现有密码；没有密码时先找回凭据，不为备份直接重置生产密码。
2. 准备 PostgreSQL **17** 的 `pg_dump`、`psql`，以及与 CI 一致的 Supabase CLI
   `2.114.0` 和 Docker。CLI 在容器中执行导出，实际容器的 `pg_dump` 版本也要
   核对；不要用 16 或更早版本导出这个 17 项目。
   [PostgreSQL 版本兼容说明](https://www.postgresql.org/docs/17/app-pgdump.html#APP-PGDUMP-NOTES)。
3. 在仓库以外、仅操作者可读写的目录创建一份带时间戳的备份。将连接串和目录
   在本机分别注入 `JOJO_BACKUP_DB_URL`、`JOJO_BACKUP_DIR`，从 `infrastructure/`
   **逐条**执行下面的 PowerShell 命令；任一命令退出码非零就停止，本次不能
   记为成功。备份期间避免部署数据库迁移，角色、结构和迁移历史导出需属于
   同一版本；业务数据集中由一次 `--data-only` 导出取得一致快照。

```powershell
pnpm dlx supabase@2.114.0 db dump --db-url "$env:JOJO_BACKUP_DB_URL" --role-only --file "$env:JOJO_BACKUP_DIR/roles.sql"
pnpm dlx supabase@2.114.0 db dump --db-url "$env:JOJO_BACKUP_DB_URL" --file "$env:JOJO_BACKUP_DIR/schema.sql"
pnpm dlx supabase@2.114.0 db dump --db-url "$env:JOJO_BACKUP_DB_URL" --data-only --use-copy -x "storage.buckets_vectors" -x "storage.vector_indexes" --file "$env:JOJO_BACKUP_DIR/data.sql"
pnpm dlx supabase@2.114.0 db dump --db-url "$env:JOJO_BACKUP_DB_URL" --schema supabase_migrations --file "$env:JOJO_BACKUP_DIR/history_schema.sql"
pnpm dlx supabase@2.114.0 db dump --db-url "$env:JOJO_BACKUP_DB_URL" --schema supabase_migrations --data-only --use-copy --file "$env:JOJO_BACKUP_DIR/history_data.sql"
```

普通 `db dump` 只有结构，不包含数据或自定义角色；只导出 `public` 也会漏掉
账号和 `private` 业务状态。首次执行时核对导出表清单确实覆盖 `auth.users`、
`auth.identities`、所有现用 `public` / `private` 业务表及 Storage 元数据；仅检查
表名和数量，不把 SQL 数据行打印到日志。`auth.users` 包含密码哈希，也属于敏感
数据。[CLI 导出选项](https://supabase.com/docs/reference/cli/supabase-db-dump)。

还需与这五个文件放在同一份加密备份中的内容：

| 内容 | 本项目需要覆盖的对象 |
| --- | --- |
| `auth_storage_custom.sql` | `auth.users` 上的建档、邀请码核销/清理触发器，以及 `storage.objects` 上的头像权限策略 |
| Storage 对象副本 | 头像等实际文件及对象路径清单；数据库导出只有元数据 |
| 恢复清单 | 导出开始/结束时间、工具版本、Git commit、迁移版本、表/对象数量、各文件 SHA-256、对应部署配置版本 |

Auth/Storage 的托管结构由目标 Supabase 提供，自定义修改要另外恢复。按
[官方备份与恢复流程](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
在**空迁移基线的临时 Supabase 工作目录**生成 `auth,storage` 的结构差异，人工
核对后保存为 `auth_storage_custom.sql`。不能直接把当前仓库上的空 diff 当作
“没有自定义对象”：这些对象已经写在迁移中，可能与远端相同。不要在恢复时把
全部历史迁移再执行一遍；其中含邀请码回填等数据修改。

部署配置可从本仓库的 `config.toml`、`templates/`、`functions/` 恢复；SMTP、
服务端密钥及用到的加密根密钥由独立凭据库保管，不因 SQL 导出而自动备份。
自定义数据库 `LOGIN` 角色的密码需另行配置；这与 Auth 用户的密码哈希不同。
若实际启用了 Vault/列加密，执行前还须完成官方流程中的加密根密钥保全步骤。

### 存在哪里，多久备份一次

先将上述文件压缩并加密，再存入**仓库以外的私有存储**，另留一份本机加密副本。
例如使用 `age` 公钥加密：任务只持有加密公钥，解密私钥由操作者单独保管并留有
离线副本。上传后核对文件校验值，并实际下载、解密一次；明文工作目录不留作归档。

本仓库是公开仓库，备份不得进入 Git、Release、Actions artifact/cache、公开
日志或现有内容 CDN，即使已经加密也不把它们当备份存储。已有私有存储是否适合
复用，还需核对访问权限、容量和可恢复性；当前没有确认好的备份目的地。

建议先完成一次人工备份及恢复演练，再安排北京时间每日 03:00 备份，保留最近
7 份日备份和 4 份周备份，重要数据库变更前额外留一份。每日方案在正常运行时
最多仍可能损失约 24 小时数据。备份失败或超过 26 小时没有成功备份时才告警；
成功必须包含完整导出、加密、上传校验，不能只看任务退出码。后续自动化可复用
[现有 SCF 调度器与 GitHub Actions](../../tools/maintenance-scheduler/README.md)，
数据库导出在任务运行器执行，不塞进 SCF 的 55 秒执行窗口；当前尚未接入。

### 怎样确认能恢复

首次备份后、以后每月以及重要 Auth/数据库结构变更后，在隔离的 Supabase
测试环境演练。目标为空项目，只预置兼容的 PostgreSQL 17 和 Supabase 托管结构，
不要先应用本项目迁移；关闭真实邮件及外部任务，不覆盖生产项目。按官方步骤
恢复角色、结构、数据、迁移历史及
自定义 Auth/Storage 对象；导入数据时在同一事务中暂设
`session_replication_role = replica`，避免重复触发建档和邀请码核销，使用
`psql -X --single-transaction --set ON_ERROR_STOP=on`，任一错误即回滚。
导入前按 CLI 文档处理目标 `public` 的默认授权，恢复后核对 RLS 和 RPC 权限。

演练至少核对账号/资料数量及关联、已知测试账号登录、邀请码核销、书架/划线/
评论/通知、功能开关与 AI 限额状态、头像文件和权限。确认业务数据不会跨账号
可见，记录恢复耗时和备份时间点；通过这一轮才把文件标记为“已验证恢复点”。

### 费用和当前缺项

`pg_dump` / Supabase CLI 本身不需要购买备份许可，自建逻辑备份也不要求升级
Supabase 计划。[PostgreSQL 许可](https://www.postgresql.org/about/licence/)。
现有公开仓库的标准 GitHub 托管运行器可以免费执行任务；私有存储、流量、SCF
或其他运行器的超额用量，以及云端恢复演练环境可能产生费用，应先核对现有额度。
[GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
Supabase 托管每日恢复点和 PITR 属于另选的付费能力，不是这个方案的前提。

开始执行前还需补齐数据库凭据、工具、私有存储目的地和加密密钥。当前仅有本方案；
没有购买升级、导出用户数据、上传备份、创建自动任务或执行恢复。

## Database tests

Invitation permissions, lifecycle behavior, and generated profile names are
covered by pgTAP tests in `supabase/tests/database/`. From `infrastructure/`,
run:

```bash
supabase db start
supabase test db
supabase stop --no-backup
```

The database CI job runs the same commands. Tests verify browser-role
permissions, administrator and personal generation, code rotation, durable
revocation, account deletion, and atomic Auth redemption.

The checked-in Auth configuration requires at least eight characters for new
passwords, including signup, password changes, and recovery. Existing accounts
can still sign in with a shorter password. Keep the hosted Auth password minimum
in sync with this setting after the change is reviewed and merged.

Registration remains invitation-only at launch. The Auth configuration limits
combined sign-in and signup requests to 10 per five minutes per IP address;
the database validates and atomically redeems invitations. CAPTCHA remains
disabled for this rollout. Before opening registration without invitations,
configure a CAPTCHA provider and support its token in every affected client
flow (including sign-in and recovery), and adapt the AI monitor's password
login. CAPTCHA requires a provider site key and secret, so it is intentionally
a rollout setting rather than a repository default.

## Email verification and recovery

Email confirmation and password recovery both use six-digit codes that expire
after ten minutes. Supabase's built-in SMTP is suitable only for owner testing:
it sends only to project team addresses and currently allows two messages per
hour. Configure custom SMTP before inviting external readers.

Useful official references:

- https://supabase.com/docs/guides/auth/auth-hooks
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/reference/cli/supabase-projects-create
