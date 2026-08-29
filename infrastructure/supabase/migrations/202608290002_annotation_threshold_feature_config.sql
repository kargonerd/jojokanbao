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

create or replace function private.feature_flag_normalize_config(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_config jsonb := coalesce(p_config, '{}'::jsonb);
begin
  if jsonb_typeof(normalized_config) is distinct from 'object' then
    raise invalid_parameter_value using message = 'Feature flag config must be a JSON object';
  end if;
  if octet_length(normalized_config::text) > 16384 then
    raise invalid_parameter_value using message = 'Feature flag config is too large';
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
  normalized_config := private.feature_flag_normalize_config(p_config);

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

create or replace function private.feature_flag_config_integer(
  p_key text,
  p_config_path text[],
  p_default integer,
  p_minimum integer default null,
  p_maximum integer default null
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  config_value jsonb;
  numeric_value numeric;
begin
  if coalesce(cardinality(p_config_path), 0) = 0 then
    return p_default;
  end if;

  select flag.config #> p_config_path
  into config_value
  from private.feature_flags as flag
  where flag.key = p_key;

  if jsonb_typeof(config_value) is distinct from 'number' then
    return p_default;
  end if;

  begin
    numeric_value := config_value::text::numeric;
  exception when others then
    return p_default;
  end;

  if trunc(numeric_value) <> numeric_value
    or numeric_value < -2147483648
    or numeric_value > 2147483647
    or (p_minimum is not null and numeric_value < p_minimum)
    or (p_maximum is not null and numeric_value > p_maximum)
  then
    return p_default;
  end if;

  return numeric_value::integer;
end;
$$;

create or replace function private.annotation_snapshot(p_annotation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', annotation.id,
    'contentType', annotation.content_type,
    'contentId', annotation.content_id,
    'sectionId', annotation.section_id,
    'contentTitle', annotation.content_title,
    'contentUrl', annotation.content_url,
    'authorId', annotation.user_id,
    'authorName', coalesce(profile.display_name, 'JOJO 读者'),
    'quote', annotation.quote,
    'prefix', annotation.prefix,
    'suffix', annotation.suffix,
    'startOffset', annotation.start_offset,
    'endOffset', annotation.end_offset,
    'createdAt', annotation.created_at,
    'underlineCount', mark_summary.reader_count,
    'underlinedByMe', mark_summary.underlined_by_me,
    'publiclyVisible',
      mark_summary.reader_count >= private.feature_flag_config_integer(
        'reader.annotations', array['publicMarkThreshold'], 2, 1, 100
      )
      or exists (
        select 1
        from public.annotation_comments public_comment
        where public_comment.annotation_id = annotation.id
          and public_comment.visibility = 'public'
          and public_comment.moderation_status = 'visible'
      ),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', comment.id,
        'annotationId', comment.annotation_id,
        'parentCommentId', comment.parent_comment_id,
        'authorId', comment.user_id,
        'authorName', coalesce(comment_profile.display_name, 'JOJO 读者'),
        'body', comment.body,
        'visibility', comment.visibility,
        'createdAt', comment.created_at,
        'reportedByMe', exists (
          select 1 from public.annotation_comment_reports report
          where report.comment_id = comment.id and report.reporter_id = auth.uid()
        )
      ) order by comment.created_at)
      from public.annotation_comments comment
      left join public.profiles comment_profile on comment_profile.id = comment.user_id
      where comment.annotation_id = annotation.id
        and comment.moderation_status = 'visible'
        and (comment.visibility = 'public' or comment.user_id = auth.uid())
    ), '[]'::jsonb)
  )
  from public.content_annotations annotation
  left join public.profiles profile on profile.id = annotation.user_id
  cross join lateral (
    select
      count(*)::integer as reader_count,
      coalesce(bool_or(mark.user_id = auth.uid()), false) as underlined_by_me
    from public.content_annotation_marks mark
    where mark.annotation_id = annotation.id
  ) mark_summary
  where annotation.id = p_annotation_id
    and annotation.moderation_status = 'visible'
$$;

create or replace function public.get_annotation_threads(
  p_content_type text,
  p_content_id text,
  p_section_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
  public_threshold integer := private.feature_flag_config_integer(
    'reader.annotations', array['publicMarkThreshold'], 2, 1, 100
  );
begin
  return coalesce((
    select jsonb_agg(private.annotation_snapshot(annotation.id) order by annotation.created_at)
    from public.content_annotations annotation
    where annotation.content_type = p_content_type
      and annotation.content_id = p_content_id
      and annotation.section_id = p_section_id
      and annotation.moderation_status = 'visible'
      and (
        exists (
          select 1
          from public.content_annotation_marks own_mark
          where own_mark.annotation_id = annotation.id
            and own_mark.user_id = reader_id
        )
        or public_threshold <= (
          select count(*)
          from public.content_annotation_marks shared_mark
          where shared_mark.annotation_id = annotation.id
        )
        or exists (
          select 1
          from public.annotation_comments public_comment
          where public_comment.annotation_id = annotation.id
            and public_comment.visibility = 'public'
            and public_comment.moderation_status = 'visible'
        )
      )
  ), '[]'::jsonb);
end;
$$;

drop function private.annotation_public_mark_threshold();

drop table private.annotation_settings;

revoke all on function private.feature_flag_normalize_config(jsonb) from public, anon, authenticated;
revoke all on function private.feature_flag_config_integer(text, text[], integer, integer, integer) from public, anon, authenticated;
revoke all on function public.operator_publish_feature_flag(text, text, jsonb, jsonb, bigint, text, text) from public;
grant execute on function public.operator_publish_feature_flag(text, text, jsonb, jsonb, bigint, text, text) to anon, authenticated;

comment on column private.feature_flags.config is
  'Small flag-specific runtime values published and rolled back with rules.';
comment on function private.feature_flag_config_integer(text, text[], integer, integer, integer) is
  'Reads any integer feature config path with caller-provided default and bounds.';
