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

The Worker owns notification decisions. Workflows use the shared helper with
`HEALTHCHECKS_REPORT_MODE=buffered` to append execution outcomes to the existing
check's `/log` inbox. Logging is not a success heartbeat and does not change the
check's up/down status. Every minute, an internal SQLite-backed Durable Object
per check consumes new outcomes and applies the shared alert policy. There is
no public callback endpoint and no additional project or per-task credential.

| Condition | Default policy |
| --- | --- |
| Dispatch network errors, 429, 5xx (including rate-limit 403) | Log; alert only if still unresolved after 5 minutes |
| Times execution failures | Alert on 2 consecutive distinct execution attempts |
| RMRB execution failures | Alert when its 3 automatic attempts are exhausted |
| Confirmed permanent dispatch/configuration failure | Alert on the next monitor tick, without waiting for the failure threshold |
| No successful work | Independent cron deadline + configured grace (45m Capture/RMRB, 90m Process) |

`DEFAULT_ALERT_POLICY` supplies shared defaults. A task or stage can override
`monitoring.alertPolicy.executionFailures` or `dispatchFailureSeconds`; RMRB
overrides the former to match its retry budget. Workflows never contain these
thresholds. The deterministic validation steps source `classify-permanent.sh`;
other producers may explicitly set `HEALTHCHECKS_FAILURE_CLASS=permanent` for a
confirmed configuration/authentication/integrity failure. Opaque workflow
errors remain `unknown` and use the consecutive-failure threshold rather than
guessing severity from a generic exit code.

Only actual successful work resets the failure streak and advances the
deadline. Dispatch acceptance, retries, no-op, dry-run, and bootstrap outcomes
do not recover a business incident. A brand-new check is armed with `/start`
on its first expected slot; existing checks and retries do not send repeated
`/start` pings. The absolute deadline cannot move forward on a new attempt or
schedule slot. One unresolved incident produces one down transition; recovery
requires a real success newer than the incident.

The SQLite state stores the inbox cursor, deduplication identities, deadlines,
failure streaks and pending delivery. Duplicate HTTP deliveries and stale
outcomes do not count twice. State is persisted before sending up/down, and a
failed delivery is retried. A later real recovery supersedes an undelivered
failure so a replay does not generate an obsolete alarm/recovery pair.

Inbox reads have bounded request deadlines and a per-tick body budget. Bodies
are fetched only from constructed Healthchecks API URLs, without following
redirects. Transport or malformed-event errors never become an empty inbox;
history loss is visible and can be reconciled by a retained fresh success.
If the policy consumer fails, the scheduler logs the error instead of sending
its own success heartbeat: its independent 3-minute check detects a broken
monitor. Outcomes normally reach the notification decision within one minute.

GitHub's `maintenance` environment holds one project ping key in
`HEALTHCHECKS_PING_KEY`. Workflows construct the slug URL from that key and the
task id, so adding another task never requires another Healthchecks secret.

Tasks can also declare `monitoring.stages` for independently reported downstream
stages. Stage slugs must be unique across all tasks and inherit the parent cron
and timezone. The Worker reports their success only from actual execution
outcomes, never merely because provisioning or dispatch succeeded.
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
pnpm --filter @jojo/maintenance-scheduler run deploy
```

Deploy the Worker before (or together with) merging the buffered workflow
change. Wrangler creates the internal SQLite namespace with the versioned
`v1-monitor-state` migration; no separate namespace command or secret is needed.
The consumer accepts attributable legacy workflow successes during rollout,
but legacy `/fail` producers remain noisy until the workflow update is merged.
Verify real Capture and publishing Process/drain outcomes appear as `/log`
events, then as CF success decisions, and verify the scheduler stays healthy.
Merging alone changes GitHub workflows, **not** the deployed Worker.

`pnpm test` includes both policy tests and an isolated workerd/SQLite smoke that
restarts the entire runtime between failures. All network requests in the smoke
are stubbed; it does not dispatch jobs, publish B2, or ping production checks.
CI also runs the shared Bash helper contracts with a stubbed curl.

For rollback, first restore workflows to direct reporting, then deploy a
compatible Worker while retaining the Durable Object binding/class/migration.
Do not delete the namespace or roll back across its creation as an operational
shortcut. Existing project secrets and notification integrations remain valid.

The production Cron expression is `* * * * *` in UTC. Adding a scheduled job
means adding one registry entry and adapting an existing workflow to the
automatic-run contract. It does not require another Cloudflare Cron Trigger,
Healthchecks check, or secret.
