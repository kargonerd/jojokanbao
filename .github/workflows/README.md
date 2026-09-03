# GitHub automation

GitHub only discovers workflow files placed directly in this directory, so the
directory stays flat and filenames provide the grouping:

- `ci.yml` — pull-request and main-branch validation
- `deploy-*.yml` — production and preview deployments
- `release-*.yml` — installable application releases
- `maintenance-*.yml` — scheduled or manually triggered operational tasks

Workflow display names use the same categories in the Actions UI.

Repository automation is split by side effects, not by feature folder.

## Continuous integration

`ci.yml` is the only pull-request CI entry point. It contains separate jobs for
the environments that need different runners or dependencies:

- pnpm/Turborepo workspaces
- Web browser tests
- Desktop renderer browser tests
- root-level Homepage content
- Supabase migrations and the shared Auth contract
- EdgeOne Python Cloud API tests
- the Times offline-pipeline tests and Raw/Canonical contract checks
- the historical news archive parser, validation, schema, and manifest checks

The `build-and-test` aggregate job and `e2e` browser job keep stable check
names because the `master` ruleset requires those contexts. The aggregate job
fails when any applicable CI job fails or is cancelled.

Turborepo selects affected workspace packages and their consumers using the
exact base and head commits emitted by the `changes` job. This includes the
internal Data Workbench Web package. Root files that are not workspace
packages, such as `content/blog/`, `infrastructure/supabase/`, and `backend/`, are
classified explicitly where they have dedicated checks.

Every JavaScript or TypeScript workspace should expose the applicable standard
scripts:

```json
{
  "scripts": {
    "typecheck": "...",
    "test": "...",
    "build": "..."
  }
}
```

Apps may omit a script that does not apply to their current runtime. Build
verification scripts use the shared `verify:build` task.

## Deployments and releases

Deployment workflows are separate because they use credentials and change
external state:

- `deploy-homepage.yml` publishes the Homepage
- `deploy-web.yml` automatically publishes relevant `master` changes to the
  public Beta Preview environment; release tags and manual Production runs
  publish the stable Web client
- `release-desktop.yml` builds Desktop installers on Windows, macOS (Apple Silicon
  and Intel), and Linux; `desktop-v*` tags publish the resulting files as a
  GitHub Release, starting with `desktop-v0.0.1-rc1`, while manual runs retain
  them as workflow artifacts
- `release-mobile.yml` asks EAS Build for the signed standard Android APK;
  `mobile-v*` tags publish the APK and SHA-256 checksum as a GitHub Release,
  while manual runs retain the APK as a workflow artifact
- `release-mobile-eink.yml` asks EAS Build for a signed Android APK; `mobile-eink-v*`
  tags publish the APK and SHA-256 checksum as a GitHub Release, while manual
  runs retain the APK as a workflow artifact

Internal local tools participate in CI but do not need a deployment workflow.

## Maintenance

Scheduled and manually operated data tasks remain independent workflows:

- `maintenance-purge-archive-pdf-cache.yml`
- `maintenance-sync-rmrb.yml` — accepts the external daily Cloudflare trigger,
  receives an explicit Shanghai business date, and safely skips an object that
  already exists
- `maintenance-times-capture.yml` — accepts the external five-minute Cloudflare trigger, checks a three-hour discovery lookback for late URLs, captures the primary one-hour window plus unseen/retry pages and images, and publishes an immutable Raw job to the private HF Runtime Bucket
- `maintenance-times-process.yml` — after an automatic Capture succeeds, stages an immutable Process generation, publishes B2 Delivery, then advances the committed Runtime pointer and job status
- `maintenance-times-runtime-cleanup.yml` — applies the 14/30-day Runtime job retention policy with an exact-path deletion cap

The `maintenance` environment stores `HF_TIMES_RUNTIME_TOKEN` as a secret and
`HF_TIMES_RUNTIME_BUCKET` as a variable. The old Dataset credentials are not
used by the five-minute Runtime chain.

CI also publishes a content-addressed `.times-runtime` cache containing the
compiled Times CLI and production dependencies. Capture and Process restore
that verified package directly; a cache miss falls back to a filtered install
and build, while normal production runs do not repeat typechecking, tests, or
compilation.

The shared scheduler implementation and deployment instructions live in
`infrastructure/cloudflare/maintenance-scheduler`. One Cloudflare minute tick
evaluates the versioned Times and RMRB task definitions. Cloudflare only
supplies the clock, task-level dispatch policy, and dispatch monitoring;
browser capture, PDF synchronization, and publication continue to run on
GitHub-hosted runners.

## Maintenance monitoring

Healthchecks.io provides the external dead-man switch. The GitHub `maintenance`
environment holds one project-level `HEALTHCHECKS_PING_KEY`; every scheduled
workflow derives its check from the configured task id. The Cloudflare Worker
holds one project-level `HEALTHCHECKS_API_KEY` and automatically creates or
updates each task check, including its cron, timezone, grace period, metadata,
and all existing project integrations. New tasks do not need a new check or
secret; see the scheduler README for one-time provisioning and legacy-check
migration.

Monitoring calls use
`tools/monitoring/ping-healthchecks.sh`, attach task, slot, failure type, and
GitHub run diagnostics, and are best effort so a monitoring outage cannot block
data publication. A missing success ping still produces an alert after the
check's configured grace period.

Do not add a feature-specific CI workflow. Add a package script or a focused
job to `ci.yml`; create another workflow only when its trigger, permissions, or
external side effects are materially different.
