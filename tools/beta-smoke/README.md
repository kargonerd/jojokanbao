# Hosted smoke tests

## Comments

Explicitly run `node tools/beta-smoke/comments.mjs [env-directory]` against an
authorized Supabase project. The environment needs the existing management
access token, project reference, publishable URL/key, and operator token.

The test creates three temporary accounts with a unique `beta_smoke_run` marker
and one synthetic book ID. It uses actual password authentication and HTTP RPCs
to test public/private visibility, reply notifications, authorization, reports,
and moderation. It does not send confirmation emails or touch real books.

Cleanup runs in `finally` and removes only this run's synthetic content,
accounts, and invitation. Results and the unique cleanup marker are written to
`.runtime/beta-smoke/`. If the process is interrupted or network access is lost,
reconcile those exact markers before another run; never bulk-delete by age or
an email domain. This is an operator test and is intentionally not scheduled.

## Feature configuration

After the reviewed `202608290002_annotation_threshold_feature_config.sql`
migration is applied, run:

```bash
node tools/beta-smoke/feature-flags.mjs [env-directory]
```

This verifies the migration record, configuration column, RPC signatures and
private-table permissions, then creates one synthetic feature flag inside a
single database transaction. It calls the operator RPCs as the anonymous role
to verify nonempty config publishing, invalid-token and invalid-config rejection,
revision conflicts, history, and rollback. The transaction always rolls back;
the synthetic flag is never committed or visible to other sessions. An SQL
failure aborts the transaction, so there are no cleanup records to reconcile.

The final HTTP checks confirm PostgREST exposes the new config signature and
rejects invalid config and operator credentials. They never submit valid changes
to a real flag. A sanitized result is saved in `.runtime/beta-smoke/`.

## AI usage limits

After the reviewed `202609080003_agent_usage_limits.sql` migration is applied,
run against an authorized project with the same environment as the comment test:

```bash
node tools/beta-smoke/ai-usage.mjs [env-directory]
```

This creates one confirmed temporary account and a single-use invitation with
a unique `beta_smoke_run` marker. It does not send email or make model requests.
Real REST calls verify that a signed-in reader cannot reserve or release usage
without the operator token, two simultaneous reservations admit only one request,
release permits further requests, and rejected requests do not consume quota.
With the launch policy, three requests fit within a rolling minute and the fourth
is rejected. The script reads the current policy and never changes it; the daily
allowance must exceed the minute allowance and permit at least three requests.

To verify the daily limit, Shanghai calendar-day rollover, expired leases, and
late release of an old request, it updates only that fixture's usage-state row,
requiring both its account ID and exact marker. No waiting or global quota change
is needed. The rolling-minute test uses actual admission timestamps, so extremely
slow network responses that span a full minute can make that check fail.

Cleanup in `finally` reconciles the exact marker even after an uncertain Auth
response, removes the test account, invitation, and usage state, and checks that
its redemption ledger is also empty. The report in `.runtime/beta-smoke/` records
the marker, fixture IDs and cleanup counts, never credentials or invitation codes.
If interrupted or reported as `cleanup-required`, reconcile only that run's marker
and IDs before retrying. Do not schedule this operator test.
