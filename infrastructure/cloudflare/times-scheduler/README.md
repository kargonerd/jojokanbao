# Times scheduler

This Cloudflare Worker is the clock for the ten-minute Times pipeline. It does
not fetch or process articles. Each Cron Trigger calls GitHub's workflow
dispatch API for `maintenance-times-capture.yml`; GitHub Actions then runs the
existing Capture -> HF Raw -> Process -> HF Canonical/B2 Delivery chain.
The Worker probes once per minute, but assigns each probe to a ten-minute time
slot. Before dispatching, it checks both Capture and Process workflow runs. If
either workflow is queued or running, that probe is skipped so the shared HF
writer lock cannot accumulate a backlog or starve Process. A later probe in the
same slot dispatches as soon as both workflows become idle. Once an automatic
Capture run exists in the slot, the remaining probes skip it, so each slot is
dispatched at most once.

## Security

Create a fine-grained GitHub personal access token restricted to the
`kargonerd/jojokanbao` repository with only **Actions: write** permission. Store
it as a Cloudflare Worker secret. Never add the token to `wrangler.jsonc`, a
`.dev.vars` file committed to Git, or a GitHub Actions log.

Create `JOJO Times Scheduler` and `JOJO Times Pipeline` checks in
Healthchecks.io. The scheduler check receives a success ping after every
successful probe and a failure ping when the GitHub API cannot be queried or
dispatched. A successful dispatch sends the pipeline check a start signal;
GitHub Actions later reports Capture failure or the final Process outcome.
Store both private ping URLs as Worker secrets as well.

```bash
pnpm --filter @jojo/times-scheduler exec wrangler login
pnpm --filter @jojo/times-scheduler exec wrangler secret put GITHUB_TOKEN
pnpm --filter @jojo/times-scheduler exec wrangler secret put HEALTHCHECKS_TIMES_SCHEDULER_URL
pnpm --filter @jojo/times-scheduler exec wrangler secret put HEALTHCHECKS_TIMES_PIPELINE_URL
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

The production Cron expression is `* * * * *` in UTC. The one-minute cadence is
only a catch-up probe; Capture still runs at most once per ten-minute slot. The
Worker has no public HTTP route; only its Cron Trigger can invoke it. GitHub
Actions has no native schedule fallback, so Cloudflare is the single production
clock. Healthchecks delivery is best effort and never blocks dispatch; a missed
heartbeat still causes the external check to alert after its grace period.
