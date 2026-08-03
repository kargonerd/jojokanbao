-- Private source pool for generated reader nicknames.

create table private.profile_name_pool (
  id integer generated always as identity primary key,
  kind text not null check (kind in ('animal', 'plant')),
  name text not null unique,
  check (pg_catalog.char_length(name) between 2 and 7)
);

revoke all on table private.profile_name_pool
  from public, anon, authenticated;

comment on table private.profile_name_pool is
  'Curated animal and plant names used only by the profile nickname trigger.';

comment on column private.profile_name_pool.kind is
  'Broad source category: animal or plant.';

comment on column private.profile_name_pool.name is
  'Simplified-Chinese base name without the generated letter suffix.';
