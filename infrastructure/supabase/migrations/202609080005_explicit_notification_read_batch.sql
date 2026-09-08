-- Mark only notification IDs that the reader has actually loaded.
-- Keep the legacy single/all RPC for existing clients.
create or replace function public.mark_my_notifications_read(p_notification_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := private.require_account_user();
  changed_count integer;
begin
  if p_notification_ids is null then
    raise invalid_parameter_value using message = 'Notification IDs are required';
  end if;
  if coalesce(pg_catalog.array_ndims(p_notification_ids), 1) <> 1 then
    raise invalid_parameter_value using message = 'Notification IDs must be a one-dimensional array';
  end if;
  if pg_catalog.cardinality(p_notification_ids) > 100 then
    raise invalid_parameter_value using message = 'At most 100 notification IDs are allowed';
  end if;
  if pg_catalog.array_position(p_notification_ids, null) is not null then
    raise invalid_parameter_value using message = 'Notification IDs must not contain null';
  end if;

  update public.user_notifications
  set read_at = timezone('utc', now())
  where recipient_id = account_id
    and read_at is null
    and id = any(p_notification_ids);
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.mark_my_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_my_notifications_read(uuid[]) to authenticated;

comment on function public.mark_my_notifications_read(uuid[]) is
  'Marks up to 100 explicit notification IDs as read for the authenticated recipient; unrequested and other recipients notifications remain unchanged.';
