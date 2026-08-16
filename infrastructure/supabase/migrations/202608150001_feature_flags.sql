create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{2,79}$'),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  emergency_disabled boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.feature_flag_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  flag_key text not null references private.feature_flags(key) on delete cascade,
  position integer not null check (position >= 0),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  condition_type text not null check (condition_type in ('users', 'percentage', 'authenticated', 'global')),
  serve boolean not null,
  percentage integer,
  bucket_by text,
  bucket_salt uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  enabled boolean not null default true,
  is_fallback boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (
    (condition_type = 'percentage' and percentage between 1 and 100 and bucket_by in ('user', 'visitor') and bucket_salt is not null)
    or
    (condition_type <> 'percentage' and percentage is null and bucket_by is null and bucket_salt is null)
  ),
  check (
    not is_fallback
    or (condition_type = 'global' and enabled and starts_at is null and ends_at is null)
  ),
  unique (flag_key, position)
);

create unique index if not exists feature_flag_one_fallback
  on private.feature_flag_rules(flag_key)
  where is_fallback;

create table if not exists private.feature_flag_rule_users (
  rule_id uuid not null references private.feature_flag_rules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (rule_id, user_id)
);

create index if not exists feature_flag_rule_users_user
  on private.feature_flag_rule_users(user_id, rule_id);

create table if not exists private.feature_flag_operator_secret (
  singleton boolean primary key default true check (singleton),
  token_digest bytea not null check (octet_length(token_digest) = 32),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.feature_flag_audit_log (
  id bigint generated always as identity primary key,
  flag_key text not null,
  revision bigint not null,
  action text not null check (action in ('publish', 'seed')),
  before_state jsonb,
  after_state jsonb not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  request_id text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists feature_flag_audit_key_revision
  on private.feature_flag_audit_log(flag_key, revision desc);

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
  emergency_disabled boolean;
  rule_record record;
  subject text;
  digest_bytes bytea;
  bucket bigint;
  matches boolean;
begin
  select flag.revision, flag.emergency_disabled
    into current_revision, emergency_disabled
    from private.feature_flags as flag
    where flag.key = p_key;

  if current_revision is null then
    return query select false, null::uuid, 0::bigint;
    return;
  end if;

  if emergency_disabled then
    return query select false, null::uuid, current_revision;
    return;
  end if;

  for rule_record in
    select rule.*
      from private.feature_flag_rules as rule
      where rule.flag_key = p_key
      order by rule.position, rule.id
  loop
    if not rule_record.enabled
      or (rule_record.starts_at is not null and now() < rule_record.starts_at)
      or (rule_record.ends_at is not null and now() >= rule_record.ends_at)
    then
      continue;
    end if;

    matches := false;
    if rule_record.condition_type = 'global' then
      matches := true;
    elsif rule_record.condition_type = 'authenticated' then
      matches := p_user_id is not null;
    elsif rule_record.condition_type = 'users' then
      matches := p_user_id is not null and exists (
        select 1
          from private.feature_flag_rule_users as member
          where member.rule_id = rule_record.id
            and member.user_id = p_user_id
      );
    elsif rule_record.condition_type = 'percentage' then
      subject := case rule_record.bucket_by
        when 'user' then case when p_user_id is not null then 'user:' || p_user_id::text end
        when 'visitor' then case when p_visitor_id is not null then 'visitor:' || p_visitor_id::text end
      end;
      if subject is not null then
        digest_bytes := extensions.digest(
          p_key || ':' || rule_record.id::text || ':' || rule_record.bucket_salt::text || ':' || subject,
          'sha256'
        );
        bucket := mod(
          pg_catalog.get_byte(digest_bytes, 0)::bigint * 16777216
            + pg_catalog.get_byte(digest_bytes, 1)::bigint * 65536
            + pg_catalog.get_byte(digest_bytes, 2)::bigint * 256
            + pg_catalog.get_byte(digest_bytes, 3)::bigint,
          100
        );
        matches := bucket < rule_record.percentage;
      end if;
    end if;

    if matches then
      return query select rule_record.serve, rule_record.id, current_revision;
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
    'emergencyDisabled', flag.emergency_disabled,
    'revision', flag.revision,
    'updatedAt', flag.updated_at,
    'updatedBy', flag.updated_by,
    'rules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rule.id,
          'name', rule.name,
          'conditionType', rule.condition_type,
          'serve', rule.serve,
          'percentage', rule.percentage,
          'bucketBy', rule.bucket_by,
          'bucketSalt', rule.bucket_salt,
          'startsAt', rule.starts_at,
          'endsAt', rule.ends_at,
          'enabled', rule.enabled,
          'isFallback', rule.is_fallback,
          'userIds', coalesce((
            select jsonb_agg(member.user_id order by member.user_id)
              from private.feature_flag_rule_users as member
              where member.rule_id = rule.id
          ), '[]'::jsonb)
        )
        order by rule.position
      )
      from private.feature_flag_rules as rule
      where rule.flag_key = flag.key
    ), '[]'::jsonb)
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
  p_emergency_disabled boolean,
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
  before_snapshot jsonb;
  after_snapshot jsonb;
  rule_json jsonb;
  rule_position bigint;
  new_rule_id uuid;
  condition_name text;
  fallback_count integer;
  rule_count integer;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise invalid_parameter_value using message = 'A change reason of at least 3 characters is required';
  end if;
  if jsonb_typeof(p_rules) <> 'array' then
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
  then
    raise invalid_parameter_value using message = 'The last rule must be the single enabled global fallback';
  end if;

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

  before_snapshot := private.feature_flag_snapshot(p_key);
  delete from private.feature_flag_rules where flag_key = p_key;

  for rule_json, rule_position in
    select item.rule, item.position - 1
      from jsonb_array_elements(p_rules) with ordinality as item(rule, position)
  loop
    condition_name := rule_json->>'conditionType';
    if condition_name not in ('users', 'percentage', 'authenticated', 'global') then
      raise invalid_parameter_value using message = 'Unknown feature flag rule condition';
    end if;

    new_rule_id := case
      when coalesce(rule_json->>'id', '') = '' then extensions.gen_random_uuid()
      else (rule_json->>'id')::uuid
    end;

    insert into private.feature_flag_rules (
      id, flag_key, position, name, condition_type, serve,
      percentage, bucket_by, bucket_salt, starts_at, ends_at, enabled, is_fallback
    ) values (
      new_rule_id,
      p_key,
      rule_position,
      rule_json->>'name',
      condition_name,
      (rule_json->>'serve')::boolean,
      case when condition_name = 'percentage' then (rule_json->>'percentage')::integer end,
      case when condition_name = 'percentage' then rule_json->>'bucketBy' end,
      case when condition_name = 'percentage' then coalesce(nullif(rule_json->>'bucketSalt', '')::uuid, extensions.gen_random_uuid()) end,
      nullif(rule_json->>'startsAt', '')::timestamptz,
      nullif(rule_json->>'endsAt', '')::timestamptz,
      coalesce((rule_json->>'enabled')::boolean, true),
      coalesce((rule_json->>'isFallback')::boolean, false)
    );

    if condition_name = 'users' then
      insert into private.feature_flag_rule_users(rule_id, user_id)
      select new_rule_id, member.value::uuid
        from jsonb_array_elements_text(coalesce(rule_json->'userIds', '[]'::jsonb)) as member(value)
      on conflict do nothing;
    end if;
  end loop;

  next_revision := current_revision + 1;
  update private.feature_flags
    set revision = next_revision,
        emergency_disabled = p_emergency_disabled,
        updated_by = null,
        updated_at = timezone('utc', now())
    where key = p_key;
  after_snapshot := private.feature_flag_snapshot(p_key);

  insert into private.feature_flag_audit_log(
    flag_key, revision, action, before_state, after_state, actor_user_id, reason, request_id
  ) values (
    p_key, next_revision, 'publish', before_snapshot, after_snapshot, null, btrim(p_reason), nullif(btrim(p_request_id), '')
  );

  return after_snapshot;
end;
$$;

revoke all on function private.feature_flag_evaluate(text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.feature_flag_snapshot(text) from public, anon, authenticated;
revoke all on function private.feature_flag_operator_authorized(text) from public, anon, authenticated;
revoke all on function private.require_feature_flag_operator(text) from public, anon, authenticated;
revoke all on function public.get_my_feature_flags(text[], uuid) from public;
revoke all on function public.feature_enabled(text) from public;
revoke all on function public.operator_list_feature_flags(text) from public;
revoke all on function public.operator_search_feature_users(text, text) from public;
revoke all on function public.operator_publish_feature_flag(text, text, jsonb, boolean, bigint, text, text) from public;
grant execute on function public.get_my_feature_flags(text[], uuid) to anon, authenticated;
grant execute on function public.feature_enabled(text) to authenticated;
grant execute on function public.operator_list_feature_flags(text) to anon, authenticated;
grant execute on function public.operator_search_feature_users(text, text) to anon, authenticated;
grant execute on function public.operator_publish_feature_flag(text, text, jsonb, boolean, bigint, text, text) to anon, authenticated;

insert into private.feature_flags(key, description)
values
  ('agent.chat', 'JOJO Agent 对话入口和模型请求'),
  ('library.bookshelf', '登录读者的服务端书架'),
  ('olds.workspace', '尚未完成的旧闻工作区'),
  ('rag.workspace', 'RAG 工作区路由与导航'),
  ('reader.annotations', '划线、想法和 AI 解释数据')
on conflict (key) do nothing;

insert into private.feature_flag_rules(id, flag_key, position, name, condition_type, serve, enabled, is_fallback)
values
  ('10000000-0000-4000-8000-000000000001', 'library.bookshelf', 0, '已登录读者', 'authenticated', true, true, false),
  ('10000000-0000-4000-8000-000000000002', 'library.bookshelf', 1, '默认关闭', 'global', false, true, true),
  ('20000000-0000-4000-8000-000000000001', 'reader.annotations', 0, '已登录读者', 'authenticated', true, true, false),
  ('20000000-0000-4000-8000-000000000002', 'reader.annotations', 1, '默认关闭', 'global', false, true, true),
  ('30000000-0000-4000-8000-000000000001', 'agent.chat', 0, '内部测试用户', 'users', true, true, false),
  ('30000000-0000-4000-8000-000000000002', 'agent.chat', 1, '默认关闭', 'global', false, true, true),
  ('40000000-0000-4000-8000-000000000001', 'rag.workspace', 0, '内部测试用户', 'users', true, true, false),
  ('40000000-0000-4000-8000-000000000002', 'rag.workspace', 1, '默认关闭', 'global', false, true, true),
  ('50000000-0000-4000-8000-000000000001', 'olds.workspace', 0, '整体关闭', 'global', false, true, true)
on conflict (id) do nothing;

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
