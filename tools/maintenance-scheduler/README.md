# Portable maintenance scheduler

One task registry (`src/tasks.ts`) controls schedules, GitHub workflow inputs,
catch-up windows, retry limits, queue probes, and Healthchecks names/policies.
The production adapter is Tencent SCF in
`infrastructure/tencent-scf/maintenance-scheduler`. CF is retained only for a
guarded migration/rollback; its checked-in deployment has no cron and is disabled.

Actual Archive/Times work stays on GitHub Actions. Capture still wakes Process;
no new periodic Process workflow is added. Preserve the Process/Cleanup writer
lock. Existing `[cloudflare-cron]` run titles intentionally remain compatible
with pre-migration run-list reconciliation; they are not a routing mechanism.

## State and delivery safety

`SupabaseState` uses a purpose-scoped RPC, not a management/service-role token.
The private tables contain only one control row, one token digest, monitor
state per stage, and the latest delivery receipt per task. They do not contain
business data or an unbounded history of schedule slots.

Each SCF minute claims a 90-second database lease. Database server time decides
expiry; every state write checks the owner and active backend. SCF has a
55-second hard timeout, so a killed function cannot keep writing after a new
owner takes over. Old/replayed timer events are dropped. An accepted/ambiguous
GitHub POST is not blindly repeated while its run is invisible. Reconciled
failed runs still follow each task's existing retry delay and attempt limit.
This is conservative delivery, **not an exactly-once claim**: GitHub has no
transactional/idempotency-key dispatch API. An uncertain daily delivery that
never appears requires operator reconciliation instead of a duplicate run.

Monitor logic is unchanged: consume distinct execution events, persist decisions
before delivery, debounce transient failures, and recover only on real business
success. The independent queue check can recover only after a real healthy queue
probe. External Healthchecks still detects a dead scheduler even if its database
or function cannot run.

Catch-up windows are retained: Times 5 minutes, RMRB 180 minutes. This migration
does not backfill every missed Times interval or change GitHub runner capacity.

## Add a task

Add its existing workflow, schedule, inputs, and monitoring definition to
`src/tasks.ts`, test, merge, and explicitly deploy the SCF package. The shared
Healthchecks API key provisions the task by slug; no per-task monitoring secret
or SCF function is required. A new kind of business action still needs its own
workflow. Merging registry code alone does not publish an SCF version.

```sh
pnpm --filter @jojo/maintenance-core typecheck
pnpm --filter @jojo/maintenance-core test
pnpm --filter @jojo/maintenance-scheduler test
node infrastructure/tencent-scf/maintenance-scheduler/build.mjs
```

See the Tencent adapter README for deployment and the one-time state handoff.
