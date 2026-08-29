create table if not exists public.times_article_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id text not null check (char_length(trim(article_id)) between 1 and 500),
  issue_date date not null,
  read_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, article_id)
);

create index if not exists times_article_reads_recent
  on public.times_article_reads(user_id, issue_date desc, read_at desc);

alter table public.times_article_reads enable row level security;
revoke all on table public.times_article_reads from public, anon, authenticated;

create or replace function public.get_my_times_article_reads(p_article_ids text[])
returns table(article_id text, read_at timestamptz)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  reader_id uuid := (select auth.uid());
begin
  if reader_id is null then
    raise exception 'Authentication required';
  end if;
  if coalesce(cardinality(p_article_ids), 0) > 500
    or exists (
      select 1
      from unnest(coalesce(p_article_ids, array[]::text[])) candidate
      where candidate is null or char_length(trim(candidate)) not between 1 and 500
    ) then
    raise exception 'Invalid Times article ids';
  end if;

  return query
  select article.article_id, article.read_at
  from public.times_article_reads article
  where article.user_id = reader_id
    and article.article_id = any(coalesce(p_article_ids, array[]::text[]));
end;
$$;

create or replace function public.mark_my_times_article_read(
  p_article_id text,
  p_issue_date date
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := (select auth.uid());
  marked_at timestamptz := timezone('utc', now());
begin
  if reader_id is null then
    raise exception 'Authentication required';
  end if;
  if p_article_id is null
    or char_length(trim(p_article_id)) not between 1 and 500
    or p_issue_date is null then
    raise exception 'Invalid Times article read';
  end if;

  insert into public.times_article_reads as article (
    user_id,
    article_id,
    issue_date,
    read_at,
    updated_at
  ) values (
    reader_id,
    trim(p_article_id),
    p_issue_date,
    marked_at,
    marked_at
  )
  on conflict (user_id, article_id)
  do update set
    issue_date = excluded.issue_date,
    read_at = excluded.read_at,
    updated_at = excluded.updated_at;

  return marked_at;
end;
$$;

create or replace function public.mark_my_times_article_unread(p_article_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := (select auth.uid());
begin
  if reader_id is null then
    raise exception 'Authentication required';
  end if;
  if p_article_id is null or char_length(trim(p_article_id)) not between 1 and 500 then
    raise exception 'Invalid Times article id';
  end if;

  delete from public.times_article_reads article
  where article.user_id = reader_id
    and article.article_id = trim(p_article_id);
end;
$$;

revoke all on function public.get_my_times_article_reads(text[]) from public, anon;
revoke all on function public.mark_my_times_article_read(text, date) from public, anon;
revoke all on function public.mark_my_times_article_unread(text) from public, anon;
grant execute on function public.get_my_times_article_reads(text[]) to authenticated;
grant execute on function public.mark_my_times_article_read(text, date) to authenticated;
grant execute on function public.mark_my_times_article_unread(text) to authenticated;

comment on table public.times_article_reads is
  'Per-reader JOJO Times read state. An absent row means unread.';
