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

### Configure the Operator credential

Configuration synchronization and local administration use `JOJO_OPERATOR_TOKEN`.
After applying the reviewed database migrations, register the SHA-256 digest of
the token in the target project:

```sql
insert into private.feature_flag_operator_secret (singleton, token_digest)
values (true, extensions.digest('<same JOJO_OPERATOR_TOKEN>', 'sha256'))
on conflict (singleton) do update
set token_digest = excluded.token_digest,
    updated_at = timezone('utc', now());
```

The JOJO 管理台 Flask server reads the token from the repository `.env` and sends
it to protected Operator RPCs. The browser receives configuration and audit data
only. Keep the local server bound to `127.0.0.1`. Scheduled synchronization uses
the same credential from a GitHub Secret.

Apply complete migrations and record their versions in the same transaction.
Check pending migrations before applying them. Database schema and function
contracts can be verified with the
[configuration smoke test](../../tools/beta-smoke/README.md#feature-configuration).

The database also enforces the signup policy with a trigger. When invitations
are required, new user creation fails closed if somebody disables or bypasses
the hosted hook. Existing users are unaffected.

### Registration policy

Edit `auth_signup_config.invitationRequired` in PostHog Remote config.
The synchronization workflow writes it to `auth.signup.config`; the Auth hook
and redemption trigger read this value for each new account.

When the value is false, registration ignores submitted invitation codes and
does not consume allocations or alter redemption history. When true, a valid
invitation is required. Email confirmation and password requirements apply in
both modes.

`public.signup_invitation_required()` exposes this boolean to clients.
Web/Desktop and Mobile refresh it when the account page or registration form
opens, and after a failed registration. Auth validation uses the current server
value. Missing or invalid configuration and unavailable policy RPCs require an
invitation. The synchronized field must be a boolean.

The local admin displays the server value, remote version, synchronization time
and audit history. PostHog is the parameter editing and rollback entry point.

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

## Product access

Bookshelf, shared annotations and listening are regular authenticated features.
SQL entry points require login; ownership, content visibility, moderation and
quotas are enforced by their respective service rules.

The compatibility RPC `get_my_feature_flags` returns stored rule snapshots.
Operator snapshots expose configuration and audit history. Bookshelf entries,
annotations and usage state belong to their own business tables.

## Runtime configuration reuse

`auth.signup`、`reader.annotations`、`ai.usage_limits`、`ops.email_quota`
在 PostHog Remote config 中管理。业务读取 `private.feature_flags.config` 的服务端缓存，
`tools/posthog` 校验并异步同步配置。管理台展示实际值、同步时间、远端版本和审计历史。
QQ群号由客户端读取公开的 `support_config` 并持久缓存。

新增参数优先复用已有 Remote config 文档、业务 key、缓存和读取函数。
同一功能的参数放在同一份配置，独立功能可以新增明确的业务 key。
字段类型、范围、默认值和生效时机应与使用方一起定义。

### 存储边界

| 内容 | 存放位置 | 例子 |
| --- | --- | --- |
| 限额、阈值、执行时限等参数 | PostHog Remote config；服务端缓存于对应 key 的 `config` | AI 使用限额、批注公开阈值 |
| 客户端公开配置 | PostHog Remote config 与客户端持久缓存 | `support_config.qqGroup` |
| 用户用量、并发租约、任务状态和业务记录 | 各自的业务或状态表 | `private.agent_usage_state` |
| 部署地址、环境相关设置、密钥 | 部署配置及服务端凭据存储 | 环境变量、Agent 凭据存储 |

服务端配置是 JSON 对象，序列化文本最多 16,384 字节。
需要关联查询、独立行级权限或大量独立记录的数据使用对应业务存储，
并在 PR 中说明结构选择。PostHog payload 是公开配置，只存可公开的运行参数。

普通客户端通过专用 RPC 读取业务所需字段；数据库完整配置和审计历史由
受保护的 Operator RPC 提供。AI 限额统一作用于所有账号，按参数值执行，
配置发布及回滚保留已有用量和执行中的租约。

### 配置字段

| 数据库 key | PostHog Remote config | 字段 | 默认值与范围 |
| --- | --- | --- | --- |
| `auth.signup` | `auth_signup_config` | `invitationRequired` | 布尔值；缺失时默认 true |
| `reader.annotations` | `reader_annotations_config` | `publicMarkThreshold` | 默认 2；整数 1–100 |
| `ai.usage_limits` | `ai_usage_limits_config` | `requestsPerMinute` | 默认 3；整数 1–60 |
| `ai.usage_limits` | `ai_usage_limits_config` | `requestsPerDay` | 默认 100；整数 1–10,000 |
| `ai.usage_limits` | `ai_usage_limits_config` | `maxRunSeconds` | 默认 300 秒；整数 30–600 |
| `ops.email_quota` | `ops_email_quota_config` | `warningPercent` / `criticalPercent` | 默认 80 / 90；整数，1 ≤ warning < critical ≤ 99 |
| `ops.email_quota` | `ops_email_quota_config` | `usageSource` | 默认 records；records 或 usage_api |
| `ops.email_quota` | `ops_email_quota_config` | `dailyLimit` / `monthlyLimit` | 默认 100 / 3000；整数，分别为 1–1,000,000 / 1–100,000,000 |

代码默认值用于读取兜底，线上实际值以成功同步的配置为准。
AI 请求准入时读取配置，已准入请求沿用当次取得的执行时限；
参数修改在下一次成功同步后的业务读取中生效。

### 接入与修改

1. 确认参数归属，复用已有配置或定义新的业务 key，并明确字段、单位、类型、范围、
   默认值及生效时机。
2. 服务端参数通过数据库迁移初始化缓存与审计历史，并在
   `tools/posthog` 的同步映射和数据库同步函数中登记。初始 PostHog 文档匹配部署目标的实际值。
3. 读取端复用 `private.feature_flag_config_integer` 等能力；
   导入程序和数据库写入端同时校验业务字段。
4. 参数调整与回滚在 PostHog 完成。同步使用 Operator 鉴权、远端版本及数据库 revision
   检查，在同一事务中提交整批配置，并保留未修改字段和历史。
5. 用管理台确认服务端实际值与同步时间；验证参数边界、业务生效、回滚和状态保留。
   部署及首次绑定步骤见 [PostHog](../../docs/posthog.md#部署与初始化)。

任一配置缺失、非法或版本冲突时，整批同步失败，业务继续使用最后有效缓存。
网络故障期间配置仍有效。管理入口见 [JOJO 管理台](../../tools/jojo-admin/README.md)。

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
