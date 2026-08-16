create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{2,79}$'),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  revision bigint not null default 1 check (revision > 0),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.feature_flag_operator_secret (
  singleton boolean primary key default true check (singleton),
  token_digest bytea not null check (octet_length(token_digest) = 32),
  updated_at timestamptz not null default timezone('utc', now())
);


create or replace function private.feature_flag_evaluate(
  p_key text,
  p_user_id uuid,
  p_visitor_id uuid default null
)
returns table(enabled boolean, matched_rule_id uuid, revision bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_revision bigint;
  current_rules jsonb;
  rule_json jsonb;
  rule_id uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  subject text;
  digest_bytes bytea;
  bucket bigint;
  matches boolean;
begin
  select flag.revision, flag.rules
    into current_revision, current_rules
    from private.feature_flags as flag
    where flag.key = p_key;

  if current_revision is null then
    return query select false, null::uuid, 0::bigint;
    return;
  end if;

  for rule_json in
    select item.rule
      from jsonb_array_elements(current_rules) with ordinality as item(rule, position)
      order by item.position
  loop
    starts_at := nullif(rule_json->>'startsAt', '')::timestamptz;
    ends_at := nullif(rule_json->>'endsAt', '')::timestamptz;
    if not coalesce((rule_json->>'enabled')::boolean, true)
      or (starts_at is not null and now() < starts_at)
      or (ends_at is not null and now() >= ends_at)
    then
      continue;
    end if;

    rule_id := (rule_json->>'id')::uuid;
    matches := false;
    if rule_json->>'conditionType' = 'global' then
      matches := true;
    elsif rule_json->>'conditionType' = 'authenticated' then
      matches := p_user_id is not null;
    elsif rule_json->>'conditionType' = 'users' then
      matches := p_user_id is not null
        and coalesce(rule_json->'userIds', '[]'::jsonb) ? p_user_id::text;
    elsif rule_json->>'conditionType' = 'percentage' then
      subject := case rule_json->>'bucketBy'
        when 'user' then case when p_user_id is not null then 'user:' || p_user_id::text end
        when 'visitor' then case when p_visitor_id is not null then 'visitor:' || p_visitor_id::text end
      end;
      if subject is not null then
        digest_bytes := extensions.digest(
          p_key || ':' || rule_id::text || ':' || (rule_json->>'bucketSalt') || ':' || subject,
          'sha256'
        );
        bucket := mod(
          pg_catalog.get_byte(digest_bytes, 0)::bigint * 16777216
            + pg_catalog.get_byte(digest_bytes, 1)::bigint * 65536
            + pg_catalog.get_byte(digest_bytes, 2)::bigint * 256
            + pg_catalog.get_byte(digest_bytes, 3)::bigint,
          100
        );
        matches := bucket < (rule_json->>'percentage')::integer;
      end if;
    end if;

    if matches then
      return query select (rule_json->>'serve')::boolean, rule_id, current_revision;
      return;
    end if;
  end loop;

  return query select false, null::uuid, current_revision;
end;
$$;

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
    'history', flag.history
  )
  from private.feature_flags as flag
  where flag.key = p_key
$$;

create or replace function public.get_my_feature_flags(
  p_keys text[],
  p_visitor_id uuid default null
)
returns table(flag_key text, enabled boolean, revision bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select requested.key, evaluation.enabled, evaluation.revision
    from unnest(p_keys) with ordinality as requested(key, position)
    cross join lateral private.feature_flag_evaluate(requested.key, auth.uid(), p_visitor_id) as evaluation
    order by requested.position
$$;

create or replace function public.feature_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select evaluation.enabled
    from private.feature_flag_evaluate(p_key, auth.uid(), null) as evaluation
$$;

create or replace function private.feature_flag_operator_authorized(p_operator_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select char_length(coalesce(p_operator_token, '')) >= 32 and exists (
    select 1
      from private.feature_flag_operator_secret as secret
      where secret.singleton
        and secret.token_digest = extensions.digest(p_operator_token, 'sha256')
  )
$$;

create or replace function private.require_feature_flag_operator(p_operator_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.feature_flag_operator_authorized(p_operator_token) then
    raise insufficient_privilege using message = 'Feature flag operator token is invalid';
  end if;
end;
$$;

create or replace function private.feature_flag_normalize_rules(p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_rules jsonb := '[]'::jsonb;
  normalized_users jsonb;
  rule_json jsonb;
  condition_name text;
  rule_name text;
  rule_id uuid;
  percentage integer;
  bucket_by text;
  bucket_salt uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  enabled boolean;
  is_fallback boolean;
  serve boolean;
  fallback_count integer;
  rule_count integer;
begin
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise invalid_parameter_value using message = 'Rules must be a JSON array';
  end if;

  rule_count := jsonb_array_length(p_rules);
  if rule_count < 1 or rule_count > 50 then
    raise invalid_parameter_value using message = 'A feature flag must contain between 1 and 50 rules';
  end if;

  select count(*)::integer
    into fallback_count
    from jsonb_array_elements(p_rules) as item(rule)
    where coalesce((item.rule->>'isFallback')::boolean, false);
  if fallback_count <> 1
    or coalesce((p_rules->(rule_count - 1)->>'isFallback')::boolean, false) is not true
    or p_rules->(rule_count - 1)->>'conditionType' <> 'global'
    or coalesce((p_rules->(rule_count - 1)->>'enabled')::boolean, true) is not true
    or nullif(p_rules->(rule_count - 1)->>'startsAt', '') is not null
    or nullif(p_rules->(rule_count - 1)->>'endsAt', '') is not null
  then
    raise invalid_parameter_value using message = 'The last rule must be the single enabled global fallback';
  end if;

  for rule_json in select item.rule from jsonb_array_elements(p_rules) as item(rule)
  loop
    if jsonb_typeof(rule_json) is distinct from 'object' then
      raise invalid_parameter_value using message = 'Each feature flag rule must be an object';
    end if;

    condition_name := rule_json->>'conditionType';
    if condition_name is null
      or condition_name not in ('users', 'percentage', 'authenticated', 'global')
    then
      raise invalid_parameter_value using message = 'Unknown feature flag rule condition';
    end if;

    rule_name := btrim(coalesce(rule_json->>'name', ''));
    if char_length(rule_name) < 1 or char_length(rule_name) > 120 then
      raise invalid_parameter_value using message = 'Rule names must contain between 1 and 120 characters';
    end if;
    if jsonb_typeof(rule_json->'serve') is distinct from 'boolean' then
      raise invalid_parameter_value using message = 'Rule serve must be boolean';
    end if;
    if rule_json ? 'enabled' and jsonb_typeof(rule_json->'enabled') <> 'boolean' then
      raise invalid_parameter_value using message = 'Rule enabled must be boolean';
    end if;
    if rule_json ? 'isFallback' and jsonb_typeof(rule_json->'isFallback') <> 'boolean' then
      raise invalid_parameter_value using message = 'Rule isFallback must be boolean';
    end if;

    rule_id := case
      when coalesce(rule_json->>'id', '') = '' then extensions.gen_random_uuid()
      else (rule_json->>'id')::uuid
    end;
    serve := (rule_json->>'serve')::boolean;
    enabled := coalesce((rule_json->>'enabled')::boolean, true);
    is_fallback := coalesce((rule_json->>'isFallback')::boolean, false);
    starts_at := nullif(rule_json->>'startsAt', '')::timestamptz;
    ends_at := nullif(rule_json->>'endsAt', '')::timestamptz;
    if starts_at is not null and ends_at is not null and ends_at <= starts_at then
      raise invalid_parameter_value using message = 'Rule end time must be after its start time';
    end if;

    percentage := null;
    bucket_by := null;
    bucket_salt := null;
    if condition_name = 'percentage' then
      percentage := (rule_json->>'percentage')::integer;
      bucket_by := rule_json->>'bucketBy';
      if percentage is null or percentage not between 1 and 100 then
        raise invalid_parameter_value using message = 'Percentage rules must use an integer from 1 to 100';
      end if;
      if bucket_by is null or bucket_by not in ('user', 'visitor') then
        raise invalid_parameter_value using message = 'Percentage rules must bucket by user or visitor';
      end if;
      bucket_salt := case
        when coalesce(rule_json->>'bucketSalt', '') = '' then extensions.gen_random_uuid()
        else (rule_json->>'bucketSalt')::uuid
      end;
    end if;

    normalized_users := '[]'::jsonb;
    if condition_name = 'users' then
      if jsonb_typeof(coalesce(rule_json->'userIds', '[]'::jsonb)) <> 'array' then
        raise invalid_parameter_value using message = 'User rules must contain a userIds array';
      end if;
      perform member.value::uuid
        from jsonb_array_elements_text(coalesce(rule_json->'userIds', '[]'::jsonb)) as member(value);
      select coalesce(jsonb_agg(member.value order by member.value), '[]'::jsonb)
        into normalized_users
        from (
          select distinct value
            from jsonb_array_elements_text(coalesce(rule_json->'userIds', '[]'::jsonb))
        ) as member(value);
    end if;

    normalized_rules := normalized_rules || jsonb_build_array(jsonb_build_object(
      'id', rule_id,
      'name', rule_name,
      'conditionType', condition_name,
      'serve', serve,
      'percentage', percentage,
      'bucketBy', bucket_by,
      'bucketSalt', bucket_salt,
      'startsAt', starts_at,
      'endsAt', ends_at,
      'enabled', enabled,
      'isFallback', is_fallback,
      'userIds', normalized_users
    ));
  end loop;

  return normalized_rules;
end;
$$;

create or replace function public.operator_list_feature_flags(p_operator_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  return coalesce((
    select jsonb_agg(private.feature_flag_snapshot(flag.key) order by flag.key)
      from private.feature_flags as flag
  ), '[]'::jsonb);
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
      'rules', flag.rules
    )
      from private.feature_flags as flag
      where flag.key = p_key
  );
end;
$$;

create or replace function public.operator_search_feature_users(
  p_operator_token text,
  p_query text
)
returns table(user_id uuid, display_name text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text := btrim(coalesce(p_query, ''));
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if char_length(normalized_query) < 2 then
    return;
  end if;
  return query
    select account.id, profile.display_name, account.email::text
      from auth.users as account
      left join public.profiles as profile on profile.id = account.id
      where account.id::text = normalized_query
         or profile.display_name ilike '%' || normalized_query || '%'
         or account.email ilike '%' || normalized_query || '%'
      order by profile.display_name nulls last, account.email
      limit 20;
end;
$$;

create or replace function public.operator_publish_feature_flag(
  p_operator_token text,
  p_key text,
  p_rules jsonb,
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
  changed_at timestamptz;
  history_entry jsonb;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise invalid_parameter_value using message = 'A change reason of at least 3 characters is required';
  end if;
  normalized_rules := private.feature_flag_normalize_rules(p_rules);

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
    'reason', btrim(p_reason),
    'requestId', nullif(btrim(p_request_id), ''),
    'updatedAt', changed_at
  );
  update private.feature_flags
    set rules = normalized_rules,
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
begin
  perform private.require_feature_flag_operator(p_operator_token);
  select entry.value->'rules'
    into target_rules
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
    p_expected_revision,
    '回滚到 revision ' || p_target_revision::text,
    p_request_id
  );
end;
$$;

revoke all on function private.feature_flag_evaluate(text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.feature_flag_snapshot(text) from public, anon, authenticated;
revoke all on function private.feature_flag_operator_authorized(text) from public, anon, authenticated;
revoke all on function private.require_feature_flag_operator(text) from public, anon, authenticated;
revoke all on function private.feature_flag_normalize_rules(jsonb) from public, anon, authenticated;
revoke all on function public.get_my_feature_flags(text[], uuid) from public;
revoke all on function public.feature_enabled(text) from public;
revoke all on function public.operator_list_feature_flags(text) from public;
revoke all on function public.operator_get_feature_flag(text, text) from public;
revoke all on function public.operator_search_feature_users(text, text) from public;
revoke all on function public.operator_publish_feature_flag(text, text, jsonb, bigint, text, text) from public;
revoke all on function public.operator_rollback_feature_flag(text, text, bigint, bigint, text) from public;
grant execute on function public.get_my_feature_flags(text[], uuid) to anon, authenticated;
grant execute on function public.feature_enabled(text) to authenticated;
grant execute on function public.operator_list_feature_flags(text) to anon, authenticated;
grant execute on function public.operator_get_feature_flag(text, text) to anon, authenticated;
grant execute on function public.operator_search_feature_users(text, text) to anon, authenticated;
grant execute on function public.operator_publish_feature_flag(text, text, jsonb, bigint, text, text) to anon, authenticated;
grant execute on function public.operator_rollback_feature_flag(text, text, bigint, bigint, text) to anon, authenticated;

insert into private.feature_flags(key, description, rules)
values
  ('library.bookshelf', '登录读者的服务端书架', jsonb_build_array(
    jsonb_build_object('id', '10000000-0000-4000-8000-000000000001', 'name', '已登录读者', 'conditionType', 'authenticated', 'serve', true, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', false, 'userIds', jsonb_build_array()),
    jsonb_build_object('id', '10000000-0000-4000-8000-000000000002', 'name', '默认关闭', 'conditionType', 'global', 'serve', false, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', true, 'userIds', jsonb_build_array())
  )),
  ('olds.workspace', '尚未完成的旧闻工作区', jsonb_build_array(
    jsonb_build_object('id', '50000000-0000-4000-8000-000000000001', 'name', '整体关闭', 'conditionType', 'global', 'serve', false, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', true, 'userIds', jsonb_build_array())
  )),
  ('rag.workspace', 'RAG 工作区路由与导航', jsonb_build_array(
    jsonb_build_object('id', '40000000-0000-4000-8000-000000000001', 'name', '内部测试用户', 'conditionType', 'users', 'serve', true, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', false, 'userIds', jsonb_build_array()),
    jsonb_build_object('id', '40000000-0000-4000-8000-000000000002', 'name', '默认关闭', 'conditionType', 'global', 'serve', false, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', true, 'userIds', jsonb_build_array())
  )),
  ('reader.annotations', '划线、想法和 AI 解释数据', jsonb_build_array(
    jsonb_build_object('id', '20000000-0000-4000-8000-000000000001', 'name', '已登录读者', 'conditionType', 'authenticated', 'serve', true, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', false, 'userIds', jsonb_build_array()),
    jsonb_build_object('id', '20000000-0000-4000-8000-000000000002', 'name', '默认关闭', 'conditionType', 'global', 'serve', false, 'percentage', null, 'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'enabled', true, 'isFallback', true, 'userIds', jsonb_build_array())
  ))
on conflict (key) do nothing;

update private.feature_flags
  set history = jsonb_build_array(jsonb_build_object(
    'revision', revision,
    'rules', rules,
    'reason', '初始配置',
    'requestId', null,
    'updatedAt', updated_at
  ))
  where history = '[]'::jsonb;

drop policy if exists "reader_bookshelf_own" on public.reader_bookshelf;
create policy "reader_bookshelf_own"
  on public.reader_bookshelf for all to authenticated
  using ((select auth.uid()) = user_id and public.feature_enabled('library.bookshelf'))
  with check ((select auth.uid()) = user_id and public.feature_enabled('library.bookshelf'));

drop policy if exists "reader_marks_own" on public.reader_marks;
create policy "reader_marks_own"
  on public.reader_marks for all to authenticated
  using ((select auth.uid()) = user_id and public.feature_enabled('reader.annotations'))
  with check ((select auth.uid()) = user_id and public.feature_enabled('reader.annotations'));

drop policy if exists "reader_ai_explanations_read_own" on public.reader_ai_explanations;
drop policy if exists "reader_ai_explanations_insert_own" on public.reader_ai_explanations;
drop policy if exists "reader_ai_explanations_update_own" on public.reader_ai_explanations;
drop policy if exists "reader_ai_explanations_delete_own" on public.reader_ai_explanations;
create policy "reader_ai_explanations_own"
  on public.reader_ai_explanations for all to authenticated
  using ((select auth.uid()) = user_id and public.feature_enabled('reader.annotations'))
  with check ((select auth.uid()) = user_id and public.feature_enabled('reader.annotations'));

-- These aggregate readers are SECURITY DEFINER functions, so they must enforce
-- the runtime gate explicitly instead of relying on row-level security.
create or replace function public.get_reusable_reader_explanation(p_dataset_id text, p_item_id text, p_phrase_key text)
returns table(quote text, answer text, explanation_count bigint)
language sql security definer set search_path = '' stable
as $$
  select min(e.quote), e.answer, count(*)
  from public.reader_ai_explanations e
  where public.feature_enabled('reader.annotations')
    and e.dataset_id = p_dataset_id
    and e.item_id = p_item_id
    and e.phrase_key = p_phrase_key
    and e.answer is not null
  group by e.answer
  order by count(*) desc, e.answer
  limit 1
$$;

create or replace function public.get_popular_reader_explanations(p_dataset_id text, p_item_id text, p_chapter_id text)
returns table(quote text, answer text, explanation_count bigint)
language sql security definer set search_path = '' stable
as $$
  select min(e.quote), e.answer, count(*)
  from public.reader_ai_explanations e
  where public.feature_enabled('reader.annotations')
    and e.dataset_id = p_dataset_id
    and e.item_id = p_item_id
    and e.chapter_id = p_chapter_id
    and e.answer is not null
  group by e.phrase_key, e.answer
  having count(*) >= 2
  order by count(*) desc, min(e.quote)
  limit 50
$$;
