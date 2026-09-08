# Hosted comment smoke test

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
