begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(23);

select extensions.has_column(
  'private',
  'signup_invitations',
  'code',
  'invitations store the retrievable code'
);
select extensions.has_column(
  'private',
  'signup_invitations',
  'kind',
  'invitations identify their kind'
);
select extensions.has_column(
  'private',
  'signup_invitations',
  'owner_user_id',
  'personal invitations identify their owner'
);
select extensions.hasnt_column(
  'private',
  'signup_invitations',
  'code_hash',
  'the obsolete digest column is removed'
);

select extensions.ok(
  not pg_catalog.has_table_privilege(
    'anon',
    'private.signup_invitations',
    'select'
  ),
  'anonymous users cannot read invitation codes'
);
select extensions.ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'private.signup_invitations',
    'select'
  ),
  'authenticated users cannot read the private invitation table'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.get_personal_invitation_status()',
    'execute'
  ),
  'anonymous users cannot read personal invitation status'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_personal_invitation_status()',
    'execute'
  ),
  'authenticated users can read their own invitation status'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.generate_personal_signup_invitation()',
    'execute'
  ),
  'anonymous users cannot generate personal invitations'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.generate_personal_signup_invitation()',
    'execute'
  ),
  'authenticated users can generate their own invitation'
);

create temporary table invitation_test_state (
  owner_id uuid not null default extensions.gen_random_uuid(),
  deleted_owner_id uuid not null default extensions.gen_random_uuid(),
  invited_user_id uuid not null default extensions.gen_random_uuid(),
  admin_id uuid,
  admin_code text,
  personal_id uuid,
  first_code text,
  second_code text,
  third_code text
);
insert into invitation_test_state default values;

with generated as (
  select *
  from private.create_signup_invitation(
    null,
    interval '7 days',
    1,
    'Database contract test'
  )
)
update invitation_test_state
set admin_id = generated.invitation_id,
    admin_code = generated.code
from generated;

select extensions.ok(
  (
    select admin_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'
      and exists (
        select 1
        from private.signup_invitations
        where id = invitation_test_state.admin_id
          and kind = 'admin'
          and owner_user_id is null
      )
    from invitation_test_state
  ),
  'administrator invitations use the unified plaintext table'
);

select extensions.is(
  public.hook_require_signup_invitation(
    (
      select jsonb_build_object(
        'user',
        jsonb_build_object(
          'email',
          'invited@example.invalid',
          'user_metadata',
          jsonb_build_object('invitation_code', lower(admin_code))
        )
      )
      from invitation_test_state
    )
  ),
  '{}'::jsonb,
  'the Auth hook accepts a valid code case-insensitively'
);

-- These users only provide foreign-key owners for the personal invitation RPC.
-- Disable Auth insert triggers so the setup does not itself require invitations.
set local session_replication_role = replica;
insert into auth.users (id, email, raw_user_meta_data)
select owner_id, 'owner@example.invalid', '{}'::jsonb
from invitation_test_state
union all
select deleted_owner_id, 'deleted-owner@example.invalid', '{}'::jsonb
from invitation_test_state;
set local session_replication_role = origin;

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select owner_id::text from invitation_test_state),
    true
  );
end;
$$;

select extensions.is(
  (public.get_personal_invitation_status() ->> 'allocated')::boolean,
  false,
  'a new account starts without a personal invitation'
);

with generated as (
  select * from public.generate_personal_signup_invitation()
)
update invitation_test_state
set first_code = generated.code
from generated;

update invitation_test_state
set personal_id = invitation.id
from private.signup_invitations as invitation
where invitation.kind = 'personal'
  and invitation.owner_user_id = invitation_test_state.owner_id;

select extensions.matches(
  (select first_code from invitation_test_state),
  '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$',
  'personal generation returns a six-character code'
);
select extensions.is(
  public.get_personal_invitation_status() ->> 'code',
  (select first_code from invitation_test_state),
  'the owner can retrieve the existing plaintext code'
);

with generated as (
  select * from public.generate_personal_signup_invitation()
)
update invitation_test_state
set second_code = generated.code
from generated;

select extensions.is(
  (select first_code from invitation_test_state),
  (select second_code from invitation_test_state),
  'repeated generation keeps an active code stable'
);
select extensions.is(
  (
    select count(*)
    from private.signup_invitations
    where kind = 'personal'
      and owner_user_id = (
        select owner_id from invitation_test_state
      )
  ),
  1::bigint,
  'repeated generation keeps one personal invitation row'
);

update private.signup_invitations
set expires_at = now() - interval '1 minute'
where id = (select personal_id from invitation_test_state);

with generated as (
  select * from public.generate_personal_signup_invitation()
)
update invitation_test_state
set third_code = generated.code
from generated;

select extensions.isnt(
  (select first_code from invitation_test_state),
  (select third_code from invitation_test_state),
  'an expired invitation can be regenerated'
);

select extensions.ok(
  private.revoke_signup_invitation(
    (select personal_id from invitation_test_state)
  ),
  'an administrator can revoke a personal invitation'
);
select extensions.is(
  (public.get_personal_invitation_status() ->> 'disabled')::boolean,
  true,
  'revocation is visible to the owner'
);
select extensions.throws_ok(
  'select * from public.generate_personal_signup_invitation()',
  'P0001',
  'Personal invitation has been disabled.',
  'an owner cannot undo administrator revocation'
);

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select deleted_owner_id::text from invitation_test_state),
    true
  );
  perform * from public.generate_personal_signup_invitation();
end;
$$;
delete from auth.users
where id = (select deleted_owner_id from invitation_test_state);

select extensions.ok(
  exists (
    select 1
    from private.signup_invitations
    where kind = 'personal'
      and owner_user_id is null
      and disabled_at is not null
      and use_count < max_uses
  ),
  'deleting an owner disables the orphaned personal invitation'
);

insert into auth.users (id, email, raw_user_meta_data)
select
  invited_user_id,
  'invited@example.invalid',
  jsonb_build_object('invitation_code', admin_code)
from invitation_test_state;

select extensions.ok(
  (
    select invitation.use_count = 1
      and redemption.user_id = invitation_test_state.invited_user_id
      and not coalesce(auth_user.raw_user_meta_data, '{}'::jsonb)
        ? 'invitation_code'
    from invitation_test_state
    join private.signup_invitations as invitation
      on invitation.id = invitation_test_state.admin_id
    join private.signup_invitation_redemptions as redemption
      on redemption.invitation_id = invitation.id
    join auth.users as auth_user
      on auth_user.id = invitation_test_state.invited_user_id
    where exists (
      select 1
      from public.profiles
      where id = invitation_test_state.invited_user_id
    )
  ),
  'Auth insertion atomically redeems the code, creates a profile, and removes signup metadata'
);

select * from extensions.finish();

rollback;
