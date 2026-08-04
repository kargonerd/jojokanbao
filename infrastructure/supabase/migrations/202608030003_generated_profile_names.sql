-- Give every reader a unique generated nickname. Editing may be introduced
-- later in a reviewed migration.

create or replace function private.random_profile_display_name()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  pool_size integer;
  short_pool_size integer;
  base_name text;
  candidate text;
begin
  -- Serialize the short generation section so the existence check and the
  -- subsequent profile insert cannot race another signup.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jojo.profile_display_name')::bigint
  );

  select pg_catalog.count(*)::integer
  into pool_size
  from private.profile_name_pool;

  select pg_catalog.count(*)::integer
  into short_pool_size
  from private.profile_name_pool
  where pg_catalog.char_length(name) <= 3;

  if pool_size = 0 then
    raise exception 'profile name pool is empty';
  end if;

  for attempt in 1..128 loop
    if short_pool_size > 0 and pg_catalog.random() < 0.8 then
      select pool.name
      into base_name
      from private.profile_name_pool as pool
      where pg_catalog.char_length(pool.name) <= 3
      offset pg_catalog.floor(
        pg_catalog.random() * short_pool_size
      )::integer
      limit 1;
    else
      select pool.name
      into base_name
      from private.profile_name_pool as pool
      offset pg_catalog.floor(pg_catalog.random() * pool_size)::integer
      limit 1;
    end if;

    candidate := base_name || '-' ||
      pg_catalog.substr(
        alphabet,
        1 + pg_catalog.floor(
          pg_catalog.random() * pg_catalog.length(alphabet)
        )::integer,
        1
      ) ||
      pg_catalog.substr(
        alphabet,
        1 + pg_catalog.floor(
          pg_catalog.random() * pg_catalog.length(alphabet)
        )::integer,
        1
      ) ||
      pg_catalog.substr(
        alphabet,
        1 + pg_catalog.floor(
          pg_catalog.random() * pg_catalog.length(alphabet)
        )::integer,
        1
      );

    if not exists (
      select 1
      from public.profiles
      where display_name = candidate
    ) then
      return candidate;
    end if;
  end loop;

  raise exception 'could not allocate a unique profile display name';
end;
$$;

revoke execute on function private.random_profile_display_name()
  from public, anon, authenticated;

create or replace function public.ensure_profile_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.display_name := private.random_profile_display_name();
  return new;
end;
$$;

revoke execute on function public.ensure_profile_display_name()
  from public, anon, authenticated;

drop trigger if exists profiles_ensure_display_name on public.profiles;
create trigger profiles_ensure_display_name
  before insert on public.profiles
  for each row execute function public.ensure_profile_display_name();

-- Use one statement per existing profile so each generated value is visible
-- to the next uniqueness check inside the same migration transaction.
do $$
declare
  profile_id uuid;
begin
  for profile_id in
    select id
    from public.profiles
    order by id
  loop
    update public.profiles
    set display_name = private.random_profile_display_name()
    where id = profile_id;
  end loop;
end;
$$;

create unique index profiles_display_name_unique
  on public.profiles (display_name);

alter table public.profiles
  alter column display_name set not null;

alter table public.profiles
  drop constraint if exists profiles_display_name_check;

alter table public.profiles
  add constraint profiles_display_name_check
  check (
    pg_catalog.char_length(display_name) between 6 and 11
    and display_name ~ '^[^-]+-[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}$'
  );

-- The Web client may update an avatar later, but cannot choose or change the
-- generated nickname. Service-role code can add an explicit rename flow in a
-- future reviewed migration.
revoke update on table public.profiles from authenticated;
grant update (avatar_path) on table public.profiles to authenticated;

comment on column public.profiles.display_name is
  'Unique reader code generated once as a preferably short animal or plant name plus three letters.';
