-- PostHog supplies policy parameters to trusted application servers. PostgreSQL
-- retains ownership checks and atomic business state, with no flag/config store.
alter table private.feature_flag_operator_secret rename to operator_credentials;
alter function private.feature_flag_operator_authorized(text) rename to operator_authorized;
alter function private.require_feature_flag_operator(text) rename to require_operator;

-- Preserve the existing operator credential used by moderation, AI and maintenance.
do $$
declare routine record; definition text;
begin
  for routine in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private', 'public') and p.prokind = 'f'
      and (p.prosrc like '%feature_flag_operator%' or p.prosrc like '%Feature flag operator%')
  loop
    definition := pg_get_functiondef(routine.oid);
    definition := replace(definition, 'private.feature_flag_operator_secret', 'private.operator_credentials');
    definition := replace(definition, 'private.feature_flag_operator_authorized', 'private.operator_authorized');
    definition := replace(definition, 'private.require_feature_flag_operator', 'private.require_operator');
    definition := replace(definition, 'Feature flag operator token is invalid', 'Operator token is invalid');
    execute definition;
  end loop;
end;
$$;

alter policy reader_bookshelf_own on public.reader_bookshelf
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function private.require_annotation_reader()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare reader_id uuid := auth.uid();
begin
  if reader_id is null then raise insufficient_privilege using message = 'Authentication is required'; end if;
  return reader_id;
end;
$$;

-- Registration carries a short-lived, email/code-bound authorization issued by
-- the API. Clients cannot supply invitationRequired or forge an open-signup claim.
create function private.signup_authorization_required(p_email text, p_metadata jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  receipt text := p_metadata->>'signup_authorization';
  encoded text; signature text; signing_key bytea; payload jsonb;
  seconds bigint := extract(epoch from now())::bigint;
begin
  if receipt is null or char_length(receipt) > 2048 then raise exception 'Invalid signup authorization'; end if;
  encoded := split_part(receipt, '.', 1);
  signature := split_part(receipt, '.', 2);
  if receipt <> encoded || '.' || signature or signature !~ '^[a-f0-9]{64}$' then raise exception 'Invalid signup authorization'; end if;
  select token_digest into signing_key from private.operator_credentials where singleton;
  if signing_key is null or decode(signature, 'hex') <> extensions.hmac(convert_to('jojo.signup.v1.' || encoded, 'UTF8'), signing_key, 'sha256') then
    raise exception 'Invalid signup authorization';
  end if;
  payload := convert_from(decode(translate(encoded, '-_', '+/') || repeat('=', (4 - length(encoded) % 4) % 4), 'base64'), 'UTF8')::jsonb;
  if jsonb_typeof(payload->'required') is distinct from 'boolean'
    or jsonb_typeof(payload->'expires') is distinct from 'number'
    or payload->>'email' is distinct from lower(btrim(p_email))
    or payload->>'code' is distinct from private.normalize_signup_invitation_code(p_metadata->>'invitation_code')
    or (payload->>'expires')::bigint < seconds or (payload->>'expires')::bigint > seconds + 120
  then raise exception 'Invalid signup authorization'; end if;
  return (payload->>'required')::boolean;
exception when others then
  raise exception using errcode = '42501', message = 'Registration authorization is invalid or expired. Please retry signup.';
end;
$$;
revoke all on function private.signup_authorization_required(text, jsonb) from public, anon, authenticated;
grant execute on function private.signup_authorization_required(text, jsonb) to supabase_auth_admin;


create or replace function public.hook_require_signup_invitation(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  normalized_code text;
  signup_email text;
  invitation_exists boolean;
begin
  if not private.signup_authorization_required(event #>> '{user,email}', event #> '{user,user_metadata}') then
    return '{}'::jsonb;
  end if;

  normalized_code := private.normalize_signup_invitation_code(
    event #>> '{user,user_metadata,invitation_code}'
  );
  signup_email := lower(trim(coalesce(event #>> '{user,email}', '')));

  if char_length(normalized_code) <> 6 or signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invitation code is required or invalid.'
      )
    );
  end if;

  select exists (
    select 1
    from private.signup_invitations
    where code = normalized_code
      and disabled_at is null
      and (expires_at is null or expires_at > now())
      and use_count < max_uses
      and (email is null or lower(trim(email)) = signup_email)
  ) into invitation_exists;

  if not invitation_exists then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invitation code is invalid or unavailable.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

create or replace function private.redeem_signup_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text;
  signup_email text;
  redeemed_invitation_id uuid;
begin
  if not private.signup_authorization_required(new.email, new.raw_user_meta_data) then
    -- Open registration consumes no invitation allocation.
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invitation_code' - 'signup_authorization';
    return new;
  end if;

  normalized_code := private.normalize_signup_invitation_code(
    new.raw_user_meta_data ->> 'invitation_code'
  );
  signup_email := lower(trim(coalesce(new.email, '')));

  update private.signup_invitations
  set use_count = use_count + 1,
      updated_at = now()
  where code = normalized_code
    and disabled_at is null
    and (expires_at is null or expires_at > now())
    and use_count < max_uses
    and (email is null or lower(trim(email)) = signup_email)
  returning id into redeemed_invitation_id;

  if redeemed_invitation_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'Invitation code could not be redeemed.';
  end if;

  insert into private.signup_invitation_redemptions (
    invitation_id,
    user_id,
    email
  ) values (
    redeemed_invitation_id,
    new.id,
    signup_email
  );

  new.raw_user_meta_data :=
    coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invitation_code' - 'signup_authorization';
  return new;
end;
$$;

create or replace function private.annotation_snapshot(p_annotation_id uuid, p_public_mark_threshold integer)
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
      mark_summary.reader_count >= p_public_mark_threshold
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
        'likeCount', likes.like_count,
        'likedByMe', likes.liked_by_me,
        'reportedByMe', exists (
          select 1 from public.annotation_comment_reports report
          where report.comment_id = comment.id and report.reporter_id = auth.uid()
        )
      ) order by likes.like_count desc, comment.created_at, comment.id)
      from public.annotation_comments comment
      left join public.profiles comment_profile on comment_profile.id = comment.user_id
      cross join lateral (
        select count(*) as like_count, coalesce(bool_or(reaction.user_id = auth.uid()), false) as liked_by_me
        from public.annotation_comment_likes reaction
        where reaction.comment_id = comment.id and comment.visibility = 'public'
      ) likes
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

create or replace function private.get_annotation_threads(p_public_mark_threshold integer, 
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
  public_threshold integer := p_public_mark_threshold;
begin
  return coalesce((
    select jsonb_agg(private.annotation_snapshot(annotation.id, p_public_mark_threshold) order by annotation.created_at)
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

create or replace function private.create_content_annotation(p_public_mark_threshold integer, 
  p_content_type text,
  p_content_id text,
  p_section_id text,
  p_content_title text,
  p_content_url text,
  p_quote text,
  p_prefix text default '',
  p_suffix text default '',
  p_start_offset integer default null,
  p_end_offset integer default null,
  p_initial_comment text default null,
  p_initial_comment_visibility text default 'public'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
  annotation_id uuid;
  normalized_comment text := nullif(btrim(coalesce(p_initial_comment, '')), '');
  normalized_visibility text := lower(btrim(coalesce(p_initial_comment_visibility, 'public')));
  normalized_prefix text := left(coalesce(p_prefix, ''), 160);
  normalized_suffix text := left(coalesce(p_suffix, ''), 160);
  normalized_path text := nullif(btrim(coalesce(p_content_url, '')), '');
  computed_anchor_key text;
begin
  if normalized_visibility not in ('public', 'private') then
    raise invalid_parameter_value using message = 'Comment visibility is invalid';
  end if;
  if p_quote is null or char_length(p_quote) > 4000 or char_length(btrim(p_quote)) = 0 then
    raise invalid_parameter_value using message = 'Annotation quote is invalid';
  end if;
  if normalized_path is not null and (
    char_length(normalized_path) > 1024
    or left(normalized_path, 1) <> '/'
    or left(normalized_path, 2) = '//'
    or strpos(normalized_path, E'\\') > 0
    or normalized_path ~ E'[\r\n]'
  ) then
    raise invalid_parameter_value using message = 'Annotation target must be a local path';
  end if;

  computed_anchor_key := encode(extensions.digest(
    jsonb_build_array(p_quote, normalized_prefix, normalized_suffix, p_start_offset, p_end_offset)::text,
    'sha256'
  ), 'hex');

  insert into public.content_annotations as existing(
    content_type, content_id, section_id, content_title, content_url,
    user_id, quote, prefix, suffix, start_offset, end_offset, anchor_key
  ) values (
    p_content_type, btrim(p_content_id), btrim(p_section_id), left(btrim(p_content_title), 300), normalized_path,
    reader_id, p_quote, normalized_prefix, normalized_suffix,
    p_start_offset, p_end_offset, computed_anchor_key
  )
  on conflict (content_type, content_id, section_id, anchor_key) do update set
    content_title = excluded.content_title,
    content_url = coalesce(excluded.content_url, existing.content_url),
    user_id = coalesce(existing.user_id, excluded.user_id),
    updated_at = timezone('utc', now())
  returning id into annotation_id;

  insert into public.content_annotation_marks(annotation_id, user_id)
  values (annotation_id, reader_id)
  on conflict on constraint content_annotation_marks_pkey do nothing;

  if normalized_comment is not null then
    insert into public.annotation_comments(annotation_id, user_id, body, visibility)
    values (annotation_id, reader_id, normalized_comment, normalized_visibility);
  end if;

  return private.annotation_snapshot(annotation_id, p_public_mark_threshold);
end;
$$;

create function private.delete_my_annotation_mark(p_public_mark_threshold integer, p_annotation_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  reader_id uuid := private.require_annotation_reader();
  snapshot jsonb;
begin
  -- Use the same anchor lock as create_content_annotation so create/delete
  -- requests for this anchor have a consistent order.
  perform 1 from public.content_annotations where id = p_annotation_id for update;
  delete from public.content_annotation_marks
    where annotation_id = p_annotation_id and user_id = reader_id;

  snapshot := private.annotation_snapshot(p_annotation_id, p_public_mark_threshold);
  -- After removal the anchor may fall below the sharing threshold. Return the
  -- resulting reader-visible state, including zero marks with public thoughts.
  return jsonb_build_object('thread', case
    when (snapshot->>'publiclyVisible')::boolean then snapshot
    else null end);
end;
$$;

create or replace function public.acquire_agent_usage(
  p_operator_token text,
  p_user_id uuid,
  p_request_id uuid,
  p_requests_per_minute integer,
  p_requests_per_day integer,
  p_max_run_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_minute integer;
  per_day integer;
  max_run_seconds integer;
  usage private.agent_usage_state%rowtype;
  v_now timestamptz;
  v_day date;
  retry_seconds integer;
begin
  perform private.require_operator(p_operator_token);
  if p_user_id is null or p_request_id is null then
    raise exception 'User and request identifiers are required' using errcode = '22023';
  end if;
  if p_requests_per_minute is null or p_requests_per_minute not between 1 and 60
    or p_requests_per_day is null or p_requests_per_day not between 1 and 10000
    or p_max_run_seconds is null or p_max_run_seconds not between 30 and 600
  then raise invalid_parameter_value using message = 'AI usage parameters are invalid'; end if;
  per_minute := p_requests_per_minute;
  per_day := p_requests_per_day;
  max_run_seconds := p_max_run_seconds;
  insert into private.agent_usage_state(user_id, usage_day)
    values (p_user_id, (pg_catalog.clock_timestamp() at time zone 'Asia/Shanghai')::date)
    on conflict (user_id) do nothing;
  select * into strict usage from private.agent_usage_state
    where user_id = p_user_id for update;
  v_now := pg_catalog.clock_timestamp();
  v_day := (v_now at time zone 'Asia/Shanghai')::date;

  if usage.active_until > v_now then
    return jsonb_build_object('allowed', false, 'reason', 'concurrent',
      'retryAfter', greatest(1, ceil(extract(epoch from usage.active_until - v_now))::integer));
  end if;
  if usage.usage_day <> v_day then
    usage.day_count := 0;
  end if;
  if usage.day_count >= per_day then
    retry_seconds := ceil(extract(epoch from
      ((v_day + 1)::timestamp at time zone 'Asia/Shanghai') - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'daily',
      'retryAfter', greatest(1, retry_seconds), 'limit', per_day);
  end if;
  select coalesce(array_agg(request_time order by request_time), '{}'::timestamptz[])
    into usage.recent_requests from unnest(usage.recent_requests) as request_time
    where request_time > v_now - interval '1 minute';
  if cardinality(usage.recent_requests) >= per_minute then
    retry_seconds := ceil(extract(epoch from usage.recent_requests[1] + interval '1 minute' - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'minute',
      'retryAfter', greatest(1, retry_seconds), 'limit', per_minute);
  end if;

  update private.agent_usage_state set
    usage_day = v_day,
    day_count = usage.day_count + 1,
    recent_requests = array_append(usage.recent_requests, v_now),
    active_request_id = p_request_id,
    -- The Agent aborts at max_run_seconds; this grace period covers cancellation
    -- and cleanup. A crashed instance cannot leave an account locked forever.
    active_until = v_now + make_interval(secs => max_run_seconds + 30)
    where user_id = p_user_id;
  return jsonb_build_object('allowed', true, 'maxRunSeconds', max_run_seconds);
end;
$$;

create function public.annotation_request(
  p_operator_token text, p_public_mark_threshold integer, p_operation text, p_params jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_operator(p_operator_token);
  perform private.require_annotation_reader();
  if p_public_mark_threshold is null or p_public_mark_threshold not between 1 and 100
    or jsonb_typeof(p_params) is distinct from 'object' or octet_length(p_params::text) > 32768
  then raise invalid_parameter_value using message = 'Annotation request is invalid'; end if;
  case p_operation
    when 'get_annotation_threads' then
      return private.get_annotation_threads(p_public_mark_threshold,
        p_params->>'p_content_type', p_params->>'p_content_id', p_params->>'p_section_id');
    when 'create_content_annotation' then
      return private.create_content_annotation(p_public_mark_threshold,
        p_params->>'p_content_type', p_params->>'p_content_id', p_params->>'p_section_id',
        p_params->>'p_content_title', p_params->>'p_content_url', p_params->>'p_quote',
        coalesce(p_params->>'p_prefix', ''), coalesce(p_params->>'p_suffix', ''),
        (p_params->>'p_start_offset')::integer, (p_params->>'p_end_offset')::integer,
        p_params->>'p_initial_comment', coalesce(p_params->>'p_initial_comment_visibility', 'public'));
    when 'delete_my_annotation_mark' then
      return private.delete_my_annotation_mark(p_public_mark_threshold, (p_params->>'p_annotation_id')::uuid);
    when 'add_annotation_comment' then
      return public.add_annotation_comment((p_params->>'p_annotation_id')::uuid, p_params->>'p_body',
        (p_params->>'p_parent_comment_id')::uuid, coalesce(p_params->>'p_visibility', 'public'));
    when 'report_annotation_comment' then
      return public.report_annotation_comment((p_params->>'p_comment_id')::uuid, p_params->>'p_reason', p_params->>'p_details');
    when 'set_annotation_comment_like' then
      return public.set_annotation_comment_like((p_params->>'p_comment_id')::uuid, (p_params->>'p_liked')::boolean);
    else raise invalid_parameter_value using message = 'Unknown annotation operation';
  end case;
end;
$$;
revoke all on function public.annotation_request(text, integer, text, jsonb) from public, anon;
grant execute on function public.annotation_request(text, integer, text, jsonb) to authenticated;
revoke all on function private.annotation_snapshot(uuid, integer) from public, anon, authenticated;
revoke all on function private.get_annotation_threads(integer, text, text, text) from public, anon, authenticated;
revoke all on function private.create_content_annotation(integer, text, text, text, text, text, text, text, text, integer, integer, text, text) from public, anon, authenticated;
revoke all on function private.delete_my_annotation_mark(integer, uuid) from public, anon, authenticated;
revoke all on function public.add_annotation_comment(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.report_annotation_comment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_annotation_comment_like(uuid, boolean) from public, anon, authenticated;
revoke all on function public.acquire_agent_usage(text, uuid, uuid, integer, integer, integer) from public;
grant execute on function public.acquire_agent_usage(text, uuid, uuid, integer, integer, integer) to anon, authenticated;

drop function public.get_annotation_threads(text, text, text);
drop function public.create_content_annotation(text, text, text, text, text, text, text, text, integer, integer, text, text);
drop function public.delete_my_annotation_mark(uuid);
drop function private.annotation_snapshot(uuid);
drop function public.acquire_agent_usage(text, uuid, uuid);
drop function public.signup_invitation_required();
drop function public.get_email_quota_monitor_config();
drop function public.get_my_feature_flags(text[], uuid);
drop function public.feature_enabled(text);
drop function public.operator_list_feature_flags(text);
drop function public.operator_get_feature_flag(text, text);
drop function public.operator_search_feature_users(text, text);
drop function public.operator_publish_feature_flag(text, text, jsonb, jsonb, bigint, text, text);
drop function public.operator_rollback_feature_flag(text, text, bigint, bigint, text);
drop function private.feature_flag_evaluate(text, uuid, uuid);
drop function private.feature_flag_snapshot(text);
drop function private.feature_flag_normalize_rules(jsonb);
drop function private.feature_flag_normalize_config(jsonb);
drop function private.feature_flag_config_integer(text, text[], integer, integer, integer);
drop table private.feature_flags;
drop function private.validate_agent_usage_feature_config();
drop function private.validate_signup_feature_config();
drop function private.validate_email_quota_monitor_config();
