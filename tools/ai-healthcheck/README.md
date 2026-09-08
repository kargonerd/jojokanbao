# AI availability

`Monitor · AI Availability` runs in GitHub Actions every 30 minutes, independent
of an operator's computer. It checks `/rag/health`, signs into a dedicated
confirmed Supabase account, requests a short answer from the production `/rag`
route, and requires nonempty text plus a normal SSE completion. An SSE `error`
is a failure even when HTTP is 200; recovered tool errors alone are not failures.
The probe has a 60-second total deadline and a 64 KB response limit. It creates
no bookshelf items, explanations, comments, or notifications and revokes its
own login session after each run.

The monitor account has `raw_user_meta_data.account_purpose =
'ai_availability_monitor'`. Exclude it from reader adoption and active-user
reports. Conversation IDs start with `jojo-ai-health-`; exclude them from real
reader conversation counts. Each probe uses a small amount of model quota.

GitHub repository variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

GitHub encrypted secrets:

- `JOJO_AI_MONITOR_EMAIL`
- `JOJO_AI_MONITOR_PASSWORD`
- `JOJO_AI_HEALTHCHECK_PING_URL`

The account has ordinary authenticated-reader privileges. No Supabase admin
key or provider OAuth credential is stored in this workflow. Healthchecks slug
`jojo-ai-availability` uses existing operations alert channels. A failed probe
signals failure immediately; a missing ping is also an incident (30-minute
period plus 30-minute grace). GitHub scheduling can be delayed, so this is an
availability monitor, not a minute-level SLA measurement.

Run `node --test tools/ai-healthcheck/probe.test.mjs` for offline failure-path
tests. To check production manually, dispatch `monitor-ai.yml`; inspect the
structured outcome and Healthchecks status. Do not log credentials or raw SSE
payloads. Quota and OAuth failures require operator action; this monitor does
not rotate credentials, spend reset credits, or purchase quota.
