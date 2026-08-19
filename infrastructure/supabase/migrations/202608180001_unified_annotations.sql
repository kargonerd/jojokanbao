-- Shared reader annotations, discussion threads, reports, and operator moderation.
-- User-facing access is RPC-only so books and periodicals share one contract.

create table if not exists public.content_annotations (
  id uuid primary key default extensions.gen_random_uuid(),
  content_type text not null check (content_type in ('book', 'newspaper', 'magazine', 'article')),
  content_id text not null check (char_length(content_id) between 1 and 512),
  section_id text not null check (char_length(section_id) between 1 and 512),
  content_title text not null check (char_length(content_title) between 1 and 300),
  content_url text check (
    content_url is null or (
      char_length(content_url) <= 1024
      and left(content_url, 1) = '/'
      and left(content_url, 2) <> '//'
      and content_url !~ E'[\\r\\n]'
    )
  ),
  user_id uuid not null references auth.users(id) on delete cascade,
  quote text not null check (char_length(quote) between 1 and 4000 and char_length(btrim(quote)) > 0),
  prefix text not null default '' check (char_length(prefix) <= 160),
  suffix text not null default '' check (char_length(suffix) <= 160),
  start_offset integer,
  end_offset integer,
  anchor_key text not null check (char_length(anchor_key) = 64),
  moderation_status text not null default 'visible' check (moderation_status in ('visible', 'hidden')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    (start_offset is null and end_offset is null)
    or (start_offset is not null and end_offset is not null and start_offset >= 0 and end_offset > start_offset)
  )
);

create table if not exists public.annotation_comments (
  id uuid primary key default extensions.gen_random_uuid(),
  annotation_id uuid not null references public.content_annotations(id) on delete cascade,
  parent_comment_id uuid references public.annotation_comments(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  moderation_status text not null default 'visible' check (moderation_status in ('visible', 'hidden')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.annotation_comment_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  comment_id uuid not null references public.annotation_comments(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('spam', 'abuse', 'harassment', 'misinformation', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default timezone('utc', now()),
  reviewed_at timestamptz,
  unique(comment_id, reporter_id)
);

create table if not exists public.user_notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null check (char_length(btrim(kind)) between 1 and 100),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body text check (body is null or char_length(body) <= 500),
  target_path text check (
    target_path is null or (
      char_length(target_path) <= 1024
      and left(target_path, 1) = '/'
      and left(target_path, 2) <> '//'
      and target_path !~ E'[\\r\\n]'
    )
  ),
  resource_type text check (resource_type is null or char_length(resource_type) <= 100),
  resource_id text check (resource_id is null or char_length(resource_id) <= 512),
  event_key text not null check (char_length(event_key) between 1 and 300),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique(recipient_id, event_key)
);

create table if not exists private.annotation_moderation_events (
  id uuid primary key default extensions.gen_random_uuid(),
  comment_id uuid not null references public.annotation_comments(id) on delete cascade,
  action text not null check (action in ('hide', 'restore', 'dismiss')),
  reason text not null check (char_length(reason) between 2 and 500),
  request_id text check (request_id is null or char_length(request_id) <= 200),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists content_annotations_subject
  on public.content_annotations(content_type, content_id, section_id, created_at);
create unique index if not exists content_annotations_anchor
  on public.content_annotations(content_type, content_id, section_id, anchor_key);
create index if not exists annotation_comments_thread
  on public.annotation_comments(annotation_id, created_at);
create index if not exists annotation_comment_reports_queue
  on public.annotation_comment_reports(status, created_at);
create index if not exists user_notifications_recipient
  on public.user_notifications(recipient_id, created_at desc);
create index if not exists user_notifications_unread
  on public.user_notifications(recipient_id, created_at desc) where read_at is null;

alter table public.content_annotations enable row level security;
alter table public.annotation_comments enable row level security;
alter table public.annotation_comment_reports enable row level security;
alter table public.user_notifications enable row level security;
alter table private.annotation_moderation_events enable row level security;

revoke all on table public.content_annotations from public, anon, authenticated;
revoke all on table public.annotation_comments from public, anon, authenticated;
revoke all on table public.annotation_comment_reports from public, anon, authenticated;
revoke all on table public.user_notifications from public, anon, authenticated;
revoke all on table private.annotation_moderation_events from public, anon, authenticated;

-- Retire the unreleased legacy marks path. Shared RPCs are the only implementation.
revoke all on table public.reader_marks from anon, authenticated;

create or replace function private.require_account_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
begin
  if account_id is null then
    raise insufficient_privilege using message = 'Authentication is required';
  end if;
  return account_id;
end;
$$;

create or replace function private.require_annotation_reader()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_account_user();
begin
  if not public.feature_enabled('reader.annotations') then
    raise insufficient_privilege using message = 'Reader annotations are not enabled';
  end if;
  return reader_id;
end;
$$;

create or replace function private.enqueue_user_notification(
  p_recipient_id uuid,
  p_actor_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_target_path text,
  p_resource_type text,
  p_resource_id text,
  p_event_key text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_id uuid;
begin
  if p_recipient_id is null or p_recipient_id = p_actor_id then
    return null;
  end if;
  if p_target_path is not null and (
    char_length(p_target_path) > 1024
    or left(p_target_path, 1) <> '/'
    or left(p_target_path, 2) = '//'
    or p_target_path ~ E'[\\r\\n]'
  ) then
    raise invalid_parameter_value using message = 'Notification target must be a local path';
  end if;

  insert into public.user_notifications(
    recipient_id, actor_id, kind, title, body, target_path,
    resource_type, resource_id, event_key, payload
  ) values (
    p_recipient_id, p_actor_id, btrim(p_kind), btrim(p_title), left(nullif(btrim(p_body), ''), 500), p_target_path,
    nullif(btrim(p_resource_type), ''), nullif(btrim(p_resource_id), ''), btrim(p_event_key), coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (recipient_id, event_key) do nothing
  returning id into notification_id;
  return notification_id;
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
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', comment.id,
        'annotationId', comment.annotation_id,
        'parentCommentId', comment.parent_comment_id,
        'authorId', comment.user_id,
        'authorName', coalesce(comment_profile.display_name, 'JOJO 读者'),
        'body', comment.body,
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
    ), '[]'::jsonb)
  )
  from public.content_annotations annotation
  left join public.profiles profile on profile.id = annotation.user_id
  where annotation.id = p_annotation_id
    and annotation.moderation_status = 'visible'
$$;

create or replace function public.get_my_notifications(
  p_limit integer default 50,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_id uuid := private.require_account_user();
begin
  if p_limit not between 1 and 100 then
    raise invalid_parameter_value using message = 'Notification limit must be between 1 and 100';
  end if;
  return coalesce((
    select jsonb_agg(entry.payload order by entry.created_at desc)
    from (
      select notification.created_at, jsonb_build_object(
        'id', notification.id,
        'kind', notification.kind,
        'title', notification.title,
        'body', notification.body,
        'targetPath', notification.target_path,
        'resourceType', notification.resource_type,
        'resourceId', notification.resource_id,
        'payload', notification.payload,
        'actorId', notification.actor_id,
        'actorName', profile.display_name,
        'readAt', notification.read_at,
        'createdAt', notification.created_at
      ) as payload
      from public.user_notifications notification
      left join public.profiles profile on profile.id = notification.actor_id
      where notification.recipient_id = account_id
        and (p_before is null or notification.created_at < p_before)
      order by notification.created_at desc
      limit p_limit
    ) entry
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_my_unread_notification_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_id uuid := private.require_account_user();
begin
  return (
    select count(*)::integer
    from public.user_notifications notification
    where notification.recipient_id = account_id and notification.read_at is null
  );
end;
$$;

create or replace function public.mark_my_notification_read(p_notification_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := private.require_account_user();
  changed_count integer;
begin
  update public.user_notifications
  set read_at = timezone('utc', now())
  where recipient_id = account_id
    and read_at is null
    and (p_notification_id is null or id = p_notification_id);
  get diagnostics changed_count = row_count;
  return changed_count;
end;
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
begin
  perform private.require_annotation_reader();
  return coalesce((
    select jsonb_agg(private.annotation_snapshot(annotation.id) order by annotation.created_at)
    from public.content_annotations annotation
    where annotation.content_type = p_content_type
      and annotation.content_id = p_content_id
      and annotation.section_id = p_section_id
      and annotation.moderation_status = 'visible'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.create_content_annotation(
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
  p_initial_comment text default null
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
  normalized_prefix text := left(coalesce(p_prefix, ''), 160);
  normalized_suffix text := left(coalesce(p_suffix, ''), 160);
  normalized_path text := nullif(btrim(coalesce(p_content_url, '')), '');
  computed_anchor_key text;
begin
  if p_quote is null or char_length(p_quote) > 4000 or char_length(btrim(p_quote)) = 0 then
    raise invalid_parameter_value using message = 'Annotation quote is invalid';
  end if;
  if normalized_path is not null and (
    char_length(normalized_path) > 1024
    or left(normalized_path, 1) <> '/'
    or left(normalized_path, 2) = '//'
    or normalized_path ~ E'[\\r\\n]'
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
    updated_at = timezone('utc', now())
  returning id into annotation_id;

  if normalized_comment is not null then
    insert into public.annotation_comments(annotation_id, user_id, body)
    values (annotation_id, reader_id, normalized_comment);
  end if;
  return private.annotation_snapshot(annotation_id);
end;
$$;

create or replace function public.add_annotation_comment(
  p_annotation_id uuid,
  p_body text,
  p_parent_comment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
  comment_id uuid;
  recipient_id uuid;
  notification_kind text;
  notification_title text;
  notification_target_path text;
  annotation_context record;
begin
  if not exists (
    select 1 from public.content_annotations annotation
    where annotation.id = p_annotation_id and annotation.moderation_status = 'visible'
  ) then
    raise no_data_found using message = 'Annotation not found';
  end if;
  if p_parent_comment_id is not null and not exists (
    select 1 from public.annotation_comments parent
    where parent.id = p_parent_comment_id
      and parent.annotation_id = p_annotation_id
      and parent.moderation_status = 'visible'
  ) then
    raise invalid_parameter_value using message = 'Parent comment does not belong to this annotation';
  end if;

  insert into public.annotation_comments(annotation_id, parent_comment_id, user_id, body)
  values (p_annotation_id, p_parent_comment_id, reader_id, btrim(p_body))
  returning id into comment_id;

  select
    annotation.user_id,
    annotation.content_type,
    annotation.content_title,
    annotation.content_url,
    annotation.quote,
    annotation.section_id
  into annotation_context
  from public.content_annotations annotation
  where annotation.id = p_annotation_id;

  if p_parent_comment_id is not null then
    select parent.user_id into recipient_id
    from public.annotation_comments parent
    where parent.id = p_parent_comment_id;
    notification_kind := 'annotation.reply';
    notification_title := '回复了你的评论';
  else
    recipient_id := annotation_context.user_id;
    notification_kind := 'annotation.comment';
    notification_title := '评论了你的划线';
  end if;

  if annotation_context.content_url is not null then
    notification_target_path := annotation_context.content_url
      || case when strpos(annotation_context.content_url, '?') > 0 then '&' else '?' end
      || 'discussion=' || p_annotation_id::text;
    if char_length(notification_target_path) > 1024 then
      notification_target_path := annotation_context.content_url;
    end if;
  end if;

  perform private.enqueue_user_notification(
    recipient_id,
    reader_id,
    notification_kind,
    notification_title,
    btrim(p_body),
    notification_target_path,
    'annotation_comment',
    comment_id::text,
    'annotation-comment:' || comment_id::text,
    jsonb_build_object(
      'annotationId', p_annotation_id,
      'commentId', comment_id,
      'parentCommentId', p_parent_comment_id,
      'contentType', annotation_context.content_type,
      'contentTitle', annotation_context.content_title,
      'sectionId', annotation_context.section_id,
      'quote', annotation_context.quote
    )
  );

  return (
    select jsonb_build_object(
      'id', comment.id,
      'annotationId', comment.annotation_id,
      'parentCommentId', comment.parent_comment_id,
      'authorId', comment.user_id,
      'authorName', coalesce(profile.display_name, 'JOJO 读者'),
      'body', comment.body,
      'createdAt', comment.created_at,
      'reportedByMe', false
    )
    from public.annotation_comments comment
    left join public.profiles profile on profile.id = comment.user_id
    where comment.id = comment_id
  );
end;
$$;

create or replace function public.report_annotation_comment(
  p_comment_id uuid,
  p_reason text,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
  report_id uuid;
begin
  if not exists (
    select 1
    from public.annotation_comments comment
    join public.content_annotations annotation on annotation.id = comment.annotation_id
    where comment.id = p_comment_id
      and comment.moderation_status = 'visible'
      and annotation.moderation_status = 'visible'
  ) then
    raise no_data_found using message = 'Comment not found';
  end if;

  insert into public.annotation_comment_reports(comment_id, reporter_id, reason, details)
  values (p_comment_id, reader_id, p_reason, nullif(btrim(p_details), ''))
  on conflict (comment_id, reporter_id) do update set
    reason = excluded.reason,
    details = excluded.details,
    status = 'pending',
    created_at = timezone('utc', now()),
    reviewed_at = null
  returning id into report_id;

  return jsonb_build_object('id', report_id, 'commentId', p_comment_id, 'status', 'pending');
end;
$$;

create or replace function public.operator_list_annotation_reports(
  p_operator_token text,
  p_status text default 'pending'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_status not in ('pending', 'resolved', 'dismissed', 'all') then
    raise invalid_parameter_value using message = 'Unknown report status';
  end if;
  return coalesce((
    select jsonb_agg(entry.payload order by entry.oldest_report_at)
    from (
      select min(report.created_at) as oldest_report_at, jsonb_build_object(
        'commentId', comment.id,
        'annotationId', annotation.id,
        'commentBody', comment.body,
        'commentStatus', comment.moderation_status,
        'commentAuthorName', coalesce(comment_profile.display_name, 'JOJO 读者'),
        'commentCreatedAt', comment.created_at,
        'quote', annotation.quote,
        'contentType', annotation.content_type,
        'contentId', annotation.content_id,
        'sectionId', annotation.section_id,
        'contentTitle', annotation.content_title,
        'contentUrl', annotation.content_url,
        'reportCount', count(report.id),
        'reports', jsonb_agg(jsonb_build_object(
          'id', report.id,
          'reason', report.reason,
          'details', report.details,
          'status', report.status,
          'reporterName', coalesce(reporter_profile.display_name, 'JOJO 读者'),
          'createdAt', report.created_at
        ) order by report.created_at)
      ) as payload
      from public.annotation_comment_reports report
      join public.annotation_comments comment on comment.id = report.comment_id
      join public.content_annotations annotation on annotation.id = comment.annotation_id
      left join public.profiles comment_profile on comment_profile.id = comment.user_id
      left join public.profiles reporter_profile on reporter_profile.id = report.reporter_id
      where p_status = 'all' or report.status = p_status
      group by comment.id, annotation.id, comment_profile.display_name
    ) entry
  ), '[]'::jsonb);
end;
$$;

create or replace function public.operator_moderate_annotation_comment(
  p_operator_token text,
  p_comment_id uuid,
  p_action text,
  p_reason text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_action not in ('hide', 'restore', 'dismiss') then
    raise invalid_parameter_value using message = 'Unknown moderation action';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 500 then
    raise invalid_parameter_value using message = 'Moderation reason is required';
  end if;
  if not exists (select 1 from public.annotation_comments where id = p_comment_id) then
    raise no_data_found using message = 'Comment not found';
  end if;

  if p_action = 'hide' then
    update public.annotation_comments set moderation_status = 'hidden', updated_at = timezone('utc', now()) where id = p_comment_id;
    update public.annotation_comment_reports set status = 'resolved', reviewed_at = timezone('utc', now()) where comment_id = p_comment_id and status = 'pending';
  elsif p_action = 'restore' then
    update public.annotation_comments set moderation_status = 'visible', updated_at = timezone('utc', now()) where id = p_comment_id;
    update public.annotation_comment_reports set status = 'dismissed', reviewed_at = timezone('utc', now()) where comment_id = p_comment_id and status in ('pending', 'resolved');
  else
    update public.annotation_comment_reports set status = 'dismissed', reviewed_at = timezone('utc', now()) where comment_id = p_comment_id and status = 'pending';
  end if;

  insert into private.annotation_moderation_events(comment_id, action, reason, request_id)
  values (p_comment_id, p_action, btrim(p_reason), nullif(btrim(p_request_id), ''));
  return jsonb_build_object('commentId', p_comment_id, 'action', p_action, 'success', true);
end;
$$;

revoke all on function private.require_account_user() from public, anon, authenticated;
revoke all on function private.require_annotation_reader() from public, anon, authenticated;
revoke all on function private.enqueue_user_notification(uuid, uuid, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.annotation_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.get_my_notifications(integer, timestamptz) from public, anon;
revoke all on function public.get_my_unread_notification_count() from public, anon;
revoke all on function public.mark_my_notification_read(uuid) from public, anon;
revoke all on function public.get_annotation_threads(text, text, text) from public, anon;
revoke all on function public.create_content_annotation(text, text, text, text, text, text, text, text, integer, integer, text) from public, anon;
revoke all on function public.add_annotation_comment(uuid, text, uuid) from public, anon;
revoke all on function public.report_annotation_comment(uuid, text, text) from public, anon;
revoke all on function public.operator_list_annotation_reports(text, text) from public;
revoke all on function public.operator_moderate_annotation_comment(text, uuid, text, text, text) from public;

grant execute on function public.get_my_notifications(integer, timestamptz) to authenticated;
grant execute on function public.get_my_unread_notification_count() to authenticated;
grant execute on function public.mark_my_notification_read(uuid) to authenticated;
grant execute on function public.get_annotation_threads(text, text, text) to authenticated;
grant execute on function public.create_content_annotation(text, text, text, text, text, text, text, text, integer, integer, text) to authenticated;
grant execute on function public.add_annotation_comment(uuid, text, uuid) to authenticated;
grant execute on function public.report_annotation_comment(uuid, text, text) to authenticated;
grant execute on function public.operator_list_annotation_reports(text, text) to anon, authenticated;
grant execute on function public.operator_moderate_annotation_comment(text, uuid, text, text, text) to anon, authenticated;

comment on table public.content_annotations is 'Shared text annotations for books, newspapers, magazines, and articles.';
comment on table public.annotation_comments is 'Authenticated reader discussion attached to a text annotation.';
comment on table public.annotation_comment_reports is 'Reader reports reviewed through JOJO Workbench.';
comment on table public.user_notifications is 'Generic in-app notifications owned by an authenticated recipient.';
