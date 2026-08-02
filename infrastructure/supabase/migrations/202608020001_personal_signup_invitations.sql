-- Give every authenticated account one lifetime invitation allocation.
-- An unused code may be rotated, but a redeemed allocation cannot be reset.

create table private.personal_invitation_owners (
  user_id uuid primary key references auth.users (id) on delete cascade,
  invitation_id uuid not null unique
    references private.signup_invitations (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table private.personal_invitation_owners is
  'Maps each account to its single lifetime invitation allocation.';

revoke all on table private.personal_invitation_owners
  from public, anon, authenticated;

create or replace function public.get_personal_invitation_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then
      jsonb_build_object('allocated', false, 'redeemed', false)
    when invitation.id is null then
      jsonb_build_object('allocated', false, 'redeemed', false)
    else
      jsonb_build_object(
        'allocated', true,
        'redeemed', invitation.use_count >= invitation.max_uses,
        'expires_at', invitation.expires_at,
        'disabled', invitation.disabled_at is not null
      )
  end
  from (select 1) as singleton
  left join private.personal_invitation_owners as owner
    on owner.user_id = auth.uid()
  left join private.signup_invitations as invitation
    on invitation.id = owner.invitation_id;
$$;

revoke execute on function public.get_personal_invitation_status()
  from public, anon;
grant execute on function public.get_personal_invitation_status()
  to authenticated;

create or replace function public.generate_personal_signup_invitation()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  current_invitation private.signup_invitations%rowtype;
  generated record;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication is required.';
  end if;

  -- Serialize first-time generation too, when no owner row exists to lock yet.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

  select invitation.*
  into current_invitation
  from private.personal_invitation_owners as owner
  join private.signup_invitations as invitation
    on invitation.id = owner.invitation_id
  where owner.user_id = current_user_id
  for update of owner, invitation;

  if current_invitation.id is not null
    and current_invitation.use_count >= current_invitation.max_uses then
    raise exception using
      errcode = 'P0001',
      message = 'Personal invitation has already been redeemed.';
  end if;

  if current_invitation.id is not null then
    update private.signup_invitations
    set disabled_at = coalesce(disabled_at, now())
    where id = current_invitation.id;
  end if;

  select *
  into generated
  from private.create_signup_invitation(
    null,
    interval '30 days',
    1,
    'Personal invitation'
  );

  insert into private.personal_invitation_owners (
    user_id,
    invitation_id
  ) values (
    current_user_id,
    generated.invitation_id
  )
  on conflict (user_id) do update
    set invitation_id = excluded.invitation_id,
        updated_at = now();

  return query select generated.code, generated.expires_at;
end;
$$;

revoke execute on function public.generate_personal_signup_invitation()
  from public, anon;
grant execute on function public.generate_personal_signup_invitation()
  to authenticated;
