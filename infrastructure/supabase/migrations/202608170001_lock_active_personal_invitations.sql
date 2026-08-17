-- Keep an active personal invitation stable. Repeated generation requests are
-- idempotent; a new code is issued only after the previous code expires.
create or replace function public.generate_personal_signup_invitation()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_invitation private.signup_invitations%rowtype;
  generated_code text;
  generated_expires_at timestamptz := now() + interval '30 days';
begin
  if current_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

  select *
  into current_invitation
  from private.signup_invitations
  where kind = 'personal'
    and owner_user_id = current_user_id
  for update;

  if current_invitation.id is not null
    and current_invitation.disabled_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'Personal invitation has been disabled.';
  end if;

  if current_invitation.id is not null
    and current_invitation.use_count >= current_invitation.max_uses then
    raise exception using
      errcode = 'P0001',
      message = 'Personal invitation has already been redeemed.';
  end if;

  if current_invitation.id is not null
    and (
      current_invitation.expires_at is null
      or current_invitation.expires_at > now()
    ) then
    return query
      select current_invitation.code, current_invitation.expires_at;
    return;
  end if;

  loop
    generated_code := private.random_signup_invitation_code();
    if current_invitation.id is not null
      and generated_code = current_invitation.code then
      continue;
    end if;
    begin
      if current_invitation.id is null then
        insert into private.signup_invitations (
          code,
          kind,
          owner_user_id,
          expires_at,
          max_uses,
          note
        ) values (
          generated_code,
          'personal',
          current_user_id,
          generated_expires_at,
          1,
          'Personal invitation'
        )
        returning * into current_invitation;
      else
        update private.signup_invitations
        set code = generated_code,
            email = null,
            expires_at = generated_expires_at,
            max_uses = 1,
            use_count = 0,
            note = 'Personal invitation',
            updated_at = now()
        where id = current_invitation.id
        returning * into current_invitation;
      end if;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  return query
    select current_invitation.code, current_invitation.expires_at;
end;
$$;

revoke execute on function public.generate_personal_signup_invitation()
  from public, anon;
grant execute on function public.generate_personal_signup_invitation()
  to authenticated;
