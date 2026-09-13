begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(8);
\ir ../signup-fixture.inc

select extensions.hasnt_table('private','feature_flags','PostHog configuration has no database copy');
select extensions.is(public.hook_require_signup_invitation(jsonb_build_object('user',jsonb_build_object(
  'email','open@example.invalid','user_metadata',pg_temp.signup_metadata('open@example.invalid','',false)
))), '{}'::jsonb, 'the server can authorize open signup');
select extensions.throws_ok($sql$ select private.signup_authorization_required('open@example.invalid','{"invitationRequired":false}') $sql$,
 '42501','Registration authorization is invalid or expired. Please retry signup.','client values cannot authorize signup');
select extensions.throws_ok($sql$ select private.signup_authorization_required('another@example.invalid',pg_temp.signup_metadata('open@example.invalid','',false)) $sql$,
 '42501','Registration authorization is invalid or expired. Please retry signup.','a signed authorization cannot change email');
select extensions.throws_ok($sql$ select private.signup_authorization_required('open@example.invalid',
 pg_temp.signup_metadata('open@example.invalid','',false)||'{"invitation_code":"ABC234"}') $sql$,
 '42501','Registration authorization is invalid or expired. Please retry signup.','a signed authorization cannot change the invitation code');
insert into auth.users(id,email,raw_user_meta_data) values (extensions.gen_random_uuid(),'open@example.invalid',
 pg_temp.signup_metadata('open@example.invalid','',false)||'{"keep":"yes"}');
select extensions.is((select raw_user_meta_data from auth.users where email='open@example.invalid'),'{"keep":"yes"}'::jsonb,'successful registration removes the authorization');
select extensions.throws_ok($sql$ insert into auth.users(id,email,raw_user_meta_data) values(extensions.gen_random_uuid(),
 'missing-code@example.invalid',pg_temp.signup_metadata('missing-code@example.invalid','',true)) $sql$,
 'P0001','Invitation code could not be redeemed.','required invitations cannot be bypassed at insert');
select extensions.ok(not has_function_privilege('authenticated','private.signup_authorization_required(text,jsonb)','execute'),
 'clients cannot access the authorization verifier');
select * from extensions.finish();
rollback;
