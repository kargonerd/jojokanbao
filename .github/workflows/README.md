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

The `build-and-test` aggregate job and `e2e` browser job keep stable check
names because the `master` ruleset requires those contexts. The aggregate job
fails when any applicable CI job fails or is cancelled.

Turborepo selects affected workspace packages and their consumers using the
exact base and head commits emitted by the `changes` job. This includes the
internal Data Workbench Web package. Root files that are not workspace
packages, such as `content/blog/`, `infrastructure/supabase/`, `backend/`,
and `tools/bloomberg-archive/`, are
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
- `deploy-web.yml` publishes the unified Web client
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
- `maintenance-sync-rmrb.yml`
- `maintenance-times-capture.yml` — accepts the external ten-minute Cloudflare trigger, checks a 24-hour discovery lookback for late URLs, captures the primary one-hour window plus unseen/retry pages and images, and commits Raw to the private HF Dataset
- `maintenance-times-process.yml` — after an automatic Capture succeeds, commits Canonical to the same HF Dataset and publishes B2 Delivery in pointer-safe order

The scheduler implementation and deployment instructions live in
`infrastructure/cloudflare/times-scheduler`. Cloudflare only supplies the
clock; browser capture and publication continue to run on GitHub-hosted
runners.

## Maintenance monitoring

Healthchecks.io provides the external dead-man switch, with a Feishu webhook
assigned to each check. The maintenance environment holds private ping URLs in
these secrets:

- `HEALTHCHECKS_TIMES_PIPELINE_URL` — shared by automatic Capture and Process;
  Capture reports only failure, and Process reports the final pipeline outcome
- `HEALTHCHECKS_RMRB_SYNC_URL` — scheduled RMRB runs report start and final
  outcome; manual runs do not affect the production check

The Cloudflare scheduler separately holds
`HEALTHCHECKS_TIMES_SCHEDULER_URL` and the same
`HEALTHCHECKS_TIMES_PIPELINE_URL`; see its README for provisioning commands.
Monitoring calls use `tools/monitoring/ping-healthchecks.sh`, attach the GitHub
run URL as diagnostic text, and are best effort so a monitoring outage cannot
block data publication. A missing success ping still produces an alert after
the check's configured grace period.

Do not add a feature-specific CI workflow. Add a package script or a focused
job to `ci.yml`; create another workflow only when its trigger, permissions, or
external side effects are materially different.
