begin;
update private.feature_flags set config = config || '{"invitationRequired":true}'::jsonb
where key = 'auth.signup';
create extension if not exists pgtap with schema extensions;
select extensions.plan(4);
create temporary table metadata_cleanup_state as
select extensions.gen_random_uuid() as user_id, invitation.*
from private.create_signup_invitation(null, interval '1 hour', 1, 'Metadata cleanup test') invitation;

insert into auth.users(id, email, raw_user_meta_data)
select user_id, 'metadata-cleanup@example.invalid', jsonb_build_object('invitation_code', code)
from metadata_cleanup_state;

-- Reproduce the follow-up update made by the actual hosted Auth Admin API.
update auth.users u
set raw_user_meta_data = jsonb_build_object('invitation_code', s.code, 'keep', 'yes')
from metadata_cleanup_state s where u.id = s.user_id;

select extensions.is((select u.raw_user_meta_data from auth.users u join metadata_cleanup_state s on u.id=s.user_id),
  '{"keep":"yes"}'::jsonb, 'a post-signup metadata update cannot restore the redeemed invitation');
select extensions.is((select i.use_count from private.signup_invitations i join metadata_cleanup_state s on i.id=s.invitation_id),
  1, 'metadata cleanup never redeems a code again');
select extensions.is((select count(*) from private.signup_invitation_redemptions r join metadata_cleanup_state s on r.user_id=s.user_id),
  1::bigint, 'metadata cleanup leaves exactly one redemption');

update auth.users u set raw_user_meta_data = raw_user_meta_data || '{"another":"value"}'::jsonb
from metadata_cleanup_state s where u.id=s.user_id;
select extensions.is((select u.raw_user_meta_data from auth.users u join metadata_cleanup_state s on u.id=s.user_id),
  '{"keep":"yes","another":"value"}'::jsonb, 'ordinary user metadata updates continue to work');
select * from extensions.finish();
rollback;
