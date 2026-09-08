# AI availability

The existing SCF maintenance scheduler runs every minute and dispatches
`Monitor · AI Availability` in GitHub Actions at minutes 17 and 47 of each hour,
independent of an operator's computer. The probe checks `/rag/health`, signs into a dedicated
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
`jojo-ai-availability` uses existing operations alert channels.

The workflow sets `HEALTHCHECKS_REPORT_MODE=buffered`. Before any probe request,
the script validates GitHub's `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`,
`GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`. Both outcomes are posted to the existing
`JOJO_AI_HEALTHCHECK_PING_URL/log` as `monitor_event=v1` key/value execution
events with `task=jojo-ai-availability`, run identity, event time, outcome,
sanitized failure classification, and the GitHub run URL. A success is reported
only after complete SSE validation and logout of that probe's session. Raw model
output, credentials, and unexpected error messages are never included.

The existing scheduler monitor consumes those events and is the only writer of
the check's up/down status. Its `executionFailures=1` policy treats the first
failed execution as an incident, processed at the next minute tick when the
scheduler is healthy. The workflow does not send direct success or `/fail` pings.
Reporting failure also fails the workflow; it cannot silently become a healthy
result. Missing successful executions remain covered by the monitor's schedule
and grace deadline. Runner queueing or a scheduler outage can still delay work.

For an explicit local run, omitting the report mode (or setting `direct`) keeps
the original direct success/failure reporting and does not require GitHub run
identity. Production workflow dispatches always use buffered reporting.

Run `node --test tools/ai-healthcheck/probe.test.mjs` for offline failure-path
tests. To check production manually, dispatch `monitor-ai.yml`; inspect the
structured outcome and Healthchecks status. Do not log credentials or raw SSE
payloads. Quota and OAuth failures require operator action; this monitor does
not rotate credentials, spend reset credits, or purchase quota.
