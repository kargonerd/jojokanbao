# Resend quota · Tencent SCF

- Function: `jojokanbao-email-quota`, `default`, `ap-singapore`.
- Nodejs20.19, event function, 128 MB, 55 seconds, reserved concurrency 128 MB (1 invocation).
- Native timer: `email-quota-half-hour`, `0 0,30 * * * * *`.
- No public URL/API Gateway, VPC, fixed IP or provisioned concurrency.
- CLS logs contain usage totals and safe error codes only.

Implementation and notification boundaries: [email quota monitor](../../../tools/email-quota/README.md).

After CI/review/merge, apply `202609090002_email_quota_monitor_config.sql` to the
existing Supabase project. Local administration uses the saved `tccli` login.
Runtime gets `RESEND_QUOTA_API_KEY`, `HEALTHCHECKS_API_KEY`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`; no management, service-role or Operator token.

Use a dedicated Resend key. Resend currently requires full-access keys for reads;
the code only calls GET /usage. Keep it separate from Supabase SMTP and GitHub's
delivery-monitor key. API credentials are stored in SCF configuration, never flags.

```sh
node infrastructure/tencent-scf/email-quota/build.mjs
# Run with the existing local environment loaded; never put keys in command arguments.
node infrastructure/tencent-scf/email-quota/ops.mjs provision
node infrastructure/tencent-scf/email-quota/ops.mjs create
node infrastructure/tencent-scf/email-quota/ops.mjs probe
node infrastructure/tencent-scf/email-quota/ops.mjs check
node infrastructure/tencent-scf/email-quota/ops.mjs timer
node infrastructure/tencent-scf/email-quota/ops.mjs status
```

`provision` copies the existing delivery check's channels. It does not add
recipients or send a test notification. `create` fails if the function exists;
`deploy` only updates code, preserving environment/timer. `probe` is read-only.
Enable the timer only after a successful real usage probe, current quota state
check and notification-channel verification. Observe a natural timer invocation;
an Active SCF status alone is not acceptance. Preserve a redacted deployment receipt.

For a code rollback, deploy the previous verified package to this function only.
Disable its timer and pause its seven Healthchecks checks before intentionally
stopping monitoring. For rotation update only its dedicated Resend key, verify
probe plus natural timer, then revoke the replaced key. Do not change SMTP or
the existing maintenance scheduler's configuration.
