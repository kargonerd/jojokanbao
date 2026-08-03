# Supabase account backend

`migrations/` contains the database schema used by the shared JOJO account.
`config.toml` keeps hosted Auth settings, redirect URLs, and the
`Before User Created` invitation hook under version control.

## Local configuration

The repository root `.env` must contain:

```dotenv
# Local administration only. Never expose this in a browser build.
SUPABASE_ACCESS_TOKEN=
SUPABASE_PROJECT_REF=

# Public browser configuration.
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_ENABLE_ACCOUNT=true
```

`.env.local` may override values for one machine. Both files are ignored by
Git.

## Apply to a hosted project

Do not apply an unreviewed feature branch to the production project. After the
invitation PR is merged, run these commands from the repository root:

```bash
pnpm dlx supabase link --project-ref <project-ref>
pnpm dlx supabase db push --dry-run
pnpm dlx supabase db push
pnpm dlx supabase --workdir infrastructure config push --project-ref <project-ref>
```

The database migration must be pushed before the Auth config because the config
enables a hook backed by `public.hook_require_signup_invitation`.

The database also enforces redemption with a trigger. Therefore new user
creation fails closed if somebody disables or bypasses the hosted hook.
Existing users are unaffected.

The confirmation email source is
`supabase/templates/confirmation.html` relative to the Supabase workdir. The
hosted template must be updated through `config push` or the Management API;
committing the HTML file alone does not change emails already sent by Supabase.
The template sends readers to `/account/confirm` on the requested JOJO origin.
That page consumes the one-time token hash with Supabase Auth, removes it from
the browser address bar, and offers a resend form when the link is no longer
valid.

The trigger applies to every new Auth user, including users created from the
Supabase dashboard and OAuth identities. Keep those signup paths disabled
unless they are updated to supply an invitation. An invitation is redeemed
when the Auth user is created, before the reader confirms their email.

## Manage invitations

The management commands use the Supabase Management API and the local
`SUPABASE_ACCESS_TOKEN`. They never use a browser key:

```bash
pnpm invite:create
pnpm invite:list
pnpm invite:revoke -- <invitation-id>
```

The create command generates a 6-character code that is valid for 7 days,
can be used once, and is not bound to an email address. Only a SHA-256 digest
is stored. The plaintext is printed once, so save it immediately and send it
through a secure channel. Codes are case-insensitive.

This change intentionally covers administrator-created invitations only.
Giving each authenticated reader one personal invitation belongs to the later
account-center change, where the lifecycle and recovery UI can be reviewed
together.

## Email confirmation

Email confirmation is enabled and returns to `/account`. Supabase's built-in
SMTP is suitable only for owner testing: it sends only to project team
addresses and currently allows two messages per hour. Configure custom SMTP
before inviting external readers.

Useful official references:

- https://supabase.com/docs/guides/auth/auth-hooks
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/reference/cli/supabase-projects-create
