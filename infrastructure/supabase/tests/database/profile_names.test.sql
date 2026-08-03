begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(14);

select extensions.col_not_null(
  'public',
  'profiles',
  'display_name',
  'every profile has a display name'
);

select extensions.is(
  (select pg_catalog.count(*) from private.profile_name_pool),
  3000::bigint,
  'the private pool contains 3,000 base names'
);

select extensions.is(
  (
    select pg_catalog.count(*)
    from private.profile_name_pool
    where kind = 'animal'
  ),
  1500::bigint,
  'half of the pool contains animal names'
);

select extensions.is(
  (
    select pg_catalog.count(*)
    from private.profile_name_pool
    where kind = 'plant'
  ),
  1500::bigint,
  'half of the pool contains plant names'
);

select extensions.ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'private.profile_name_pool',
    'select'
  ),
  'browser users cannot read the private source pool'
);

create temporary table profile_name_test_state (
  generated_user_id uuid not null default extensions.gen_random_uuid(),
  named_user_id uuid not null default extensions.gen_random_uuid()
);
insert into profile_name_test_state default values;

set local session_replication_role = replica;
insert into auth.users (id, email, raw_user_meta_data)
select generated_user_id, 'generated-name@example.invalid', '{}'::jsonb
from profile_name_test_state
union all
select named_user_id, 'named-reader@example.invalid', '{}'::jsonb
from profile_name_test_state;
set local session_replication_role = origin;

insert into public.profiles (id)
select generated_user_id from profile_name_test_state;

insert into public.profiles (id, display_name)
select named_user_id, '不应保留的昵称' from profile_name_test_state;

select extensions.ok(
  (
    select
      profile.display_name ~ '^[^-]+-[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}$'
      and exists (
        select 1
        from private.profile_name_pool as pool
        where pool.name = pg_catalog.split_part(profile.display_name, '-', 1)
      )
    from public.profiles as profile
    where profile.id = (
      select generated_user_id
      from profile_name_test_state
    )
  ),
  'a missing nickname is generated from the pool with a three-letter suffix'
);

select extensions.ok(
  (
    select
      profile.display_name <> '不应保留的昵称'
      and profile.display_name ~ '^[^-]+-[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}$'
      and exists (
        select 1
        from private.profile_name_pool as pool
        where pool.name = pg_catalog.split_part(profile.display_name, '-', 1)
      )
    from public.profiles as profile
    where profile.id = (
      select named_user_id
      from profile_name_test_state
    )
  ),
  'the database ignores a client-supplied nickname'
);

select extensions.ok(
  (
    select pg_catalog.count(*) = pg_catalog.count(distinct display_name)
    from public.profiles
    where id in (
      select generated_user_id from profile_name_test_state
      union all
      select named_user_id from profile_name_test_state
    )
  ),
  'generated nicknames are unique'
);

select extensions.ok(
  not pg_catalog.has_column_privilege(
    'authenticated',
    'public.profiles',
    'display_name',
    'update'
  ),
  'browser users cannot update generated nicknames'
);

select extensions.ok(
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.profiles',
    'avatar_path',
    'update'
  ),
  'browser users retain the future avatar update permission'
);

select extensions.throws_ok(
  format(
    'update public.profiles set display_name = %L where id = %L',
    '雪豹-IOO',
    (select named_user_id from profile_name_test_state)
  ),
  '23514',
  null,
  'nicknames outside the generated format are rejected'
);

select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'private.random_profile_display_name()',
    'execute'
  ),
  'browser users cannot call the private generator directly'
);

select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.ensure_profile_display_name()',
    'execute'
  ),
  'browser users cannot call the trigger function directly'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_index as index_definition
    where index_definition.indrelid = 'public.profiles'::regclass
      and index_definition.indisunique
      and index_definition.indexrelid =
        'public.profiles_display_name_unique'::regclass
  ),
  'the database enforces display-name uniqueness'
);

select * from extensions.finish();

rollback;
