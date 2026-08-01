# GitHub automation

Repository automation is split by side effects, not by feature folder.

## Continuous integration

`ci.yml` is the only pull-request CI entry point. It contains separate jobs for
the environments that need different runners or dependencies:

- pnpm/Turborepo workspaces
- Web browser tests
- Desktop renderer browser tests
- root-level Homepage content
- Supabase migrations and the shared Auth contract
- the existing Olds Python test and archive-manifest checks

The `build-and-test` aggregate job and `e2e` browser job keep stable check
names because the `master` ruleset requires those contexts. The aggregate job
fails when any applicable CI job fails or is cancelled.

Turborepo selects affected workspace packages and their consumers using the
exact base and head commits emitted by the `changes` job. This includes the
internal Data Workbench Web package. Root files that are not workspace
packages, such as `blog/`, `supabase/`, and `services/olds-api/`, are
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

- `homepage-deploy.yml` publishes the Homepage
- `web-deploy.yml` publishes the unified Web client

The existing Desktop runtime and the future Mobile runtime should use their
own release workflows when packaging is implemented. Internal local tools
participate in CI but do not need a deployment workflow.

## Maintenance

Scheduled and manually operated data tasks remain independent workflows:

- `bloomberg-archive.yml`
- `purge-archive-pdf-cache.yml`
- `sync-rmrb.yml`

Do not add a feature-specific CI workflow. Add a package script or a focused
job to `ci.yml`; create another workflow only when its trigger, permissions, or
external side effects are materially different.
