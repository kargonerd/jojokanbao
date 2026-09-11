-- Reading-context corrections shared by web, desktop, and mobile.
-- Readers submit via RPC; operator processing uses the existing Workbench token.
create table public.content_corrections (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (char_length(request_id) between 16 and 100),
  content_type text not null check (content_type in ('book', 'newspaper', 'magazine', 'article')),
  content_id text not null check (char_length(btrim(content_id)) between 1 and 512),
  content_title text not null check (char_length(btrim(content_title)) between 1 and 300),
  content_url text not null check (
    char_length(content_url) between 1 and 1024 and left(content_url, 1) = '/'
    and left(content_url, 2) <> '//' and strpos(content_url, chr(92)) = 0
    and content_url !~ '[[:cntrl:]]'
  ),
  section_id text check (section_id is null or char_length(section_id) between 1 and 512),
  location_label text check (location_label is null or char_length(location_label) <= 300),
  quote text check (quote is null or char_length(quote) <= 4000),
  category text not null check (category in ('typo', 'missing_page', 'wrong_page', 'layout', 'other')),
  details text not null check (char_length(btrim(details)) between 2 and 2000),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'resolved', 'dismissed')),
  resolution_note text check (resolution_note is null or char_length(resolution_note) between 2 and 1000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique(user_id, request_id)
);
create index content_corrections_owner on public.content_corrections(user_id, created_at desc);
create index content_corrections_queue on public.content_corrections(status, created_at, id);
alter table public.content_corrections enable row level security;
revoke all on table public.content_corrections from public, anon, authenticated;
grant select on table public.content_corrections to authenticated;
create policy content_corrections_read_own on public.content_corrections for select to authenticated
  using ((select auth.uid()) = user_id);

create function private.content_correction_snapshot(p_correction_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'contentType', c.content_type, 'contentId', c.content_id,
    'contentTitle', c.content_title, 'contentUrl', c.content_url,
    'sectionId', c.section_id, 'locationLabel', c.location_label, 'quote', c.quote,
    'category', c.category, 'details', c.details, 'status', c.status,
    'createdAt', c.created_at, 'reviewedAt', c.reviewed_at, 'resolutionNote', c.resolution_note
  ) from public.content_corrections c where c.id = p_correction_id;
$$;

create function public.submit_content_correction(
  p_request_id text, p_content_type text, p_content_id text, p_content_title text,
  p_content_url text, p_category text, p_details text, p_expected_user_id uuid,
  p_section_id text default null, p_location_label text default null, p_quote text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reader_id uuid := private.require_account_user();
  correction_id uuid;
begin
  if p_expected_user_id is distinct from reader_id then
    raise insufficient_privilege using message = 'The submitting account changed';
  end if;
  -- Serialize a reader's retries and quota check, including concurrent devices.
  perform pg_advisory_xact_lock(hashtextextended(reader_id::text, 609080002));
  select id into correction_id from public.content_corrections
    where user_id = reader_id and request_id = p_request_id;
  if found then return private.content_correction_snapshot(correction_id); end if;
  if (select count(*) from public.content_corrections where user_id = reader_id and created_at > now() - interval '24 hours') >= 50 then
    raise too_many_connections using message = 'Content correction daily limit reached';
  end if;
  insert into public.content_corrections(
    user_id, request_id, content_type, content_id, content_title, content_url,
    section_id, location_label, quote, category, details
  ) values (
    reader_id, p_request_id, p_content_type, btrim(p_content_id), btrim(p_content_title), p_content_url,
    nullif(btrim(p_section_id), ''), nullif(btrim(p_location_label), ''), nullif(btrim(p_quote), ''),
    p_category, btrim(p_details)
  ) returning id into correction_id;
  return private.content_correction_snapshot(correction_id);
end;
$$;

create function public.get_my_content_corrections(p_content_type text default null, p_content_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare reader_id uuid := private.require_account_user();
begin
  return coalesce((select jsonb_agg(private.content_correction_snapshot(c.id) order by c.created_at desc, c.id)
    from (select id, created_at from public.content_corrections
      where user_id = reader_id and (p_content_type is null or content_type = p_content_type)
        and (p_content_id is null or content_id = p_content_id)
      order by created_at desc, id limit 100) c), '[]'::jsonb);
end;
$$;

create function public.operator_list_content_corrections(p_operator_token text, p_status text default 'pending', p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_status is null or p_status not in ('pending', 'in_progress', 'resolved', 'dismissed', 'all') then
    raise invalid_parameter_value using message = 'Unknown correction status';
  end if;
  if p_offset is null or p_offset < 0 then raise invalid_parameter_value using message = 'Invalid offset'; end if;
  return jsonb_build_object(
    'total', (select count(*) from public.content_corrections where p_status = 'all' or status = p_status),
    'items', coalesce((select jsonb_agg(private.content_correction_snapshot(c.id) order by c.created_at, c.id)
      from (select id, created_at from public.content_corrections where p_status = 'all' or status = p_status
        order by created_at, id limit 50 offset p_offset) c), '[]'::jsonb)
  );
end;
$$;

create function public.operator_review_content_correction(p_operator_token text, p_correction_id uuid, p_status text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_status is null or p_status not in ('pending', 'in_progress', 'resolved', 'dismissed') then
    raise invalid_parameter_value using message = 'Unknown correction status';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) not between 2 and 1000 then
    raise invalid_parameter_value using message = 'Correction review note is required';
  end if;
  update public.content_corrections set status = p_status, resolution_note = btrim(p_note), reviewed_at = now()
    where id = p_correction_id;
  if not found then raise no_data_found using message = 'Content correction not found'; end if;
  return private.content_correction_snapshot(p_correction_id);
end;
$$;

revoke all on function private.content_correction_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.submit_content_correction(text, text, text, text, text, text, text, uuid, text, text, text) from public, anon;
revoke all on function public.get_my_content_corrections(text, text) from public, anon;
revoke all on function public.operator_list_content_corrections(text, text, integer) from public;
revoke all on function public.operator_review_content_correction(text, uuid, text, text) from public;
grant execute on function public.submit_content_correction(text, text, text, text, text, text, text, uuid, text, text, text) to authenticated;
grant execute on function public.get_my_content_corrections(text, text) to authenticated;
grant execute on function public.operator_list_content_corrections(text, text, integer) to anon, authenticated;
grant execute on function public.operator_review_content_correction(text, uuid, text, text) to anon, authenticated;

comment on table public.content_corrections is 'Private reader corrections with reading context and operator resolution.';
