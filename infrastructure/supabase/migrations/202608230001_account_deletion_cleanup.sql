-- Remove the deleted reader identifier from the private invitation audit log.
-- Profiles and Auth sessions already follow the auth.users cascade.
create or replace function private.cleanup_deleted_user_invitation_data()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  delete from private.signup_invitation_redemptions
  where user_id = old.id;
  return old;
end;
$$;

revoke execute on function private.cleanup_deleted_user_invitation_data()
  from public, anon, authenticated;

drop trigger if exists cleanup_deleted_user_invitation_data on auth.users;
create trigger cleanup_deleted_user_invitation_data
  after delete on auth.users
  for each row execute function private.cleanup_deleted_user_invitation_data();
