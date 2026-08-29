alter table public.annotation_comments
  add column if not exists visibility text not null default 'public'
  check (visibility in ('public', 'private'));

comment on column public.annotation_comments.visibility is
  'Public comments are visible to authenticated readers; private comments are visible only to their author.';

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
  where annotation.id = p_annotation_id
    and annotation.moderation_status = 'visible'
$$;

drop function if exists public.create_content_annotation(
  text, text, text, text, text, text, text, text, integer, integer, text
);

create function public.create_content_annotation(
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
    updated_at = timezone('utc', now())
  returning id into annotation_id;

  if normalized_comment is not null then
    insert into public.annotation_comments(annotation_id, user_id, body, visibility)
    values (annotation_id, reader_id, normalized_comment, normalized_visibility);
  end if;
  return private.annotation_snapshot(annotation_id);
end;
$$;

drop function if exists public.add_annotation_comment(uuid, text, uuid);

create function public.add_annotation_comment(
  p_annotation_id uuid,
  p_body text,
  p_parent_comment_id uuid default null,
  p_visibility text default 'public'
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
  normalized_visibility text := lower(btrim(coalesce(p_visibility, 'public')));
  annotation_context record;
begin
  if normalized_visibility not in ('public', 'private') then
    raise invalid_parameter_value using message = 'Comment visibility is invalid';
  end if;
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
      and (parent.visibility = 'public' or parent.user_id = reader_id)
      and (normalized_visibility = 'private' or parent.visibility = 'public')
  ) then
    raise invalid_parameter_value using message = 'Parent comment does not belong to this annotation';
  end if;

  insert into public.annotation_comments(annotation_id, parent_comment_id, user_id, body, visibility)
  values (p_annotation_id, p_parent_comment_id, reader_id, btrim(p_body), normalized_visibility)
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

  if normalized_visibility = 'public' then
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
  end if;

  return (
    select jsonb_build_object(
      'id', comment.id,
      'annotationId', comment.annotation_id,
      'parentCommentId', comment.parent_comment_id,
      'authorId', comment.user_id,
      'authorName', coalesce(profile.display_name, 'JOJO 读者'),
      'body', comment.body,
      'visibility', comment.visibility,
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
  comment_author_id uuid;
begin
  select comment.user_id
  into comment_author_id
    from public.annotation_comments comment
    join public.content_annotations annotation on annotation.id = comment.annotation_id
    where comment.id = p_comment_id
      and comment.visibility = 'public'
      and comment.moderation_status = 'visible'
      and annotation.moderation_status = 'visible';
  if not found then
    raise no_data_found using message = 'Comment not found';
  end if;
  if comment_author_id = reader_id then
    raise invalid_parameter_value using message = 'You cannot report your own comment';
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

revoke all on function public.create_content_annotation(
  text, text, text, text, text, text, text, text, integer, integer, text, text
) from public, anon;
revoke all on function public.add_annotation_comment(uuid, text, uuid, text) from public, anon;

grant execute on function public.create_content_annotation(
  text, text, text, text, text, text, text, text, integer, integer, text, text
) to authenticated;
grant execute on function public.add_annotation_comment(uuid, text, uuid, text) to authenticated;
