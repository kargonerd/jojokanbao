-- Read a reader's book notes in bounded pages instead of requesting every chapter.
create function public.get_my_book_annotations(
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
    with page as materialized (
      select annotation.id
      from public.content_annotations annotation
      where annotation.content_type = 'book'
        and annotation.content_id = p_content_id
        and annotation.moderation_status = 'visible'
        and (p_after_id is null or annotation.id > p_after_id)
        and (
          exists (
            select 1 from public.content_annotation_marks own_mark
            where own_mark.annotation_id = annotation.id
              and own_mark.user_id = reader_id
          )
          or exists (
            select 1 from public.annotation_comments own_comment
            where own_comment.annotation_id = annotation.id
              and own_comment.user_id = reader_id
              and own_comment.moderation_status = 'visible'
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
