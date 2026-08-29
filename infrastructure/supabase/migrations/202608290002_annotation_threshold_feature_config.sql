-- Keep flag-specific runtime values with the existing feature flag document.
-- The annotation threshold remains server-enforced, while operators can change
-- it without adding a one-row settings table or deploying another migration.

alter table private.feature_flags
  add column config jsonb not null default '{}'::jsonb
  check (
    jsonb_typeof(config) = 'object'
    and octet_length(config::text) <= 16384
  );

update private.feature_flags
set config = jsonb_build_object(
  'publicMarkThreshold',
  coalesce((
    select settings.public_mark_threshold
    from private.annotation_settings as settings
    where settings.singleton
  ), 2)
)
where key = 'reader.annotations';

-- Existing revisions predate structured config. Preserve their effective
-- threshold so rolling one forward cannot accidentally clear the setting.
update private.feature_flags as flag
set history = (
  select coalesce(
    jsonb_agg(
      entry.value || jsonb_build_object('config', flag.config)
      order by entry.position
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(flag.history) with ordinality as entry(value, position)
);

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
    'history', flag.history
  )
  from private.feature_flags as flag
  where flag.key = p_key
$$;

create or replace function private.feature_flag_normalize_config(
  p_key text,
  p_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_config jsonb := coalesce(p_config, '{}'::jsonb);
  public_mark_threshold integer;
begin
  if jsonb_typeof(normalized_config) is distinct from 'object' then
    raise invalid_parameter_value using message = 'Feature flag config must be a JSON object';
  end if;
  if octet_length(normalized_config::text) > 16384 then
    raise invalid_parameter_value using message = 'Feature flag config is too large';
  end if;

  if p_key = 'reader.annotations' then
    if exists (
      select 1
      from jsonb_object_keys(normalized_config) as config_key(value)
      where config_key.value <> 'publicMarkThreshold'
    ) then
      raise invalid_parameter_value using message = 'Reader annotation config contains an unknown key';
    end if;
    if normalized_config ? 'publicMarkThreshold' and (
      jsonb_typeof(normalized_config->'publicMarkThreshold') is distinct from 'number'
      or normalized_config->>'publicMarkThreshold' !~ '^([1-9]|[1-9][0-9]|100)$'
    ) then
      raise invalid_parameter_value using message = 'Reader annotation public mark threshold must be an integer from 1 to 100';
    end if;

    public_mark_threshold := coalesce(
      (normalized_config->>'publicMarkThreshold')::integer,
      2
    );
    return jsonb_build_object('publicMarkThreshold', public_mark_threshold);
  end if;

  return normalized_config;
end;
$$;

create or replace function public.operator_get_feature_flag(
  p_operator_token text,
  p_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  return (
    select jsonb_build_object(
      'key', flag.key,
      'revision', flag.revision,
      'rules', flag.rules,
      'config', flag.config
    )
    from private.feature_flags as flag
    where flag.key = p_key
  );
end;
$$;

create function public.operator_publish_feature_flag(
  p_operator_token text,
  p_key text,
  p_rules jsonb,
  p_config jsonb,
  p_expected_revision bigint,
  p_reason text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_revision bigint;
  next_revision bigint;
  normalized_rules jsonb;
  normalized_config jsonb;
  changed_at timestamptz;
  history_entry jsonb;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise invalid_parameter_value using message = 'A change reason of at least 3 characters is required';
  end if;
  normalized_rules := private.feature_flag_normalize_rules(p_rules);
  normalized_config := private.feature_flag_normalize_config(p_key, p_config);

  select flag.revision
  into current_revision
  from private.feature_flags as flag
  where flag.key = p_key
  for update;
  if current_revision is null then
    raise no_data_found using message = 'Unknown feature flag';
  end if;
  if current_revision <> p_expected_revision then
    raise serialization_failure using message = 'Feature flag revision conflict';
  end if;

  next_revision := current_revision + 1;
  changed_at := timezone('utc', now());
  history_entry := jsonb_build_object(
    'revision', next_revision,
    'rules', normalized_rules,
    'config', normalized_config,
    'reason', btrim(p_reason),
    'requestId', nullif(btrim(p_request_id), ''),
    'updatedAt', changed_at
  );
  update private.feature_flags
  set rules = normalized_rules,
      config = normalized_config,
      revision = next_revision,
      history = history || jsonb_build_array(history_entry),
      updated_at = changed_at
  where key = p_key;

  return private.feature_flag_snapshot(p_key);
end;
$$;

create or replace function public.operator_rollback_feature_flag(
  p_operator_token text,
  p_key text,
  p_target_revision bigint,
  p_expected_revision bigint,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_rules jsonb;
  target_config jsonb;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  select entry.value->'rules', coalesce(entry.value->'config', '{}'::jsonb)
  into target_rules, target_config
  from private.feature_flags as flag
  cross join lateral jsonb_array_elements(flag.history) as entry(value)
  where flag.key = p_key
    and (entry.value->>'revision')::bigint = p_target_revision;
  if target_rules is null then
    raise no_data_found using message = 'Unknown feature flag revision';
  end if;
  if p_target_revision = p_expected_revision then
    raise invalid_parameter_value using message = 'The current revision cannot be rolled back to itself';
  end if;

  return public.operator_publish_feature_flag(
    p_operator_token,
    p_key,
    target_rules,
    target_config,
    p_expected_revision,
    '回滚到 revision ' || p_target_revision::text,
    p_request_id
  );
end;
$$;

drop function public.operator_publish_feature_flag(text, text, jsonb, bigint, text, text);

create or replace function private.annotation_public_mark_threshold()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (flag.config->>'publicMarkThreshold')::integer
    from private.feature_flags as flag
    where flag.key = 'reader.annotations'
      and jsonb_typeof(flag.config->'publicMarkThreshold') = 'number'
      and flag.config->>'publicMarkThreshold' ~ '^([1-9]|[1-9][0-9]|100)$'
  ), 2)
$$;

drop table private.annotation_settings;

revoke all on function private.feature_flag_normalize_config(text, jsonb) from public, anon, authenticated;
revoke all on function public.operator_publish_feature_flag(text, text, jsonb, jsonb, bigint, text, text) from public;
grant execute on function public.operator_publish_feature_flag(text, text, jsonb, jsonb, bigint, text, text) to anon, authenticated;

comment on column private.feature_flags.config is
  'Small flag-specific runtime values published and rolled back with rules.';
comment on function private.annotation_public_mark_threshold() is
  'Returns reader.annotations config.publicMarkThreshold, falling back to 2 for invalid or missing private configuration.';
