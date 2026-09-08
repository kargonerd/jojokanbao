begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(9);

create temporary table repair_test_state as
select extensions.gen_random_uuid() as first_id,
  extensions.gen_random_uuid() as second_id,
  extensions.gen_random_uuid() as third_id,
  extensions.gen_random_uuid() as recorded_id,
  extensions.gen_random_uuid() as final_id;

-- Reproduce the hosted drift rather than testing only a fresh installation.
drop trigger if exists enforce_signup_invitation on auth.users;
insert into private.signup_invitations (code, kind, max_uses, use_count, expires_at)
values ('RPR222', 'admin', 3, 0, now() - interval '1 day'),
       ('RPR333', 'admin', 5, 2, now() + interval '1 day');
insert into auth.users(id, email, raw_user_meta_data, created_at)
select first_id, 'repair-one@example.invalid', '{"invitation_code":"rpr222","keep":"yes"}'::jsonb, now() from repair_test_state
union all select second_id, 'repair-two@example.invalid', '{"invitation_code":"RPR222"}', now() from repair_test_state
union all select third_id, 'repair-three@example.invalid', '{"invitation_code":"RPR333"}', now() from repair_test_state
union all select recorded_id, 'repair-recorded@example.invalid', '{"invitation_code":"RPR333"}', now() from repair_test_state;
insert into private.signup_invitation_redemptions(invitation_id, user_id, email)
select i.id, s.recorded_id, 'repair-recorded@example.invalid'
from private.signup_invitations i cross join repair_test_state s where i.code = 'RPR333';

-- pg_prove mounts only the tests directory. Replay the exact applied migration
-- from the CLI's history rather than depending on files outside that mount.
create function pg_temp.replay_invitation_repair() returns void language plpgsql as $$
declare statement text;
begin
  if not exists (select 1 from supabase_migrations.schema_migrations
    where version = '202609080001' and cardinality(statements) > 0) then
    raise exception 'Invitation repair migration history is missing';
  end if;
  for statement in select unnest(statements) from supabase_migrations.schema_migrations
    where version = '202609080001'
  loop
    execute statement;
  end loop;
end;
$$;
do $$ begin perform pg_temp.replay_invitation_repair(); end $$;

select extensions.is((select use_count from private.signup_invitations where code = 'RPR222'), 2,
  'historical accounts are counted even after their invitation expires');
select extensions.is((select use_count from private.signup_invitations where code = 'RPR333'), 3,
  'repair preserves a consumed slot whose user was deleted and counts only missing redemptions');
select extensions.is((select count(*) from private.signup_invitation_redemptions r
  join private.signup_invitations i on i.id = r.invitation_id where i.code in ('RPR222','RPR333')), 4::bigint,
  'repair records each legacy user once');
select extensions.is((select raw_user_meta_data from auth.users where id = (select first_id from repair_test_state)),
  '{"keep":"yes"}'::jsonb, 'repair removes invitation metadata without removing other metadata');
select extensions.ok(exists(select 1 from pg_trigger where tgrelid = 'auth.users'::regclass
  and tgname = 'enforce_signup_invitation' and tgenabled = 'O'), 'the redemption trigger is enabled');

do $$ begin perform pg_temp.replay_invitation_repair(); end $$;

select extensions.is((select sum(use_count)::bigint from private.signup_invitations where code in ('RPR222','RPR333')),
  5::bigint, 'running reconciliation again does not consume additional slots');
select extensions.throws_ok($sql$insert into auth.users(id,email,raw_user_meta_data)
  values(extensions.gen_random_uuid(), 'repair-no-invite@example.invalid', '{}')$sql$,
  'P0001', 'Invitation code could not be redeemed.', 'bypassing the hosted hook fails closed');

update private.signup_invitations set max_uses = 4 where code = 'RPR333';
insert into auth.users(id,email,raw_user_meta_data)
select final_id, 'repair-final@example.invalid', '{"invitation_code":"RPR333"}' from repair_test_state;
select extensions.is((select use_count from private.signup_invitations where code = 'RPR333'), 4,
  'the restored trigger consumes the final available slot');
select extensions.throws_ok($sql$insert into auth.users(id,email,raw_user_meta_data)
  values(extensions.gen_random_uuid(), 'repair-exhausted@example.invalid', '{"invitation_code":"RPR333"}')$sql$,
  'P0001', 'Invitation code could not be redeemed.', 'a full invitation rejects another user');

select * from extensions.finish();
rollback;
