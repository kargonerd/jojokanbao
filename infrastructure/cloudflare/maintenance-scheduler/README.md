# Maintenance scheduler

This Cloudflare Worker is the shared clock for scheduled maintenance jobs. It
does not execute product logic. A single one-minute Cron Trigger evaluates the
versioned task registry in `src/tasks.ts`, checks the target GitHub workflow for
an active or already-dispatched run, and calls GitHub's workflow dispatch API.

The registry currently contains:

- `times-capture`: every five minutes, preserving the existing Capture -> HF
  Raw -> Process -> HF Canonical/B2 Delivery chain.
- `rmrb-sync`: daily at 01:00 UTC, with a three-hour catch-up window and up to
  three dispatch attempts separated by fifteen minutes.

Each task owns its schedule, catch-up window, overlap policy, retry policy,
workflow inputs, automatic run title, and monitoring definition. Failures are
isolated per task, so a failed RMRB probe does not prevent Times from being
dispatched in the same scheduler tick.

## Monitoring

Healthchecks.io remains outside Cloudflare as the dead-man switch. The Worker
uses one project-level read-write Management API key to create or update checks
by task id. Check name, slug, cron, timezone, grace period, tags, description,
and all existing project integrations come from the registry. The shared clock
uses the reserved `maintenance-scheduler` slug.

The Worker sends a task start signal only after GitHub accepts a dispatch and a
task failure signal when schedule evaluation, GitHub probing, or dispatch
fails. GitHub Actions reports the eventual business outcome. Monitoring calls
are best effort and never block another task.

GitHub's `maintenance` environment holds one project ping key in
`HEALTHCHECKS_PING_KEY`. Workflows construct the slug URL from that key and the
task id, so adding another task never requires another Healthchecks secret.

Tasks can also declare `monitoring.stages` for independently reported downstream
stages. Stage slugs must be unique across all tasks and inherit the parent cron
and timezone. The Worker provisions them but never reports success for them.
Times uses `times-capture` (45-minute grace, successful durable Raw publication)
and `times-process` (90-minute grace, committed Canonical/B2 batches, including
drain continuations). A successful Capture cannot clear a Process failure;
successful no-op Process runs cannot clear it either. These are stage liveness
checks, not an SLA timer for every queued article. No extra key is needed.

GitHub probe and dispatch requests each have a 10-second deadline. Dispatch
POSTs are not blindly retried after timeout: the next minute checks GitHub's
accepted runs first. Healthchecks definitions are cached for 15 minutes per
Worker isolate, then reconciled again to recover from external edits/deletion.

## Security

Use a fine-grained GitHub token restricted to the
`kargonerd/jojokanbao` repository with only **Actions: write** permission. Store
the GitHub token and Healthchecks read-write API key as Worker secrets; do not
commit them to Wrangler configuration or `.dev.vars`.

```bash
pnpm --filter @jojo/maintenance-scheduler exec wrangler login
pnpm --filter @jojo/maintenance-scheduler exec wrangler secret put GITHUB_TOKEN
pnpm --filter @jojo/maintenance-scheduler exec wrangler secret put HEALTHCHECKS_API_KEY
```

Set `HEALTHCHECKS_PING_KEY` once in the GitHub `maintenance` environment. It is
the project's Ping Key, not a check UUID or full ping URL. The API key is the
project's read-write Management API key and should remain Cloudflare-only.

On the first deployment, the Worker manages checks with the slugs
`maintenance-scheduler`, `times-capture`, `times-process`, and `rmrb-sync`. If legacy checks use
other slugs, pause or remove them after confirming the managed checks are
receiving pings, otherwise both old and new checks may alert.

The Worker is deployed as `jojokanbao-maintenance-scheduler`. During the first
migration, deploy and verify this Worker before deleting the legacy
`jojokanbao-times-scheduler` service. A brief overlap is safe because task-slot
deduplication prevents duplicate workflow execution.

## Verify and deploy

```bash
pnpm --filter @jojo/maintenance-scheduler typecheck
pnpm --filter @jojo/maintenance-scheduler test
pnpm --filter @jojo/maintenance-scheduler build
pnpm --filter @jojo/maintenance-scheduler deploy
```

For the Times stage split, deploy the Worker registry before (or together with)
merging the workflow change. Verify the `times-process` check has been created,
then verify a publishing Process/drain run reports to it. A newly created check
does not replace verification of an actual committed batch. Merging a PR alone
updates GitHub workflows, **not** the deployed Worker; this repository currently
requires the explicit deploy command above. Existing project secrets remain valid.

The production Cron expression is `* * * * *` in UTC. Adding a scheduled job
means adding one registry entry and adapting an existing workflow to the
automatic-run contract. It does not require another Cloudflare Cron Trigger,
Healthchecks check, or secret.
