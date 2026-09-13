-- Readers can delete their own thoughts and replies. Deletion must never cascade
-- into other readers' marks, but will clear likes and dissociate replies.
create function public.delete_my_annotation_comment(p_comment_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  reader_id uuid := private.require_annotation_reader();
  target_annotation_id uuid;
  snapshot jsonb;
begin
  select annotation_id into target_annotation_id
  from public.annotation_comments
  where id = p_comment_id and user_id = reader_id;

  if target_annotation_id is null then
    return jsonb_build_object('commentId', p_comment_id, 'annotationId', null, 'thread', null);
  end if;

  perform 1 from public.content_annotations where id = target_annotation_id for update;

  delete from public.annotation_comments
  where id = p_comment_id and user_id = reader_id;

  snapshot := private.annotation_snapshot(target_annotation_id);

  return jsonb_build_object(
    'commentId', p_comment_id,
    'annotationId', target_annotation_id,
    'thread', case
      when (snapshot->>'publiclyVisible')::boolean
        or (snapshot->>'underlinedByMe')::boolean
        or jsonb_array_length(snapshot->'comments') > 0
      then snapshot
      else null end
  );
end;
$$;
revoke all on function public.delete_my_annotation_comment(uuid) from public, anon;
grant execute on function public.delete_my_annotation_comment(uuid) to authenticated;
