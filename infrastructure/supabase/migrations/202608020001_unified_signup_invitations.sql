-- Store administrator and personal signup invitations in one unified private table.
--
-- Invitation signup has not launched yet, so existing invitation rows are test
-- data. Clearing them lets us replace the digest-only model without carrying a
-- second compatibility path. Auth users are not changed.

drop table if exists private.personal_invitation_owners;

delete from private.signup_invitation_redemptions;
delete from private.signup_invitations;

alter table private.signup_invitations
  drop column code_hash,
  add column code text not null,
  add column kind text not null default 'admin',
  add column owner_user_id uuid references auth.users (id) on delete set null,
  add column updated_at timestamptz not null default timezone('utc', now()),
  add constraint signup_invitations_code_format
    check (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'),
  add constraint signup_invitations_code_key unique (code),
  add constraint signup_invitations_kind_check
    check (kind in ('admin', 'personal')),
  add constraint signup_invitations_owner_kind_check
    check (kind = 'personal' or owner_user_id is null);

create unique index signup_invitations_personal_owner_key
  on private.signup_invitations (owner_user_id)
  where kind = 'personal' and owner_user_id is not null;

comment on table private.signup_invitations is
  'Server-only administrator and personal signup invitations.';
comment on column private.signup_invitations.code is
  'Six-character plaintext code. Never expose this table to browser roles.';
comment on column private.signup_invitations.owner_user_id is
  'Account that owns a personal invitation; null for administrator invitations.';

create or replace function private.normalize_signup_invitation_code(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(
    trim(coalesce(value, '')),
    '[^a-zA-Z0-9]',
    '',
    'g'
  ));
$$;

create or replace function private.random_signup_invitation_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  random_bytes bytea := extensions.gen_random_bytes(6);
  generated_code text := '';
  byte_index integer;
begin
  for byte_index in 0..5 loop
    generated_code := generated_code || substr(
      alphabet,
      (get_byte(random_bytes, byte_index) % 32) + 1,
      1
    );
  end loop;
  return generated_code;
end;
$$;

revoke execute on function private.random_signup_invitation_code()
  from public, anon, authenticated;
grant execute on function private.random_signup_invitation_code()
  to service_role;

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

-- This trigger remains the authoritative redemption boundary. The conditional
-- update serializes concurrent attempts and rolls back if Auth cannot create
-- the user.
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

-- Keep profile creation separate from invitation redemption. Replacing this
-- function also removes any pre-migration hosted definition that still reads
-- the retired code_hash column.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 50), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Administrator-only creation through the service role.
create or replace function private.create_signup_invitation(
  p_email text default null,
  p_expires_in interval default interval '7 days',
  p_max_uses integer default 1,
  p_note text default null
)
returns table (code text, invitation_id uuid, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  generated_code text;
  generated_id uuid;
  generated_expires_at timestamptz;
begin
  if p_max_uses < 1 then
    raise exception 'p_max_uses must be at least 1';
  end if;
  if p_expires_in is not null and p_expires_in <= interval '0 seconds' then
    raise exception 'p_expires_in must be positive';
  end if;

  generated_expires_at := case
    when p_expires_in is null then null
    else now() + p_expires_in
  end;

  loop
    generated_code := private.random_signup_invitation_code();
    begin
      insert into private.signup_invitations (
        code,
        kind,
        email,
        expires_at,
        max_uses,
        note
      ) values (
        generated_code,
        'admin',
        nullif(lower(trim(p_email)), ''),
        generated_expires_at,
        p_max_uses,
        nullif(trim(p_note), '')
      )
      returning id into generated_id;
      exit;
    exception when unique_violation then
      -- A collision is extremely unlikely, but generating again is cheap.
      null;
    end;
  end loop;

  return query
    select generated_code, generated_id, generated_expires_at;
end;
$$;

create or replace function private.revoke_signup_invitation(
  p_invitation_id uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update private.signup_invitations
  set disabled_at = coalesce(disabled_at, now()),
      updated_at = now()
  where id = p_invitation_id;
  return found;
end;
$$;

-- Auth deletes null the foreign key after this trigger runs. Disable the code
-- first so a deleted account can never leave a usable orphan invitation.
create or replace function private.disable_personal_invitation_before_account_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.signup_invitations
  set disabled_at = coalesce(disabled_at, now()),
      updated_at = now()
  where kind = 'personal'
    and owner_user_id = old.id;
  return old;
end;
$$;

revoke execute on function private.disable_personal_invitation_before_account_delete()
  from public, anon, authenticated;

drop trigger if exists disable_personal_invitation_before_account_delete
  on auth.users;
create trigger disable_personal_invitation_before_account_delete
  before delete on auth.users
  for each row execute function
    private.disable_personal_invitation_before_account_delete();

-- A personal invitation is one row owned by one account. Regeneration rotates
-- that row while it is unused; redemption permanently consumes the allocation.
create or replace function public.get_personal_invitation_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when invitation.id is null then
      jsonb_build_object('allocated', false, 'redeemed', false)
    else
      jsonb_build_object(
        'allocated', true,
        'code', invitation.code,
        'redeemed', invitation.use_count >= invitation.max_uses,
        'expires_at', invitation.expires_at,
        'disabled', invitation.disabled_at is not null
      )
  end
  from (select auth.uid() as user_id) as viewer
  left join private.signup_invitations as invitation
    on invitation.kind = 'personal'
    and invitation.owner_user_id = viewer.user_id;
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

  -- Also serializes first-time generation, when no invitation row exists yet.
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
      -- Retry only the generated code; ownership is already serialized.
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
