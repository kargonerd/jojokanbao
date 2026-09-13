-- Whole-book keyset reads and reader-first membership lookups.
create index if not exists content_annotations_visible_book_page
  on public.content_annotations(content_id, id)
  where content_type = 'book' and moderation_status = 'visible';
create index if not exists content_annotation_marks_reader_anchor
  on public.content_annotation_marks(user_id, annotation_id);
create index if not exists annotation_comments_reader_visible_anchor
  on public.annotation_comments(user_id, annotation_id)
  where moderation_status = 'visible';
create index if not exists annotation_comments_public_visible_anchor
  on public.annotation_comments(annotation_id)
  where visibility = 'public' and moderation_status = 'visible';

-- Read a reader's book notes in bounded pages instead of requesting every chapter.
create or replace function public.get_my_book_annotations(
  p_content_id text,
  p_after_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise invalid_parameter_value using message = 'Book annotation limit must be between 1 and 100';
  end if;

  return (
    with mine as (
      select own_mark.annotation_id
      from public.content_annotation_marks own_mark
      where own_mark.user_id = reader_id
        and (p_after_id is null or own_mark.annotation_id > p_after_id)
      union
      select own_comment.annotation_id
      from public.annotation_comments own_comment
      where own_comment.user_id = reader_id and own_comment.moderation_status = 'visible'
        and (p_after_id is null or own_comment.annotation_id > p_after_id)
    ), page as materialized (
      select annotation.id
      from mine join public.content_annotations annotation on annotation.id = mine.annotation_id
      where annotation.content_type = 'book'
        and annotation.content_id = p_content_id
        and annotation.moderation_status = 'visible'
        and (p_after_id is null or annotation.id > p_after_id)
      order by annotation.id
      limit p_limit
    ), snapshots as materialized (
      -- Keep the shared snapshot contract, including reactions and underline totals.
      -- Evaluate it once per selected thread, after applying the page limit.
      select page.id, private.annotation_snapshot(page.id) as snapshot
      from page
    )
    select coalesce(jsonb_agg(
      snapshots.snapshot || jsonb_build_object('comments', coalesce((
        select jsonb_agg(comment.value order by comment.position)
        from jsonb_array_elements(snapshots.snapshot->'comments')
          with ordinality as comment(value, position)
        where comment.value->>'authorId' = reader_id::text
      ), '[]'::jsonb))
      order by snapshots.id
    ), '[]'::jsonb)
    from snapshots
  );
end;
$$;

revoke all on function public.get_my_book_annotations(text, uuid, integer) from public, anon;
grant execute on function public.get_my_book_annotations(text, uuid, integer) to authenticated;

-- Public view reuses the existing sharing threshold; even the caller's private thoughts are excluded.
create function public.get_public_book_annotations(
  p_content_id text,
  p_after_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_annotation_reader();
  public_threshold integer := private.feature_flag_config_integer('reader.annotations', array['publicMarkThreshold'], 2, 1, 100);
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise invalid_parameter_value using message = 'Book annotation limit must be between 1 and 100';
  end if;

  return (
    with page as materialized (
      select annotation.id
      from public.content_annotations annotation
      where annotation.content_type = 'book'
        and annotation.content_id = p_content_id
        and annotation.moderation_status = 'visible'
        and (p_after_id is null or annotation.id > p_after_id)
        and (
          exists (
            select 1 from public.annotation_comments public_comment
            where public_comment.annotation_id = annotation.id
              and public_comment.visibility = 'public'
              and public_comment.moderation_status = 'visible'
          )
          or public_threshold <= (
            select count(*) from (
              select 1 from public.content_annotation_marks shared_mark
              where shared_mark.annotation_id = annotation.id
              limit public_threshold
            ) readers
          )
        )
      order by annotation.id
      limit p_limit
    ), snapshots as materialized (
      -- Keep the shared snapshot contract, including reactions and underline totals.
      -- Evaluate it once per selected thread, after applying the page limit.
      select page.id, private.annotation_snapshot(page.id) as snapshot
      from page
    )
    select coalesce(jsonb_agg(
      snapshots.snapshot || jsonb_build_object('comments', coalesce((
        select jsonb_agg(comment.value order by comment.position)
        from jsonb_array_elements(snapshots.snapshot->'comments')
          with ordinality as comment(value, position)
        where comment.value->>'visibility' = 'public'
      ), '[]'::jsonb))
      order by snapshots.id
    ), '[]'::jsonb)
    from snapshots
  );
end;
$$;

revoke all on function public.get_public_book_annotations(text, uuid, integer) from public, anon;
grant execute on function public.get_public_book_annotations(text, uuid, integer) to authenticated;
