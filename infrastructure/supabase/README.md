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

The database also enforces redemption with a trigger. Therefore new user
creation fails closed if somebody disables or bypasses the hosted hook.
Existing users are unaffected.

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
unless they are updated to supply an invitation. An invitation is redeemed
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
