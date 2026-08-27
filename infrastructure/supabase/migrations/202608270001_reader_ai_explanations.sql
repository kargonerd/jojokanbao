-- Replace per-user Reader AI explanation rows with an anonymous shared cache.
-- Direct table access stays closed; authenticated clients use narrow RPCs.

create table public.reader_ai_explanation_cache (
  cache_key text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$'),
  dataset_id text not null check (char_length(dataset_id) between 1 and 500),
  item_id text not null check (char_length(item_id) between 1 and 500),
  chapter_id text not null check (char_length(chapter_id) between 1 and 500),
  context_key text not null check (char_length(context_key) between 1 and 8000),
  prompt_version text not null check (char_length(prompt_version) between 1 and 100),
  quote text not null check (char_length(trim(quote)) between 1 and 2000),
  prefix text not null default '' check (char_length(prefix) <= 1200),
  suffix text not null default '' check (char_length(suffix) <= 1200),
  answer text not null check (char_length(trim(answer)) between 1 and 40000),
  references jsonb not null default '[]'::jsonb check (jsonb_typeof(references) = 'array'),
  model text not null default 'unknown' check (char_length(model) between 1 and 200),
  query_count bigint not null default 1 check (query_count >= 1),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz not null default timezone('utc', now())
);

create index reader_ai_explanation_cache_popular
  on public.reader_ai_explanation_cache(scope_key, query_count desc, last_used_at desc);

alter table public.reader_ai_explanation_cache enable row level security;
revoke all on table public.reader_ai_explanation_cache from public, anon, authenticated;

create or replace function private.reader_ai_cache_hash(p_values text[])
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(to_jsonb(p_values)::text, 'UTF8')), 'hex')
$$;

revoke all on function private.reader_ai_cache_hash(text[]) from public, anon, authenticated;

-- Legacy rows identify individual readers and were generated with an older
-- prompt. They are intentionally discarded instead of being mislabeled as
-- reusable focus-context answers.
drop function if exists public.get_reusable_reader_explanation(text, text, text);
drop function if exists public.get_reusable_reader_explanation(text, text, text, text);
drop function if exists public.get_popular_reader_explanations(text, text, text);
drop table if exists public.reader_ai_explanations;

create or replace function public.get_reader_ai_explanation_cache(
  p_dataset_id text,
  p_item_id text,
  p_chapter_id text,
  p_context_key text,
  p_prompt_version text
)
returns table(
  quote text,
  prefix text,
  suffix text,
  answer text,
  references jsonb,
  model text,
  prompt_version text,
  query_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset_id text;
  v_item_id text;
  v_chapter_id text;
  v_prompt_version text;
  v_cache_key text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if p_dataset_id is null or char_length(trim(p_dataset_id)) not between 1 and 500
    or p_item_id is null or char_length(trim(p_item_id)) not between 1 and 500
    or p_chapter_id is null or char_length(trim(p_chapter_id)) not between 1 and 500
    or p_context_key is null or char_length(p_context_key) not between 1 and 8000
    or p_prompt_version is null or char_length(trim(p_prompt_version)) not between 1 and 100 then
    raise exception 'Invalid Reader AI cache key';
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

  return query
  update public.reader_ai_explanation_cache as cache
  set
    query_count = cache.query_count + 1,
    last_used_at = timezone('utc', now())
  where cache.cache_key = v_cache_key
    and cache.dataset_id = v_dataset_id
    and cache.item_id = v_item_id
    and cache.chapter_id = v_chapter_id
    and cache.context_key = p_context_key
    and cache.prompt_version = v_prompt_version
  returning
    cache.quote,
    cache.prefix,
    cache.suffix,
    cache.answer,
    cache.references,
    cache.model,
    cache.prompt_version,
    cache.query_count;
end;
$$;

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
  v_scope_key text;
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
  v_scope_key := private.reader_ai_cache_hash(array[
    v_dataset_id,
    v_item_id,
    v_chapter_id,
    v_prompt_version
  ]);

  insert into public.reader_ai_explanation_cache as cache (
    cache_key,
    scope_key,
    dataset_id,
    item_id,
    chapter_id,
    context_key,
    prompt_version,
    quote,
    prefix,
    suffix,
    answer,
    references,
    model,
    query_count,
    updated_at,
    last_used_at
  ) values (
    v_cache_key,
    v_scope_key,
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
  references jsonb,
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
  v_scope_key text;
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
  v_scope_key := private.reader_ai_cache_hash(array[
    v_dataset_id,
    v_item_id,
    v_chapter_id,
    v_prompt_version
  ]);

  return query
  select
    cache.quote,
    cache.prefix,
    cache.suffix,
    cache.answer,
    cache.references,
    cache.model,
    cache.prompt_version,
    cache.query_count
  from public.reader_ai_explanation_cache cache
  where cache.scope_key = v_scope_key
    and cache.dataset_id = v_dataset_id
    and cache.item_id = v_item_id
    and cache.chapter_id = v_chapter_id
    and cache.prompt_version = v_prompt_version
    and cache.query_count >= 2
  order by cache.query_count desc, cache.quote
  limit 50;
end;
$$;

revoke all on function public.get_reader_ai_explanation_cache(text, text, text, text, text) from public, anon;
revoke all on function public.put_reader_ai_explanation_cache(text, text, text, text, text, text, text, text, jsonb, text, text) from public, anon;
revoke all on function public.get_popular_reader_ai_explanations(text, text, text, text) from public, anon;
grant execute on function public.get_reader_ai_explanation_cache(text, text, text, text, text) to authenticated;
grant execute on function public.put_reader_ai_explanation_cache(text, text, text, text, text, text, text, text, jsonb, text, text) to authenticated;
grant execute on function public.get_popular_reader_ai_explanations(text, text, text, text) to authenticated;

update private.feature_flags
set description = '划线和想法'
where key = 'reader.annotations';
