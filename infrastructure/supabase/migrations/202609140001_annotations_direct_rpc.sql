-- Readers call the annotation RPCs directly with their own session, so the
-- shared disclosure threshold is fixed in the database instead of being supplied
-- by a caller. It stays 2, matching private.annotation_snapshot's default and the
-- book annotation views; every entry point below passes it explicitly.
--
-- 202609130004 routed the operations through one dispatcher that accepted
-- p_public_mark_threshold from the caller, which forced the Python API to act as
-- the only trusted caller. That parameter is gone now, so the dispatcher has no
-- reason to exist and the named RPCs are public again.

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
  return private.get_annotation_threads(2, p_content_type, p_content_id, p_section_id);
end;
$$;
revoke all on function public.get_annotation_threads(text, text, text) from public, anon;
grant execute on function public.get_annotation_threads(text, text, text) to authenticated;

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
begin
  return private.create_content_annotation(2, p_content_type, p_content_id, p_section_id,
    p_content_title, p_content_url, p_quote, p_prefix, p_suffix, p_start_offset, p_end_offset,
    p_initial_comment, p_initial_comment_visibility);
end;
$$;
revoke all on function public.create_content_annotation(text, text, text, text, text, text, text, text, integer, integer, text, text) from public, anon;
grant execute on function public.create_content_annotation(text, text, text, text, text, text, text, text, integer, integer, text, text) to authenticated;

create or replace function public.delete_my_annotation_mark(p_annotation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.delete_my_annotation_mark(2, p_annotation_id);
end;
$$;
revoke all on function public.delete_my_annotation_mark(uuid) from public, anon;
grant execute on function public.delete_my_annotation_mark(uuid) to authenticated;

-- These three never took a threshold; 202609130004 revoked them only because the
-- dispatcher called them as its definer. Direct readers need the grant back.
grant execute on function public.add_annotation_comment(uuid, text, uuid, text) to authenticated;
grant execute on function public.report_annotation_comment(uuid, text, text) to authenticated;
grant execute on function public.set_annotation_comment_like(uuid, boolean) to authenticated;

-- No caller left: readers use the named RPCs above, including
-- public.get_my_book_annotations and public.get_public_book_annotations.
drop function public.annotation_request(uuid, integer, text, jsonb);
