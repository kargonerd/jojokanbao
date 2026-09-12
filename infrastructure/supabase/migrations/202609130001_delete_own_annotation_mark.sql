-- An underline is a reader's membership in a shared anchor. Removing it must
-- never cascade into other readers' marks, thoughts, replies, or reactions.
create function public.delete_my_annotation_mark(p_annotation_id uuid)
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

  snapshot := private.annotation_snapshot(p_annotation_id);
  -- After removal the anchor may fall below the sharing threshold. Return the
  -- resulting reader-visible state, including zero marks with public thoughts.
  return jsonb_build_object('thread', case
    when (snapshot->>'publiclyVisible')::boolean then snapshot
    else null end);
end;
$$;
revoke all on function public.delete_my_annotation_mark(uuid) from public, anon;
grant execute on function public.delete_my_annotation_mark(uuid) to authenticated;
