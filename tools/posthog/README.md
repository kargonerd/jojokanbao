# PostHog runtime configuration

`sync-runtime-config.mjs` copies four validated PostHog Remote config documents
into the existing server configuration cache. It has no runtime dependencies.
The PostHog project token can read the public payloads; the existing Operator
credential authorizes one atomic, audited database update. Never include secrets
in a Remote config document.

Configuration, field ranges, cutover and rollback are documented in
[docs/posthog.md](../../docs/posthog.md#小型远程配置). The workflow schedules a
best-effort sync every five minutes after explicit activation on master. A missed
or failed run leaves the last valid configuration in effect. The client QQ group
uses its own SDK cache and does not depend on this workflow.

Required process environment (the script does not load `.env`):

- `POSTHOG_PROJECT_TOKEN`, `POSTHOG_API_HOST` (US host by default)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- `JOJO_OPERATOR_TOKEN` (GitHub Secret for scheduled runs)

Run from the repository root after applying both PostHog migrations:

```sh
node tools/posthog/sync-runtime-config.mjs
```

First binding requires remote values to match the current server snapshot.
Success prints only the number checked and keys changed; retries with identical
remote versions are idempotent. Inspect workflow failures and the admin's last
sync time. Do not blindly recreate remote flags: a changed remote ID is rejected.

```sh
pnpm --filter @jojo/posthog-ops test
```

Tests execute the existing configuration and AI quota functions plus the new
migration in PGlite/PostgreSQL. Only unrelated Auth infrastructure and pgcrypto
entry points are fixtures. They verify live-value/history preservation, offline
failure handling, first binding, monotonic versions, atomic revision conflicts,
parameter validation, authentication and unchanged usage/lease enforcement.
