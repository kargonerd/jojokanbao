-- Bookshelf, shared annotations and speech are regular authenticated features.
-- Keep all legacy rows, rules and history for already installed clients. Only
-- retire their operator controls; reader.annotations still owns runtime config.
comment on function public.feature_enabled(text) is
  'Legacy SQL gate. Bookshelf, annotations and speech require login; ownership and other authorization remain independently enforced.';

create or replace function private.feature_flag_snapshot(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'key', flag.key, 'description', flag.description, 'revision', flag.revision,
    'updatedAt', flag.updated_at, 'rules', flag.rules, 'config', flag.config, 'history', flag.history,
    'rolloutProvider', case when flag.key in (
      'library.bookshelf', 'reader.annotations', 'reader.speech', 'rag.workspace', 'olds.workspace'
    ) then 'retired' else 'supabase' end,
    'configProvider', flag.config_provider, 'configRemoteVersion', flag.config_remote_version,
    'configSyncedAt', flag.config_synced_at
  ) from private.feature_flags flag where flag.key = p_key
$$;

create or replace function public.operator_list_feature_flags(p_operator_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  return coalesce((
    select jsonb_agg(private.feature_flag_snapshot(flag.key) order by flag.key)
    from private.feature_flags flag
    where flag.key not in ('library.bookshelf', 'reader.speech', 'rag.workspace', 'olds.workspace')
  ), '[]'::jsonb);
end;
$$;
