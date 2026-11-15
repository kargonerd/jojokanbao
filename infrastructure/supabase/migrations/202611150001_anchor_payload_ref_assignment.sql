-- The kind/type registry refactor (443fb6e0) dropped the assignment of the
-- ref variable from the payload, so target anchors silently accepted both a
-- url and a ref and rejected ref-only payloads. Restore the assignment.
create or replace function private.validate_anchor_payload(
  p_type text,
  p_payload jsonb
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  video jsonb;
  ref jsonb;
  url text;
  has_body boolean;
  has_target boolean;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise invalid_parameter_value using message = 'Anchor payload must be an object';
  end if;

  has_body := char_length(btrim(coalesce(p_payload ->> 'body', ''))) between 1 and 8000;
  url := nullif(btrim(coalesce(p_payload ->> 'url', '')), '');
  ref := p_payload -> 'ref';
  has_target := url is not null or p_payload ? 'ref' or p_payload ? 'video';

  if p_payload ? 'body' and not has_body then
    raise invalid_parameter_value using message = 'Anchor body must be 1-8000 characters';
  end if;

  video := p_payload -> 'video';
  if video is not null then
    if jsonb_typeof(video) <> 'object'
      or char_length(btrim(coalesce(video ->> 'bvid', ''))) not between 1 and 64
      or exists (
        select 1 from jsonb_object_keys(video) as key(value)
          where key.value not in ('bvid', 't')
      )
      or (video ? 't' and (jsonb_typeof(video -> 't') <> 'number' or (video ->> 't')::numeric < 0))
    then
      raise invalid_parameter_value using message = 'Anchor video payload is invalid';
    end if;
  end if;

  if p_payload ? 'page' and (
    jsonb_typeof(p_payload -> 'page') <> 'number'
    or (p_payload ->> 'page')::numeric <> floor((p_payload ->> 'page')::numeric)
    or (p_payload ->> 'page')::numeric < 1
    or (p_payload ->> 'page')::numeric > 100000
  ) then
    raise invalid_parameter_value using message = 'Anchor page must be an integer between 1 and 100000';
  end if;

  -- Per-type payload rules: the type alone decides what an entry carries.
  if p_type in ('annotation', 'concept', 'person', 'event', 'background') then
    -- Text entries: prose is the payload; a lecture video or page may ride along.
    if not has_body then
      raise invalid_parameter_value using message = 'This anchor type requires body text';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_payload) as key(value)
        where key.value not in ('body', 'video', 'page')
    ) then
      raise invalid_parameter_value using message = 'Unknown fields for this anchor type';
    end if;
  elsif p_type = 'lecture' then
    -- A lecture may be prose, a recorded video, or both.
    if not (has_body or video is not null) then
      raise invalid_parameter_value using message = 'A lecture requires body text or a video';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_payload) as key(value)
        where key.value not in ('body', 'video', 'page')
    ) then
      raise invalid_parameter_value using message = 'Unknown fields for this anchor type';
    end if;
  elsif p_type in ('video', 'article', 'dictionary') then
    -- Target entries point somewhere: an external url or an in-site reference.
    if url is not null and ref is not null then
      raise invalid_parameter_value using message = 'Target anchors accept either url or ref, not both';
    end if;
    if not (url is not null or p_payload ? 'ref') then
      raise invalid_parameter_value using message = 'This anchor type requires a url or ref';
    end if;
    if url is not null and (
      char_length(url) > 1024
      or left(url, 8) <> 'https://'
        and left(url, 7) <> 'http://'
    ) then
      raise invalid_parameter_value using message = 'Anchor url must be an http(s) address';
    end if;
    if ref is not null then
      if jsonb_typeof(ref) <> 'object'
        or char_length(btrim(coalesce(ref ->> 'contentId', ''))) not between 1 and 512
        or exists (
          select 1 from jsonb_object_keys(ref) as key(value)
            where key.value not in ('contentId', 'sectionId')
        )
        or (ref ? 'sectionId' and char_length(btrim(coalesce(ref ->> 'sectionId', ''))) not between 1 and 512)
      then
        raise invalid_parameter_value using message = 'Anchor ref payload is invalid';
      end if;
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_payload) as key(value)
        where key.value not in ('url', 'ref')
    ) then
      raise invalid_parameter_value using message = 'Unknown fields for this anchor type';
    end if;
  else
    raise invalid_parameter_value using message = 'Unknown anchor type';
  end if;
end;
$$;
