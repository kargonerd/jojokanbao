-- Product rollouts move to the clients' PostHog SDK caches. They are not
-- authorization: login, ownership, moderation and quotas remain server enforced.
-- Apply only after exporting the live rules/config/history and configuring the
-- PostHog project; see docs/posthog.md. No live rule or runtime value is overwritten.
-- Legacy clients continue reading the existing get_my_feature_flags snapshots.
create or replace function public.feature_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_key in ('library.bookshelf', 'reader.annotations', 'reader.speech')
      then auth.uid() is not null
    else coalesce((select enabled from private.feature_flag_evaluate(p_key, auth.uid(), null)), false)
  end
$$;

comment on function public.feature_enabled(text) is
  'Legacy SQL gate. PostHog product rollouts require login here; client flags never grant data access.';

create or replace function private.feature_flag_snapshot(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'key', flag.key,
    'description', flag.description,
    'revision', flag.revision,
    'updatedAt', flag.updated_at,
    'rules', flag.rules,
    'config', flag.config,
    'history', flag.history,
    'rolloutProvider', case when flag.key in ('library.bookshelf', 'reader.annotations', 'reader.speech') then 'posthog' else 'supabase' end
  )
  from private.feature_flags as flag
  where flag.key = p_key
$$;
