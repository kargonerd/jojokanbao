-- Private clippings share the same account across Web, Desktop and Mobile.
create table public.reader_clippings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_type text not null check (content_type in ('book', 'newspaper', 'magazine')),
  content_id text not null check (char_length(content_id) between 1 and 500),
  content_title text not null check (char_length(content_title) between 1 and 500),
  section_id text not null check (char_length(section_id) between 1 and 500),
  location_label text not null default '' check (char_length(location_label) <= 500),
  content_url text not null check (char_length(content_url) <= 4000 and content_url ~ '^/(book|archive)/[^[:space:]]+$' and position(E'\\' in content_url) = 0),
  quote text not null default '' check (char_length(quote) <= 6000),
  note text not null default '' check (char_length(note) <= 8000),
  collection text not null default '' check (char_length(collection) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(btrim(quote)) > 0 or char_length(btrim(note)) > 0)
);
alter table public.reader_clippings enable row level security;
create index reader_clippings_owner_date on public.reader_clippings(user_id, created_at desc, id desc);
create index reader_clippings_owner_collection on public.reader_clippings(user_id, collection);
create policy reader_clippings_own on public.reader_clippings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.reader_clippings from anon, authenticated;
grant select on public.reader_clippings to authenticated;

create function public.get_reader_clippings(p_expected_user_id uuid, p_query text default '', p_collection text default null, p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Authentication required'; end if;
  return coalesce((select jsonb_agg(to_jsonb(c) - 'user_id' order by c.created_at desc, c.id desc) from (
    select * from public.reader_clippings where user_id = auth.uid()
      and (p_collection is null or collection = p_collection)
      and (coalesce(btrim(p_query), '') = '' or position(lower(btrim(p_query)) in lower(content_title || ' ' || quote || ' ' || note || ' ' || collection)) > 0)
    order by created_at desc, id desc offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) c), '[]'::jsonb);
end $$;

create function public.get_reader_clipping_collections(p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Authentication required'; end if;
  return coalesce((select jsonb_agg(c.collection order by c.collection) from (
    select distinct collection from public.reader_clippings where user_id = auth.uid() and collection <> ''
  ) c), '[]'::jsonb);
end $$;

create function public.save_reader_clipping(p_expected_user_id uuid, p_id uuid, p_content_type text, p_content_id text, p_content_title text, p_section_id text,
  p_location_label text, p_content_url text, p_quote text, p_note text, p_collection text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved public.reader_clippings;
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Authentication required'; end if;
  if p_id is null then
    insert into public.reader_clippings (user_id, content_type, content_id, content_title, section_id, location_label, content_url, quote, note, collection)
    values (auth.uid(), p_content_type, btrim(p_content_id), btrim(p_content_title), btrim(p_section_id), btrim(coalesce(p_location_label, '')),
      p_content_url, btrim(coalesce(p_quote, '')), btrim(coalesce(p_note, '')), btrim(coalesce(p_collection, ''))) returning * into saved;
  else
    -- A saved source stays attached to its original citation when notes are edited.
    update public.reader_clippings set quote = btrim(coalesce(p_quote, '')), note = btrim(coalesce(p_note, '')),
      collection = btrim(coalesce(p_collection, '')), updated_at = now()
    where id = p_id and user_id = auth.uid() returning * into saved;
    if not found then raise exception 'Clipping not found'; end if;
  end if;
  return to_jsonb(saved) - 'user_id';
end $$;

create function public.delete_reader_clipping(p_expected_user_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Authentication required'; end if;
  delete from public.reader_clippings where id = p_id and user_id = auth.uid();
end $$;

revoke all on function public.get_reader_clippings(uuid, text, text, integer, integer), public.get_reader_clipping_collections(uuid),
  public.save_reader_clipping(uuid, uuid, text, text, text, text, text, text, text, text, text), public.delete_reader_clipping(uuid, uuid) from public, anon;
grant execute on function public.get_reader_clippings(uuid, text, text, integer, integer), public.get_reader_clipping_collections(uuid),
  public.save_reader_clipping(uuid, uuid, text, text, text, text, text, text, text, text, text), public.delete_reader_clipping(uuid, uuid) to authenticated;
