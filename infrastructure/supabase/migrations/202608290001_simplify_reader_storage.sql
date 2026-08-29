-- Keep one fixed-size key for exact Reader AI cache identity, while using the
-- cache's ordinary scope columns directly for popular chapter lookups.

drop index if exists public.reader_ai_explanation_cache_popular;

alter table public.reader_ai_explanation_cache
  drop column if exists scope_key;

create index reader_ai_explanation_cache_popular
  on public.reader_ai_explanation_cache(
    dataset_id,
    item_id,
    chapter_id,
    prompt_version,
    query_count desc,
    last_used_at desc
  );

create or replace function public.put_reader_ai_explanation_cache(
  p_dataset_id text,
  p_item_id text,
  p_chapter_id text,
  p_context_key text,
  p_quote text,
  p_prefix text,
  p_suffix text,
  p_answer text,
  p_references jsonb,
  p_model text,
  p_prompt_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset_id text;
  v_item_id text;
  v_chapter_id text;
  v_prompt_version text;
  v_references jsonb := coalesce(p_references, '[]'::jsonb);
  v_cache_key text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if p_dataset_id is null or char_length(trim(p_dataset_id)) not between 1 and 500
    or p_item_id is null or char_length(trim(p_item_id)) not between 1 and 500
    or p_chapter_id is null or char_length(trim(p_chapter_id)) not between 1 and 500
    or p_context_key is null or char_length(p_context_key) not between 1 and 8000
    or p_quote is null or char_length(trim(p_quote)) not between 1 and 2000
    or p_prefix is null or char_length(p_prefix) > 1200
    or p_suffix is null or char_length(p_suffix) > 1200
    or p_answer is null or char_length(trim(p_answer)) not between 1 and 40000
    or p_model is null or char_length(trim(p_model)) not between 1 and 200
    or p_prompt_version is null or char_length(trim(p_prompt_version)) not between 1 and 100 then
    raise exception 'Invalid Reader AI cache payload';
  end if;
  if jsonb_typeof(v_references) <> 'array' then
    raise exception 'Invalid Reader AI cache references';
  end if;
  if jsonb_array_length(v_references) > 20
    or octet_length(v_references::text) > 65536 then
    raise exception 'Invalid Reader AI cache references';
  end if;

  v_dataset_id := trim(p_dataset_id);
  v_item_id := trim(p_item_id);
  v_chapter_id := trim(p_chapter_id);
  v_prompt_version := trim(p_prompt_version);
  v_cache_key := private.reader_ai_cache_hash(array[
    v_dataset_id,
    v_item_id,
    v_chapter_id,
    p_context_key,
    v_prompt_version
  ]);

  insert into public.reader_ai_explanation_cache as cache (
    cache_key,
    dataset_id,
    item_id,
    chapter_id,
    context_key,
    prompt_version,
    quote,
    prefix,
    suffix,
    answer,
    reference_data,
    model,
    query_count,
    updated_at,
    last_used_at
  ) values (
    v_cache_key,
    v_dataset_id,
    v_item_id,
    v_chapter_id,
    p_context_key,
    v_prompt_version,
    p_quote,
    p_prefix,
    p_suffix,
    trim(p_answer),
    v_references,
    trim(p_model),
    1,
    timezone('utc', now()),
    timezone('utc', now())
  )
  on conflict (cache_key)
  do update set
    query_count = cache.query_count + 1,
    last_used_at = timezone('utc', now())
  where cache.dataset_id = excluded.dataset_id
    and cache.item_id = excluded.item_id
    and cache.chapter_id = excluded.chapter_id
    and cache.context_key = excluded.context_key
    and cache.prompt_version = excluded.prompt_version;
end;
$$;

create or replace function public.get_popular_reader_ai_explanations(
  p_dataset_id text,
  p_item_id text,
  p_chapter_id text,
  p_prompt_version text
)
returns table(
  quote text,
  prefix text,
  suffix text,
  answer text,
  reference_data jsonb,
  model text,
  prompt_version text,
  query_count bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_dataset_id text;
  v_item_id text;
  v_chapter_id text;
  v_prompt_version text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if p_dataset_id is null or char_length(trim(p_dataset_id)) not between 1 and 500
    or p_item_id is null or char_length(trim(p_item_id)) not between 1 and 500
    or p_chapter_id is null or char_length(trim(p_chapter_id)) not between 1 and 500
    or p_prompt_version is null or char_length(trim(p_prompt_version)) not between 1 and 100 then
    raise exception 'Invalid Reader AI cache scope';
  end if;

  v_dataset_id := trim(p_dataset_id);
  v_item_id := trim(p_item_id);
  v_chapter_id := trim(p_chapter_id);
  v_prompt_version := trim(p_prompt_version);

  return query
  select
    cache.quote,
    cache.prefix,
    cache.suffix,
    cache.answer,
    cache.reference_data,
    cache.model,
    cache.prompt_version,
    cache.query_count
  from public.reader_ai_explanation_cache cache
  where cache.dataset_id = v_dataset_id
    and cache.item_id = v_item_id
    and cache.chapter_id = v_chapter_id
    and cache.prompt_version = v_prompt_version
    and cache.query_count >= 3
  order by cache.query_count desc, cache.quote
  limit 50;
end;
$$;

-- reader_marks was the unused per-reader prototype replaced by the unified
-- content annotation tables. Production contains no rows and the application
-- has no remaining references to it.
do $$
begin
  if exists (select 1 from public.reader_marks) then
    raise exception 'reader_marks still contains legacy data';
  end if;
end;
$$;

drop table if exists public.reader_marks;
