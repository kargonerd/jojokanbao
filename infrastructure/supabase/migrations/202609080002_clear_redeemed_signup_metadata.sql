-- GoTrue can update raw_user_meta_data again after the Auth INSERT trigger.
-- Once redemption is recorded, never retain a replayed invitation in metadata.
create or replace function private.clear_redeemed_signup_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from private.signup_invitation_redemptions where user_id = new.id
  ) then
    new.raw_user_meta_data := new.raw_user_meta_data - 'invitation_code';
  end if;
  return new;
end;
$$;

revoke all on function private.clear_redeemed_signup_metadata() from public, anon, authenticated;
drop trigger if exists clear_redeemed_signup_metadata on auth.users;
create trigger clear_redeemed_signup_metadata
before update of raw_user_meta_data on auth.users
for each row
when (new.raw_user_meta_data ? 'invitation_code')
execute function private.clear_redeemed_signup_metadata();

-- Preserve every unrelated metadata field and every existing redemption count.
update auth.users
set raw_user_meta_data = raw_user_meta_data - 'invitation_code'
where raw_user_meta_data ? 'invitation_code'
  and exists (
    select 1 from private.signup_invitation_redemptions where user_id = auth.users.id
  );
