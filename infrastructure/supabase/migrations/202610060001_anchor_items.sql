-- Anchored content (notes and links) attached to any delivered content object
-- by the shared (content_type, content_id, section_id) weak reference. Editorial
-- accounts publish directly; user submissions await review. User-facing access
-- is RPC-only, matching the unified annotations contract.

create table if not exists public.anchor_items (
  id uuid primary key default extensions.gen_random_uuid(),
  -- The type alone decides everything: label, payload rules, reader grouping.
  type text not null check (type in (
    'annotation', 'background', 'lecture', 'concept', 'person', 'event',
    'video', 'article', 'dictionary'
  )),
  content_type text not null check (content_type in ('book', 'newspaper', 'magazine', 'article')),
  content_id text not null check (char_length(content_id) between 1 and 512),
  section_id text check (section_id is null or char_length(section_id) between 1 and 512),
  content_title text not null check (char_length(content_title) between 1 and 300),
  content_url text check (
    content_url is null or (
      char_length(content_url) <= 1024
      and left(content_url, 1) = '/'
      and left(content_url, 2) <> '//'
      and strpos(content_url, E'\\') = 0
      and content_url !~ E'[\\r\\n]'
    )
  ),
  level text not null check (level in ('work', 'section', 'paragraph', 'sentence')),
  item_id text check (item_id is null or char_length(item_id) between 1 and 200),
  quote text check (quote is null or (char_length(quote) between 1 and 4000 and char_length(btrim(quote)) > 0)),
  prefix text not null default '' check (char_length(prefix) <= 160),
  suffix text not null default '' check (char_length(suffix) <= 160),
  start_offset integer,
  end_offset integer,
  anchor_key text check (anchor_key is null or char_length(anchor_key) = 64),
  title text check (title is null or char_length(title) between 1 and 300),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  author_key text check (author_key is null or char_length(btrim(author_key)) between 1 and 60),
  seed_key text check (seed_key is null or char_length(btrim(seed_key)) between 1 and 128),
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  moderation_reason text check (moderation_reason is null or char_length(btrim(moderation_reason)) between 2 and 500),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- Work-level anchors carry no section; every other level anchors inside one.
  check ((level = 'work') = (section_id is null)),
  -- Only sentence anchors carry text geometry and an anchor key.
  check (
    (
      level = 'sentence'
      and anchor_key is not null
      and quote is not null
      and start_offset is not null and end_offset is not null
      and start_offset >= 0 and end_offset > start_offset
    )
    or (level <> 'sentence' and quote is null and start_offset is null and end_offset is null and anchor_key is null)
  ),
  -- Paragraph anchors target a rendered block; section anchors name the section.
  check (level <> 'paragraph' or item_id is not null),
  check (level <> 'section' or item_id is null)
);

create unique index if not exists anchor_items_seed
  on public.anchor_items(seed_key) where seed_key is not null;
create index if not exists anchor_items_subject
  on public.anchor_items(content_type, content_id, section_id, created_at);
create index if not exists anchor_items_queue
  on public.anchor_items(status, created_at) where status = 'pending';
create index if not exists anchor_items_creator
  on public.anchor_items(created_by, created_at desc);
create index if not exists anchor_items_discussion
  on public.anchor_items(content_type, content_id, section_id, anchor_key)
  where status = 'approved' and anchor_key is not null;

alter table public.anchor_items enable row level security;
revoke all on table public.anchor_items from public, anon, authenticated;

create or replace function private.require_anchor_reader()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_account_user();
begin
  return reader_id;
end;
$$;

-- Editorial accounts are the jojo_roles holders; the role list is deliberately
-- explicit so a future role only publishes after it is added here on purpose.
create or replace function private.is_editorial_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from jsonb_array_elements_text(
        coalesce(auth.jwt() -> 'app_metadata' -> 'jojo_roles', '[]'::jsonb)
      ) as role(value)
      where role.value in ('admin', 'moderator', 'editorial')
  )
$$;

create or replace function private.validate_anchor_geometry(
  p_level text,
  p_item_id text,
  p_quote text,
  p_start_offset integer,
  p_end_offset integer
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_level = 'sentence' then
    if p_quote is null or char_length(p_quote) > 4000 or char_length(btrim(p_quote)) = 0 then
      raise invalid_parameter_value using message = 'Sentence anchors require a quote';
    end if;
    if p_start_offset is null or p_end_offset is null
      or p_start_offset < 0 or p_end_offset <= p_start_offset then
      raise invalid_parameter_value using message = 'Sentence anchors require valid offsets';
    end if;
  elsif p_level = 'paragraph' then
    if p_item_id is null or char_length(btrim(p_item_id)) = 0 then
      raise invalid_parameter_value using message = 'Paragraph anchors require a block id';
    end if;
  end if;
end;
$$;

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
