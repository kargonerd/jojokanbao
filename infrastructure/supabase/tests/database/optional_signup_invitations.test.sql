begin;
-- Exercise legacy policy publication; server policy reads are shared with the PostHog cache.
update private.feature_flags set config_provider = 'supabase' where key = 'auth.signup';
create extension if not exists pgtap with schema extensions;
select extensions.plan(24);

create temporary table signup_policy_test_state as
select extensions.gen_random_uuid() as open_id,
  extensions.gen_random_uuid() as stale_id,
  extensions.gen_random_uuid() as invited_id,
  extensions.gen_random_uuid() as reopened_id,
  invitation.*
from private.create_signup_invitation(null, interval '1 hour', 1, 'Signup policy test') invitation;

insert into private.feature_flag_operator_secret(singleton, token_digest)
values (true, extensions.digest(repeat('s', 32), 'sha256'));

set local role anon;
select extensions.is(public.signup_invitation_required(), false, 'anonymous clients see open registration');
reset role;
select extensions.ok(not pg_catalog.has_table_privilege('anon', 'private.feature_flags', 'select'),
  'public policy access does not expose raw configuration');
-- Supabase's test connection cannot SET ROLE to its managed Auth administrator.
-- Check that role's actual grant separately from exercising the hook behavior.
select extensions.ok(pg_catalog.has_function_privilege('supabase_auth_admin',
  'public.signup_invitation_required()', 'execute'), 'the Auth hook role can read the signup policy');
select extensions.is(public.hook_require_signup_invitation('{"user":{"email":"open@example.invalid"}}'),
  '{}'::jsonb, 'the Auth hook permits signup without a code');
select extensions.is(public.hook_require_signup_invitation('{"user":{"email":"open@example.invalid","user_metadata":{"invitation_code":"invalid"}}}'),
  '{}'::jsonb, 'open signup ignores invalid codes from older clients');

insert into auth.users(id, email, raw_user_meta_data)
select open_id, 'policy-open@example.invalid', '{"keep":"yes"}'::jsonb from signup_policy_test_state
union all
select stale_id, 'policy-stale@example.invalid', jsonb_build_object('invitation_code', code, 'keep', 'yes') from signup_policy_test_state;
select extensions.is((select count(*) from public.profiles where id in
  (select open_id from signup_policy_test_state union all select stale_id from signup_policy_test_state)),
  2::bigint, 'open signup still creates reader profiles');
select extensions.is((select use_count from private.signup_invitations where id = (select invitation_id from signup_policy_test_state)),
  0, 'open signup does not consume an existing invitation');
select extensions.is((select count(*) from private.signup_invitation_redemptions where user_id in
  (select open_id from signup_policy_test_state union all select stale_id from signup_policy_test_state)),
  0::bigint, 'open signup does not create invitation redemption records');
select extensions.is((select raw_user_meta_data from auth.users where id = (select stale_id from signup_policy_test_state)),
  '{"keep":"yes"}'::jsonb, 'ignored invitation metadata is removed without losing other metadata');

do $$ begin
  perform public.operator_publish_feature_flag(repeat('s', 32), 'auth.signup',
    (select rules from private.feature_flags where key = 'auth.signup'),
    '{"invitationRequired":true}', 2, 'Restore invitation signup', null);
end $$;
select extensions.is(public.signup_invitation_required(), true, 'operator publication restores invitation signup');
select extensions.is((select revision from private.feature_flags where key = 'auth.signup'),
  3::bigint, 'restoring signup uses the existing revision history');
select extensions.throws_ok($sql$select public.operator_publish_feature_flag(repeat('s', 32), 'auth.signup',
  (select rules from private.feature_flags where key = 'auth.signup'),
  '{"invitationRequired":"false"}', 3, 'Invalid configuration', null)$sql$,
  '22023', 'Signup config invitationRequired must be a boolean', 'operator writes reject string booleans');
select extensions.throws_ok($sql$update private.feature_flags set config = '{}' where key = 'auth.signup'$sql$,
  '22023', 'Signup config invitationRequired must be a boolean', 'direct writes reject missing configuration');

-- Rollout rules cannot accidentally disable the required signup policy.
update private.feature_flags set rules = '[]' where key = 'auth.signup';
select extensions.is(public.signup_invitation_required(), true, 'invitation policy is independent of rollout rules');
select extensions.ok(public.hook_require_signup_invitation('{"user":{"email":"blocked@example.invalid"}}') ? 'error',
  'restored hook rejects missing invitation codes');
select extensions.is(public.hook_require_signup_invitation(jsonb_build_object('user', jsonb_build_object(
  'email', 'policy-invited@example.invalid', 'user_metadata', jsonb_build_object('invitation_code',
  (select code from signup_policy_test_state))))), '{}'::jsonb, 'restored hook accepts an existing valid code');
select extensions.throws_ok($sql$insert into auth.users(id,email,raw_user_meta_data)
  values(extensions.gen_random_uuid(), 'policy-blocked@example.invalid', '{}')$sql$,
  'P0001', 'Invitation code could not be redeemed.', 'bypassing the restored hook is still rejected by the trigger');

insert into auth.users(id, email, raw_user_meta_data)
select invited_id, 'policy-invited@example.invalid', jsonb_build_object('invitation_code', code) from signup_policy_test_state;
select extensions.is((select use_count from private.signup_invitations where id = (select invitation_id from signup_policy_test_state)),
  1, 'the retained invitation is redeemed after restoring the requirement');
select extensions.is((select count(*) from private.signup_invitation_redemptions where user_id = (select invited_id from signup_policy_test_state)),
  1::bigint, 'restored signup records exactly one redemption');
select extensions.throws_ok($sql$insert into auth.users(id,email,raw_user_meta_data)
  select extensions.gen_random_uuid(), 'policy-duplicate@example.invalid', jsonb_build_object('invitation_code', code)
  from signup_policy_test_state$sql$,
  'P0001', 'Invitation code could not be redeemed.', 'a used invitation cannot be reused');

do $$ begin
  perform public.operator_rollback_feature_flag(repeat('s', 32), 'auth.signup', 2, 3, null);
end $$;
select extensions.is(public.signup_invitation_required(), false, 'operator rollback reopens signup');
insert into auth.users(id, email, raw_user_meta_data)
select reopened_id, 'policy-reopened@example.invalid', jsonb_build_object('invitation_code', code) from signup_policy_test_state;
select extensions.is((select use_count from private.signup_invitations where id = (select invitation_id from signup_policy_test_state)),
  1, 'reopening signup neither consumes nor resets a used invitation');
select extensions.is((select count(*) from private.signup_invitation_redemptions where user_id = (select invited_id from signup_policy_test_state)),
  1::bigint, 'policy rollback preserves the existing redemption history');

delete from private.feature_flags where key = 'auth.signup';
select extensions.is(public.signup_invitation_required(), true, 'missing policy retains the invitation requirement');

select * from extensions.finish();
rollback;
