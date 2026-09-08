-- Recover hosted installations where the Auth redemption trigger was missing.
-- Serialize signup and invitation administration while reconstructing the ledger.
lock table auth.users in share row exclusive mode;
lock table private.signup_invitations in share row exclusive mode;
lock table private.signup_invitation_redemptions in share row exclusive mode;

do $$
begin
  if exists (
    select 1 from auth.users u
    left join private.signup_invitations i
      on i.code = private.normalize_signup_invitation_code(u.raw_user_meta_data ->> 'invitation_code')
    where u.raw_user_meta_data ? 'invitation_code'
      and (i.id is null or exists (
        select 1 from private.signup_invitation_redemptions r
        where r.user_id = u.id and r.invitation_id <> i.id
      ))
  ) then
    raise exception 'Cannot reconcile signup invitations: unmatched or conflicting legacy metadata.';
  end if;
end;
$$;

-- Only unrecorded users consume additional slots. Keep consumed slots whose
-- users were subsequently deleted; deletion intentionally removes ledger rows.
with missing as (
  select i.id, count(*)::integer as uses
  from auth.users u
  join private.signup_invitations i
    on i.code = private.normalize_signup_invitation_code(u.raw_user_meta_data ->> 'invitation_code')
  where not exists (
    select 1 from private.signup_invitation_redemptions r where r.user_id = u.id
  )
  group by i.id
), recorded as (
  select invitation_id, count(*)::integer as uses
  from private.signup_invitation_redemptions group by invitation_id
)
update private.signup_invitations i
set use_count = greatest(i.use_count, coalesce(r.uses, 0)) + coalesce(m.uses, 0),
    updated_at = now()
from (select id from missing union select invitation_id from recorded) affected
left join missing m on m.id = affected.id
left join recorded r on r.invitation_id = affected.id
where i.id = affected.id
  and i.use_count <> greatest(i.use_count, coalesce(r.uses, 0)) + coalesce(m.uses, 0);
-- The table's use_count <= max_uses constraint aborts the entire migration
-- on over-redemption. Never silently raise a code's allocation.

insert into private.signup_invitation_redemptions (invitation_id, user_id, email, redeemed_at)
select i.id, u.id, lower(trim(coalesce(u.email, ''))), u.created_at
from auth.users u
join private.signup_invitations i
  on i.code = private.normalize_signup_invitation_code(u.raw_user_meta_data ->> 'invitation_code')
where not exists (
  select 1 from private.signup_invitation_redemptions r where r.user_id = u.id
);

update auth.users u
set raw_user_meta_data = u.raw_user_meta_data - 'invitation_code'
where u.raw_user_meta_data ? 'invitation_code'
  and exists (select 1 from private.signup_invitation_redemptions r where r.user_id = u.id);

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


drop trigger if exists enforce_signup_invitation on auth.users;
create trigger enforce_signup_invitation
before insert on auth.users
for each row execute function private.redeem_signup_invitation();

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
