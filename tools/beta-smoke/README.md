# Hosted smoke tests

## Comments

Explicitly run `node tools/beta-smoke/comments.mjs [env-directory]` against an
authorized Supabase project. The environment needs the management access token,
project reference, publishable URL/key, and `READER_BASE_URL` pointing to the
deployed Reader API origin. Account creation
obtains the same signed signup authorization used by the clients.

The test creates three temporary accounts with a unique `beta_smoke_run` marker
and one synthetic book ID. It uses actual password authentication and HTTP RPCs
to test public/private visibility, reply notifications, authorization, reports,
and moderation. It does not send confirmation emails or touch real books.
Moderation calls `admin_*` RPCs with the service role key, which the test reads
from the management API.

Apply the repository migrations through `202609140001_annotations_direct_rpc.sql` before
running this test. Every annotation RPC is called directly with the reader session;
there is no `/api/v1/annotations` proxy, because the shared disclosure threshold lives
inside the database functions. Notification checks also cover explicitly marking displayed IDs, duplicate
and empty batches, ownership, and a new reply arriving after the displayed
snapshot. That later reply must remain unread.

Cleanup runs in `finally` and removes only this run's synthetic content,
accounts, invitation, and the `private.admin_actions` rows its own moderation
fixtures wrote. Results and the unique cleanup marker are written to
`.runtime/beta-smoke/`. If the process is interrupted or network access is lost,
reconcile those exact markers before another run; never bulk-delete by age or
an email domain. This is an operator test and is intentionally not scheduled.

## AI usage limits

After the reviewed migrations through `202609130005_admin_api_auth.sql` are applied,
run against an authorized project with the same environment as the comment test,
plus `POSTHOG_PROJECT_TOKEN` and `POSTHOG_API_HOST`:

```bash
node tools/beta-smoke/ai-usage.mjs [env-directory]
```

This creates one confirmed temporary account and a single-use invitation with
a unique `beta_smoke_run` marker. It does not send email or make model requests.
Real REST calls verify that a signed-in reader cannot reserve or release usage
without the service role key, two simultaneous reservations admit only one request,
release permits further requests, and rejected requests do not consume quota.
The script reads `ai_usage_limits_config` directly from PostHog and verifies
`requestsPerMinute`, `requestsPerDay`, and `maxRunSeconds`. It sends those trusted
parameters to the service_role-only quota RPC, authenticating with the service
role key read from the management API. It checks that the usage state
exists and never edits configuration; the daily allowance must exceed the minute
allowance and permit at least three requests.

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
