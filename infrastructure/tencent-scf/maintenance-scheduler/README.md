# JOJO maintenance scheduler · Tencent SCF

- Function: `jojokanbao-maintenance-scheduler`, `default`, `ap-singapore`.
- Runtime: Nodejs20.19, event function, 256 MB, 55-second timeout.
- Trigger: `maintenance-minute`, `0 * * * * * *` (Tencent's 7-field cron).
- No public function URL, API Gateway, VPC, fixed outbound IP, or provisioned concurrency.
- CLS records execution logs. Compute, network and logs consume normal metered
  resources; no paid Supabase upgrade or new database is required by deployment.

The implementation is in `tools/maintenance-scheduler`. Its only DB dependency
is the isolated maintenance state RPC in the existing Supabase project.

## Configuration

Local administration needs `tccli` with an existing authorized login and Node
22+ / Python for packaging. The deployed function itself uses only Node 20.
Use `node --env-file=<your-main-checkout>/.env` for the helper. It consumes:

- `GITHUB_TOKEN`: token scoped to this repo, Actions read/write and Metadata read.
- `HEALTHCHECKS_API_KEY` (also accepts `HEALTHCHECK_API_KEY`): the existing project key.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: existing public endpoint/key.
- `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`: **local administration only**;
  these broad credentials are never sent to SCF or CF.

`create-shadow` generates a dedicated random `SCHEDULER_STATE_TOKEN`, stores it
in SCF configuration, and never prints it. Only its SHA-256 digest goes to the DB.
Helpers use temporary files for tccli requests instead of secret-bearing command
arguments; files are removed after each request. Never commit environment files.

## Normal release

After review/CI/merge, from the repo root:

```sh
node infrastructure/tencent-scf/maintenance-scheduler/build.mjs
node infrastructure/tencent-scf/maintenance-scheduler/ops.mjs deploy
node infrastructure/tencent-scf/maintenance-scheduler/ops.mjs probe
node infrastructure/tencent-scf/maintenance-scheduler/ops.mjs status
```

SCF operations use the saved tccli login. `deploy` preserves existing credentials,
mode, and timer. `probe` reads GitHub/Healthchecks/state but does not dispatch,
provision checks, send heartbeats, or run Cleanup. Verify natural timer logs and
real workflow commits after every release, not merely an Active function status.

## One-time migration

1. Build/test; `create-shadow`, then `timer`. Observe multiple natural shadow ticks.
2. Review/merge and apply only `202609060001_maintenance_scheduler_state.sql`.
   Run `state-init` with the local Supabase admin environment. The DB defaults to
   `cloudflare`, so SCF cannot claim production work.
3. Run `probe`; it must authenticate to all three services. `arm` sets SCF active,
   but the database still prevents work until the cutover.
4. Transfer the dedicated state token to CF using secret stdin. Deploy the CF
   adapter with `SCHEDULER_BACKEND=migration-export`, Supabase public configuration,
   and the existing one-minute trigger. This code **does not dispatch or report
   Healthchecks**. It snapshots the same DO namespace/class to the private RPC.
5. Verify a natural tick of the export version, all expected state keys, fresh
   `imported_at`, and unchanged cursors/down/failure state. Allow old in-flight
   invocations to finish; do not cut over based on configuration alone.
6. Run `activate` (requires all three original monitor states imported within
   3 minutes). Subsequent CF imports are rejected. Observe SCF natural delivery
   and monitoring, then deploy the checked-in disabled CF configuration with no
   crons. Keep the old Worker/DO data for rollback; do not delete or fake health.
7. Verify real Times publication, restored queue check, the next natural RMRB
   day run and Cleanup. Never manually run destructive Cleanup for validation.

Do not set `backend=tencent` manually to bypass snapshot/verification gates.
For rollback, first fence SCF (`backend=paused` using an authorized admin query),
wait for its 55-second maximum runtime and lease expiry, and then reconcile
current monitor state before re-enabling CF. The retained DO snapshot is stale
after SCF starts; blindly rolling back the old Worker is not a complete rollback.
