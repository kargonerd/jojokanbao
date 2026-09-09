-- Signup uses the existing audited feature configuration. Rules do not scope
-- this policy: every new Auth account reads the same invitationRequired value.
create function private.validate_signup_feature_config()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.key = 'auth.signup'
    and jsonb_typeof(new.config -> 'invitationRequired') is distinct from 'boolean'
  then
    raise invalid_parameter_value using message = 'Signup config invitationRequired must be a boolean';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_signup_feature_config() from public, anon, authenticated;
create trigger validate_signup_feature_config
  before insert or update of key, config on private.feature_flags
  for each row execute function private.validate_signup_feature_config();

with seed as (
  select private.feature_flag_normalize_rules(
    '[{"name":"全部新账号","conditionType":"global","serve":true,"enabled":true,"isFallback":true}]'::jsonb
  ) as rules
)
insert into private.feature_flags(key, description, rules, config, revision, history)
select 'auth.signup', '注册设置：是否需要邀请码', rules,
  '{"invitationRequired":false}'::jsonb, 2,
  jsonb_build_array(
    jsonb_build_object('revision', 1, 'rules', rules,
      'config', jsonb_build_object('invitationRequired', true),
      'reason', '保留原有邀请码注册设置', 'requestId', null, 'updatedAt', timezone('utc', now())),
    jsonb_build_object('revision', 2, 'rules', rules,
      'config', jsonb_build_object('invitationRequired', false),
      'reason', '暂时取消注册邀请码要求', 'requestId', null, 'updatedAt', timezone('utc', now()))
  )
from seed;

-- Expose only this public boolean, never raw configuration or operator data.
-- Missing or malformed configuration retains the previous invitation requirement.
create function public.signup_invitation_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (flag.config -> 'invitationRequired') is distinct from 'false'::jsonb
    from private.feature_flags flag where flag.key = 'auth.signup'
  ), true)
$$;
revoke all on function public.signup_invitation_required() from public;
grant execute on function public.signup_invitation_required()
  to anon, authenticated, service_role, supabase_auth_admin;


create or replace function public.hook_require_signup_invitation(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  normalized_code text;
  signup_email text;
  invitation_exists boolean;
begin
  if not public.signup_invitation_required() then
    return '{}'::jsonb;
  end if;

  normalized_code := private.normalize_signup_invitation_code(
    event #>> '{user,user_metadata,invitation_code}'
  );
  signup_email := lower(trim(coalesce(event #>> '{user,email}', '')));

  if char_length(normalized_code) <> 6 or signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invitation code is required or invalid.'
      )
    );
  end if;

  select exists (
    select 1
    from private.signup_invitations
    where code = normalized_code
      and disabled_at is null
      and (expires_at is null or expires_at > now())
      and use_count < max_uses
      and (email is null or lower(trim(email)) = signup_email)
  ) into invitation_exists;

  if not invitation_exists then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invitation code is invalid or unavailable.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

create or replace function private.redeem_signup_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text;
  signup_email text;
  redeemed_invitation_id uuid;
begin
  if not public.signup_invitation_required() then
    -- Older clients may still submit codes; open signup consumes no allocation.
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invitation_code';
    return new;
  end if;

  normalized_code := private.normalize_signup_invitation_code(
    new.raw_user_meta_data ->> 'invitation_code'
  );
  signup_email := lower(trim(coalesce(new.email, '')));

  update private.signup_invitations
  set use_count = use_count + 1,
      updated_at = now()
  where code = normalized_code
    and disabled_at is null
    and (expires_at is null or expires_at > now())
    and use_count < max_uses
    and (email is null or lower(trim(email)) = signup_email)
  returning id into redeemed_invitation_id;

  if redeemed_invitation_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'Invitation code could not be redeemed.';
  end if;

  insert into private.signup_invitation_redemptions (
    invitation_id,
    user_id,
    email
  ) values (
    redeemed_invitation_id,
    new.id,
    signup_email
  );

  new.raw_user_meta_data :=
    coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invitation_code';
  return new;
end;
$$;
