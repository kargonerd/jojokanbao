create table if not exists public.reader_bookshelf (
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id text not null,
  item_id text not null,
  title text not null,
  added_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, item_id)
);

create table if not exists public.reader_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id text not null,
  item_id text not null,
  chapter_id text not null,
  kind text not null check (kind in ('underline', 'thought')),
  quote text not null check (char_length(quote) between 1 and 2000),
  prefix text not null default '',
  suffix text not null default '',
  thought text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.reader_ai_explanations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id text not null,
  item_id text not null,
  chapter_id text not null,
  phrase_key text not null,
  quote text not null check (char_length(quote) between 1 and 2000),
  answer text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, item_id, phrase_key)
);

alter table public.reader_bookshelf enable row level security;
alter table public.reader_marks enable row level security;
alter table public.reader_ai_explanations enable row level security;
grant select, insert, update, delete on public.reader_bookshelf, public.reader_marks, public.reader_ai_explanations to authenticated;

create policy "reader_bookshelf_own" on public.reader_bookshelf for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "reader_marks_own" on public.reader_marks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "reader_ai_explanations_read_own" on public.reader_ai_explanations for select to authenticated using ((select auth.uid()) = user_id);
create policy "reader_ai_explanations_insert_own" on public.reader_ai_explanations for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "reader_ai_explanations_update_own" on public.reader_ai_explanations for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "reader_ai_explanations_delete_own" on public.reader_ai_explanations for delete to authenticated using ((select auth.uid()) = user_id);

create index if not exists reader_marks_item_chapter on public.reader_marks(user_id, item_id, chapter_id);
create index if not exists reader_ai_explanations_phrase on public.reader_ai_explanations(item_id, phrase_key);

create or replace function public.get_reusable_reader_explanation(p_item_id text, p_phrase_key text)
returns table(quote text, answer text, explanation_count bigint)
language sql security definer set search_path = '' stable
as $$
  select min(e.quote), e.answer, count(*)
  from public.reader_ai_explanations e
  where e.item_id = p_item_id and e.phrase_key = p_phrase_key and e.answer is not null
  group by e.answer
  order by count(*) desc, e.answer
  limit 1
$$;

create or replace function public.get_popular_reader_explanations(p_item_id text, p_chapter_id text)
returns table(quote text, answer text, explanation_count bigint)
language sql security definer set search_path = '' stable
as $$
  select min(e.quote), e.answer, count(*)
  from public.reader_ai_explanations e
  where e.item_id = p_item_id and e.chapter_id = p_chapter_id and e.answer is not null
  group by e.phrase_key, e.answer
  having count(*) >= 2
  order by count(*) desc, min(e.quote)
  limit 50
$$;

grant execute on function public.get_reusable_reader_explanation(text, text) to authenticated;
grant execute on function public.get_popular_reader_explanations(text, text) to authenticated;
