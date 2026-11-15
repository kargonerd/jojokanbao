-- Device clocks can run ahead of the server, and the previous validation
-- rejected the whole batch once a record was more than five minutes in the
-- future. Clamp such timestamps (and a future clear time) to the server clock
-- instead of failing the sync; stored records keep a monotonic ordering.
create or replace function public.sync_reading_history(p_user_id uuid, p_records jsonb, p_cleared_at bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reader_id uuid := auth.uid();
  snapshot public.reader_history%rowtype;
  entry jsonb;
  result jsonb;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  -- Bind the request to the initiating account, even if the SDK changes sessions.
  if reader_id is null or reader_id is distinct from p_user_id then
    raise insufficient_privilege using message = 'Reading history account mismatch';
  end if;
  if p_records is null or jsonb_typeof(p_records) <> 'array' then
    raise invalid_parameter_value using message = 'Invalid reading records';
  end if;
  if jsonb_array_length(p_records) > 16 or octet_length(p_records::text) > 65536
    or p_cleared_at is null or p_cleared_at < 0 then
    raise invalid_parameter_value using message = 'Invalid reading history';
  end if;
  for entry in select value from jsonb_array_elements(p_records) loop
    if not coalesce(jsonb_typeof(entry) = 'object'
      and jsonb_typeof(entry->'title') = 'string' and char_length(entry->>'title') between 1 and 500
      and jsonb_typeof(entry->'subtitle') = 'string' and char_length(entry->>'subtitle') <= 500
      and jsonb_typeof(entry->'updatedAt') = 'number' and (entry->>'updatedAt')::numeric >= 1
      and jsonb_typeof(entry->'progress') = 'number' and (entry->>'progress')::numeric between 0 and 100
      and (case entry->>'kind'
        when 'book' then
          jsonb_typeof(entry->'datasetId') = 'string' and char_length(entry->>'datasetId') between 1 and 500
          and jsonb_typeof(entry->'itemKey') = 'string' and char_length(entry->>'itemKey') between 1 and 500
          and (not entry ? 'chapterId' or (jsonb_typeof(entry->'chapterId') = 'string' and char_length(entry->>'chapterId') between 1 and 500))
          and (not entry ? 'chapterProgress' or (jsonb_typeof(entry->'chapterProgress') = 'number' and (entry->>'chapterProgress')::numeric between 0 and 1))
        when 'periodical' then
          entry->>'publication' in ('rmrb', 'ckxx', 'hq', 'rmhb', 'sjzs')
          and jsonb_typeof(entry->'issueId') = 'string' and entry->>'issueId' ~ '^\d{6}(\d{2})?$'
          and jsonb_typeof(entry->'currentPage') = 'number' and entry->>'currentPage' ~ '^\d+$' and (entry->>'currentPage')::numeric between 1 and 100000
          and jsonb_typeof(entry->'totalPages') = 'number' and entry->>'totalPages' ~ '^\d+$' and (entry->>'totalPages')::numeric between 0 and 100000
        else false end), false) then
      raise invalid_parameter_value using message = 'Invalid reading record';
    end if;
  end loop;

  insert into public.reader_history(user_id) values (reader_id) on conflict do nothing;
  select * into snapshot from public.reader_history where user_id = reader_id for update;
  snapshot.cleared_at := greatest(snapshot.cleared_at, least(p_cleared_at, now_ms));
  -- Locking the account row makes simultaneous device merges atomic. Timestamps
  -- are reading times, not upload times; stale offline uploads cannot rewind it.
  -- A timestamp ahead of the server is folded back so one wrong device clock
  -- cannot reject the batch or win every future merge.
  select coalesce(jsonb_agg(r.entry order by r.read_at desc, r.key), '[]'::jsonb) into result
  from (
    select distinct on (candidates.key) candidates.key, candidates.entry, candidates.read_at
    from (
      select jsonb_set(value, '{updatedAt}', to_jsonb(least((value->>'updatedAt')::numeric, now_ms)::bigint)) as entry,
        least((value->>'updatedAt')::numeric, now_ms) as read_at,
        case value->>'kind' when 'book' then jsonb_build_array('book', value->>'datasetId', value->>'itemKey')
          else jsonb_build_array('periodical', value->>'publication', value->>'issueId') end as key,
        ordinality
      from jsonb_array_elements(snapshot.records || p_records) with ordinality
      where least((value->>'updatedAt')::numeric, now_ms) > snapshot.cleared_at
    ) candidates order by candidates.key, candidates.read_at desc, candidates.ordinality
  ) r;
  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb) into result
    from jsonb_array_elements(result) with ordinality where ordinality <= 16;
  update public.reader_history set records = result, cleared_at = snapshot.cleared_at where user_id = reader_id;
  return jsonb_build_object('records', result, 'clearedAt', snapshot.cleared_at);
end;
$$;
revoke all on function public.sync_reading_history(uuid, jsonb, bigint) from public, anon;
grant execute on function public.sync_reading_history(uuid, jsonb, bigint) to authenticated;
