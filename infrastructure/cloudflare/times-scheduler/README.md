# Times scheduler

This Cloudflare Worker is the clock for the ten-minute Times pipeline. It does
not fetch or process articles. Each Cron Trigger calls GitHub's workflow
dispatch API for `maintenance-times-capture.yml`; GitHub Actions then runs the
existing Capture -> HF Raw -> Process -> HF Canonical/B2 Delivery chain.

## Security

Create a fine-grained GitHub personal access token restricted to the
`kargonerd/jojokanbao` repository with only **Actions: write** permission. Store
it as a Cloudflare Worker secret. Never add the token to `wrangler.jsonc`, a
`.dev.vars` file committed to Git, or a GitHub Actions log.

```bash
pnpm --filter @jojo/times-scheduler exec wrangler login
pnpm --filter @jojo/times-scheduler exec wrangler secret put GITHUB_TOKEN
```

Cloudflare holds the long-lived token. The dispatched GitHub workflow continues
to use the repository's short-lived `GITHUB_TOKEN` and the existing maintenance
environment secrets.

## Verify and deploy

```bash
pnpm --filter @jojo/times-scheduler typecheck
pnpm --filter @jojo/times-scheduler test
pnpm --filter @jojo/times-scheduler build
pnpm --filter @jojo/times-scheduler deploy
```

The production Cron expression is `*/10 * * * *` in UTC. The workflow's native
GitHub schedule remains enabled during migration. After at least one successful
Cloudflare-triggered Capture and its automatic Process run have been observed,
remove the native `schedule` block to avoid duplicate discovery runs. The
Worker has no public HTTP route; only its Cron Trigger can invoke it.
