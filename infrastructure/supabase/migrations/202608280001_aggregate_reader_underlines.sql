-- Aggregate identical reader underlines without exposing individual readers.
-- A reader always sees their own marks. An anchor becomes shared once the
-- configurable distinct-reader threshold is reached or it has a public thought.

create table if not exists private.annotation_settings (
  singleton boolean primary key default true check (singleton),
  public_mark_threshold integer not null default 2 check (public_mark_threshold between 1 and 100),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into private.annotation_settings(singleton, public_mark_threshold)
values (true, 2)
on conflict (singleton) do nothing;

create or replace function private.annotation_public_mark_threshold()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select settings.public_mark_threshold
    from private.annotation_settings settings
    where settings.singleton
  ), 2)
$$;

create table if not exists public.content_annotation_marks (
  annotation_id uuid not null references public.content_annotations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (annotation_id, user_id)
);

create index if not exists content_annotation_marks_user
  on public.content_annotation_marks(user_id, created_at desc);

alter table public.content_annotation_marks enable row level security;
revoke all on table public.content_annotation_marks from public, anon, authenticated;

-- Preserve every existing underline as the original reader's own mark.
insert into public.content_annotation_marks(annotation_id, user_id, created_at)
select annotation.id, annotation.user_id, annotation.created_at
from public.content_annotations annotation
where annotation.user_id is not null
on conflict (annotation_id, user_id) do nothing;

-- An aggregated anchor must survive when its first reader deletes their account.
alter table public.content_annotations
  drop constraint if exists content_annotations_user_id_fkey;
alter table public.content_annotations
  alter column user_id drop not null;
alter table public.content_annotations
  add constraint content_annotations_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

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
      mark_summary.reader_count >= private.annotation_public_mark_threshold()
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
  public_threshold integer := private.annotation_public_mark_threshold();
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

  return private.annotation_snapshot(annotation_id);
end;
$$;

comment on table private.annotation_settings is
  'Private runtime settings for reader annotation aggregation.';
comment on table public.content_annotation_marks is
  'Private per-reader membership for aggregated text underline anchors.';
comment on column private.annotation_settings.public_mark_threshold is
  'Distinct reader count at which an underline is shown to other authenticated readers; a public comment also makes it visible.';
