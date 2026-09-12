-- PostHog owns these small parameter documents. Existing rows remain the durable
-- server cache: retain every live value, rule, revision, history and usage lease.
alter table private.feature_flags
  add column config_provider text not null default 'supabase' check (config_provider in ('supabase', 'posthog')),
  add column config_remote_id bigint,
  add column config_remote_version bigint not null default 0,
  add column config_synced_at timestamptz;
update private.feature_flags set config_provider = 'posthog'
where key in ('auth.signup', 'reader.annotations', 'ai.usage_limits', 'ops.email_quota');

create or replace function private.feature_flag_snapshot(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'key', flag.key, 'description', flag.description, 'revision', flag.revision,
    'updatedAt', flag.updated_at, 'rules', flag.rules, 'config', flag.config, 'history', flag.history,
    'rolloutProvider', case when flag.key in ('library.bookshelf', 'reader.annotations', 'reader.speech') then 'posthog' else 'supabase' end,
    'configProvider', flag.config_provider, 'configRemoteVersion', flag.config_remote_version,
    'configSyncedAt', flag.config_synced_at
  ) from private.feature_flags flag where flag.key = p_key
$$;

create function private.guard_posthog_config_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.config_provider = 'posthog' and new.config is distinct from old.config
    and current_setting('jojo.posthog_config_sync', true) is distinct from 'on' then
    raise insufficient_privilege using message = 'Runtime config is managed in PostHog';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_posthog_config_write() from public, anon, authenticated;
create trigger guard_posthog_config_write before update of config on private.feature_flags
  for each row execute function private.guard_posthog_config_write();

-- Operator authorization and revision/history remain the existing mechanism.
-- No browser, scheduler-state credential or client-supplied flag can publish.
create function public.operator_sync_posthog_configs(p_operator_token text, p_updates jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  current_flag private.feature_flags%rowtype;
  next_config jsonb;
  remote_id bigint;
  remote_version bigint;
  threshold numeric;
  previous_setting text := current_setting('jojo.posthog_config_sync', true);
  changed jsonb := '[]'::jsonb;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if jsonb_typeof(p_updates) is distinct from 'array' or jsonb_array_length(p_updates) > 4
    or octet_length(p_updates::text) > 70000 then
    raise invalid_parameter_value using message = 'Invalid PostHog config batch';
  end if;
  if (select count(*) from jsonb_array_elements(p_updates)) <>
     (select count(distinct value->>'key') from jsonb_array_elements(p_updates)) then
    raise invalid_parameter_value using message = 'Duplicate PostHog config key';
  end if;
  for item in select value from jsonb_array_elements(p_updates) order by value->>'key' loop
    if item->>'key' not in ('auth.signup', 'reader.annotations', 'ai.usage_limits', 'ops.email_quota')
      or item->>'key' is null or jsonb_typeof(item->'config') is distinct from 'object' then
      raise invalid_parameter_value using message = 'Invalid PostHog config key or payload';
    end if;
    remote_id := (item->>'remoteId')::bigint;
    remote_version := (item->>'remoteVersion')::bigint;
    if remote_id is null or remote_id <= 0 or remote_version is null or remote_version <= 0 then
      raise invalid_parameter_value using message = 'Invalid PostHog config version';
    end if;
    select * into strict current_flag from private.feature_flags where key = item->>'key' for update;
    if current_flag.config_provider <> 'posthog' then
      raise insufficient_privilege using message = 'PostHog config migration not enabled';
    end if;
    if current_flag.config_remote_id is not null and current_flag.config_remote_id <> remote_id then
      raise invalid_parameter_value using message = 'PostHog config identity changed';
    end if;
    if remote_version < current_flag.config_remote_version then
      raise serialization_failure using message = 'Stale PostHog config version';
    end if;
    -- Every required parameter must be present, even though unknown existing
    -- fields are preserved by the merge below. Missing payloads never reset limits.
    if (current_flag.key = 'auth.signup' and not (item->'config' ? 'invitationRequired'))
      or (current_flag.key = 'reader.annotations' and not (item->'config' ? 'publicMarkThreshold'))
      or (current_flag.key = 'ai.usage_limits' and not (item->'config' ?& array['requestsPerMinute','requestsPerDay','maxRunSeconds']))
      or (current_flag.key = 'ops.email_quota' and not (item->'config' ?& array['warningPercent','criticalPercent','usageSource','dailyLimit','monthlyLimit'])) then
      raise invalid_parameter_value using message = 'Incomplete PostHog config payload';
    end if;
    if current_flag.key = 'reader.annotations' then
      if jsonb_typeof(item->'config'->'publicMarkThreshold') is distinct from 'number' then
        raise invalid_parameter_value using message = 'Annotation threshold must be an integer between 1 and 100';
      end if;
      threshold := (item->'config'->>'publicMarkThreshold')::numeric;
      if trunc(threshold) <> threshold or threshold < 1 or threshold > 100 then
        raise invalid_parameter_value using message = 'Annotation threshold must be an integer between 1 and 100';
      end if;
    end if;
    next_config := current_flag.config || (item->'config');
    -- First bind is a migration checkpoint, not permission to overwrite values
    -- changed in production since the PostHog documents were exported.
    if current_flag.config_remote_id is null and next_config is distinct from current_flag.config then
      raise serialization_failure using message = 'Initial PostHog config must match current server values';
    end if;
    if remote_version = current_flag.config_remote_version and next_config is distinct from current_flag.config then
      raise serialization_failure using message = 'PostHog config changed without a new version';
    end if;
    -- An ambiguous successful HTTP request is safe to repeat without new history.
    if next_config is distinct from current_flag.config then
      if current_flag.revision is distinct from (item->>'expectedRevision')::bigint then
        raise serialization_failure using message = 'Feature flag revision conflict';
      end if;
      perform set_config('jojo.posthog_config_sync', 'on', true);
      perform public.operator_publish_feature_flag(p_operator_token, current_flag.key,
        current_flag.rules, next_config, current_flag.revision,
        'PostHog remote config version ' || remote_version::text,
        'posthog:' || remote_id::text || ':' || remote_version::text);
      perform set_config('jojo.posthog_config_sync', coalesce(previous_setting, ''), true);
      changed := changed || jsonb_build_array(current_flag.key);
    end if;
    update private.feature_flags set config_remote_id = remote_id,
      config_remote_version = remote_version, config_synced_at = clock_timestamp()
      where key = current_flag.key;
  end loop;
  return jsonb_build_object('changed', changed, 'checked', jsonb_array_length(p_updates));
end;
$$;
revoke all on function public.operator_sync_posthog_configs(text, jsonb) from public;
grant execute on function public.operator_sync_posthog_configs(text, jsonb) to anon, authenticated;
