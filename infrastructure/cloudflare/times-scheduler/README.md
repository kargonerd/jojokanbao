# Times scheduler

This Cloudflare Worker is the clock for the ten-minute Times pipeline. It does
not fetch or process articles. Each Cron Trigger calls GitHub's workflow
dispatch API for `maintenance-times-capture.yml`; GitHub Actions then runs the
existing Capture -> HF Raw -> Process -> HF Canonical/B2 Delivery chain.
Before dispatching, the Worker checks both Capture and Process workflow runs.
If either workflow is queued or running, that tick is skipped so the shared HF
writer lock cannot accumulate a backlog or starve Process.

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

The production Cron expression is `*/10 * * * *` in UTC. The Worker has no
public HTTP route; only its Cron Trigger can invoke it. GitHub Actions has no
native schedule fallback, so Cloudflare is the single production clock.
