# PostHog runtime configuration

`sync-runtime-config.mjs` copies four validated PostHog Remote config documents
into `private.feature_flags.config`, the durable server configuration cache.
It has no runtime dependencies. The project token reads public payloads, and
the Operator credential authorizes an atomic, audited database update.

Configuration, field ranges and deployment steps are documented in
[docs/posthog.md](../../docs/posthog.md#小型远程配置). The workflow schedules a
best-effort sync every five minutes when enabled on master. A missed or failed
run leaves the last valid configuration in effect. The client QQ group uses
an independent SDK cache.

## Run

Apply the database migrations listed in the
[deployment guide](../../docs/posthog.md#部署与初始化), then provide these process
environment variables:

- `POSTHOG_PROJECT_TOKEN`, `POSTHOG_API_HOST` (US host by default)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- `JOJO_OPERATOR_TOKEN` (GitHub Secret for scheduled runs)

The script reads process environment variables. Run from the repository root:

```sh
node tools/posthog/sync-runtime-config.mjs
```

First binding requires remote values to match the current server snapshot.
Success prints the number checked and keys changed. Identical remote versions
are idempotent; changed remote IDs, stale versions and invalid payloads are
rejected. Use workflow results and the admin's last sync time to check delivery.

Edit and roll back parameters in PostHog. The next successful synchronization
records the remote version and the server revision. Remote config documents
contain public runtime parameters; credentials and operational state belong
in their dedicated stores.

## Tests

```sh
pnpm --filter @jojo/posthog-ops test
```

Tests execute configuration synchronization and AI quota functions in
PGlite/PostgreSQL. Auth infrastructure and pgcrypto entry points use fixtures.
Coverage includes value/history preservation, unavailable services, first
binding, monotonic versions, atomic revision conflicts, parameter validation,
authentication, and usage/lease enforcement.
