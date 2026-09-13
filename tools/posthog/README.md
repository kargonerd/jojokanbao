# PostHog database contracts

Runtime services read PostHog through their SDKs. This workspace tests the database
contracts used by those services; it does not run in production.

```sh
pnpm --filter @jojo/posthog-ops test
```

Tests apply the complete repository migration chain in PGlite/PostgreSQL, using
fixtures for Supabase Auth, Storage and pgcrypto entry points. They verify operator
credential and business-state preservation, signed signup authorization, atomic
invitation redemption, annotation privacy, trusted policy parameters, and AI
usage/lease enforcement. Supabase CI also runs the pgTAP suite against PostgreSQL.

Configuration keys, SDK caching and coordinated deployment steps are documented in
[docs/posthog.md](../../docs/posthog.md).
