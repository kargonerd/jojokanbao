create table public.annotation_comment_likes (
  comment_id uuid not null references public.annotation_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index annotation_comment_likes_user on public.annotation_comment_likes(user_id);
alter table public.annotation_comment_likes enable row level security;
-- Readers receive totals and their own state, never the list of liking accounts.
revoke all on public.annotation_comment_likes from public, anon, authenticated;

create function public.set_annotation_comment_like(p_comment_id uuid, p_liked boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  reader_id uuid := private.require_annotation_reader();
begin
  if p_liked is null then
    raise invalid_parameter_value using message = 'Like state is required';
  end if;
  -- Serialize reactions to one comment and block visibility changes while writing.
  perform 1 from public.annotation_comments comment
    join public.content_annotations annotation on annotation.id = comment.annotation_id
    where comment.id = p_comment_id and comment.visibility = 'public'
      and comment.moderation_status = 'visible' and annotation.moderation_status = 'visible'
    for update of comment, annotation;
  if not found then
    raise no_data_found using message = 'Public comment not found';
  end if;
  if p_liked then
    insert into public.annotation_comment_likes(comment_id, user_id) values (p_comment_id, reader_id)
      on conflict do nothing;
  else
    delete from public.annotation_comment_likes where comment_id = p_comment_id and user_id = reader_id;
  end if;
  return (select jsonb_build_object('id', p_comment_id, 'likeCount', count(*),
    'likedByMe', coalesce(bool_or(user_id = reader_id), false))
    from public.annotation_comment_likes where comment_id = p_comment_id);
end;
$$;
revoke all on function public.set_annotation_comment_like(uuid, boolean) from public, anon;
grant execute on function public.set_annotation_comment_like(uuid, boolean) to authenticated;

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
