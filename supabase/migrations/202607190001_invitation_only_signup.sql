-- Invitation-only account creation. Supabase Auth invokes the hook before it
-- inserts auth.users, so validation and redemption happen in one transaction.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin, service_role;
grant usage on schema public to supabase_auth_admin;
grant usage on schema extensions to supabase_auth_admin, service_role;
grant execute on function extensions.digest(bytea, text)
  to supabase_auth_admin, service_role;
grant execute on function extensions.gen_random_bytes(integer)
  to service_role;

create table if not exists private.signup_invitations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (char_length(code_hash) = 64),
  email text,
  expires_at timestamptz,
  max_uses integer not null default 1 check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  disabled_at timestamptz,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists private.signup_invitation_redemptions (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references private.signup_invitations (id) on delete restrict,
  user_id uuid not null,
  email text not null,
  redeemed_at timestamptz not null default timezone('utc', now()),
  unique (invitation_id, user_id)
);

comment on table private.signup_invitations is
  'Server-only signup invitations. Only a SHA-256 hash of each invitation code is stored.';
comment on table private.signup_invitation_redemptions is
  'Audit log for signup invitation redemption.';

revoke all on table private.signup_invitations from public, anon, authenticated;
revoke all on table private.signup_invitation_redemptions from public, anon, authenticated;
grant select, update on table private.signup_invitations to supabase_auth_admin;
grant insert on table private.signup_invitation_redemptions to supabase_auth_admin;
grant select, insert, update on table private.signup_invitations to service_role;
grant select on table private.signup_invitation_redemptions to service_role;

create or replace function private.normalize_signup_invitation_code(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(trim(coalesce(value, ''))), '[^a-z0-9]', '', 'g');
$$;

revoke execute on function private.normalize_signup_invitation_code(text)
  from public, anon, authenticated;
grant execute on function private.normalize_signup_invitation_code(text)
  to supabase_auth_admin, service_role;

create or replace function public.hook_require_signup_invitation(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  invitation_code text;
  normalized_code text;
  signup_email text;
  validated_invitation_id uuid;
begin
  invitation_code := event #>> '{user,user_metadata,invitation_code}';
  normalized_code := private.normalize_signup_invitation_code(invitation_code);
  signup_email := lower(trim(coalesce(event #>> '{user,email}', '')));

  if char_length(normalized_code) < 16 or signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code is required or invalid.'
      )
    );
  end if;

  select id into validated_invitation_id
  from private.signup_invitations
  where code_hash = encode(
      extensions.digest(convert_to(normalized_code, 'UTF8'), 'sha256'),
      'hex'
    )
    and disabled_at is null
    and (expires_at is null or expires_at > timezone('utc', now()))
    and use_count < max_uses
    and (email is null or lower(trim(email)) = signup_email);

  if validated_invitation_id is null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code is invalid or unavailable.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_require_signup_invitation(jsonb)
  to supabase_auth_admin;
revoke execute on function public.hook_require_signup_invitation(jsonb)
  from public, anon, authenticated;

-- Run this function from the SQL Editor or the repository invite CLI. The
-- plaintext code is returned once and is never stored in the database.
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
  random_hex text;
  normalized_code text;
  generated_id uuid;
  generated_expires_at timestamptz;
begin
  if p_max_uses < 1 then
    raise exception 'p_max_uses must be at least 1';
  end if;

  random_hex := upper(encode(extensions.gen_random_bytes(16), 'hex'));
  generated_code := 'JOJO-'
    || substr(random_hex, 1, 4) || '-'
    || substr(random_hex, 5, 4) || '-'
    || substr(random_hex, 9, 4) || '-'
    || substr(random_hex, 13, 4) || '-'
    || substr(random_hex, 17, 4) || '-'
    || substr(random_hex, 21, 4) || '-'
    || substr(random_hex, 25, 4) || '-'
    || substr(random_hex, 29, 4);
  normalized_code := private.normalize_signup_invitation_code(generated_code);
  generated_expires_at := case
    when p_expires_in is null then null
    else timezone('utc', now()) + p_expires_in
  end;

  insert into private.signup_invitations (
    code_hash,
    email,
    expires_at,
    max_uses,
    note
  ) values (
    encode(extensions.digest(convert_to(normalized_code, 'UTF8'), 'sha256'), 'hex'),
    nullif(lower(trim(p_email)), ''),
    generated_expires_at,
    p_max_uses,
    nullif(trim(p_note), '')
  )
  returning id into generated_id;

  return query select generated_code, generated_id, generated_expires_at;
end;
$$;

revoke execute on function private.create_signup_invitation(text, interval, integer, text)
  from public, anon, authenticated;
grant execute on function private.create_signup_invitation(text, interval, integer, text)
  to service_role;

create or replace function private.revoke_signup_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update private.signup_invitations
  set disabled_at = coalesce(disabled_at, timezone('utc', now()))
  where id = p_invitation_id;
  return found;
end;
$$;

revoke execute on function private.revoke_signup_invitation(uuid)
  from public, anon, authenticated;
grant execute on function private.revoke_signup_invitation(uuid)
  to service_role;

-- Do not retain the plaintext invite in user-editable user_metadata after the
-- hook has consumed it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  invitation_code text;
  normalized_code text;
  signup_email text;
  redeemed_invitation_id uuid;
begin
  invitation_code := new.raw_user_meta_data ->> 'invitation_code';
  normalized_code := private.normalize_signup_invitation_code(invitation_code);
  signup_email := lower(trim(coalesce(new.email, '')));

  update private.signup_invitations
  set use_count = use_count + 1
  where code_hash = encode(
      extensions.digest(convert_to(normalized_code, 'UTF8'), 'sha256'),
      'hex'
    )
    and disabled_at is null
    and (expires_at is null or expires_at > timezone('utc', now()))
    and use_count < max_uses
    and (email is null or lower(trim(email)) = signup_email)
  returning id into redeemed_invitation_id;

  if redeemed_invitation_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'Signup invitation could not be redeemed.';
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

  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 50), '')
  )
  on conflict (id) do nothing;

  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'invitation_code'
  where id = new.id;

  return new;
end;
$$;
