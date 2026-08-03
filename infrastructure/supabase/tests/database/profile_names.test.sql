begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(7);

select extensions.col_not_null(
  'public',
  'profiles',
  'display_name',
  'every profile has a display name'
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
select named_user_id, '  银杏  ' from profile_name_test_state;

select extensions.ok(
  (
    select pg_catalog.char_length(display_name) > 0
    from public.profiles
    where id = (select generated_user_id from profile_name_test_state)
  ),
  'a missing nickname is generated'
);

select extensions.is(
  (
    select display_name
    from public.profiles
    where id = (select named_user_id from profile_name_test_state)
  ),
  '银杏',
  'an explicit nickname is trimmed and preserved'
);

update public.profiles
set display_name = '   '
where id = (select named_user_id from profile_name_test_state);

select extensions.ok(
  (
    select pg_catalog.char_length(display_name) > 0
    from public.profiles
    where id = (select named_user_id from profile_name_test_state)
  ),
  'clearing a nickname generates a replacement'
);

select extensions.throws_ok(
  format(
    'update public.profiles set display_name = %L where id = %L',
    repeat('长', 51),
    (select named_user_id from profile_name_test_state)
  ),
  '23514',
  null,
  'nicknames longer than 50 characters are rejected'
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

select * from extensions.finish();

rollback;
