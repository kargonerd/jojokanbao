-- Member role management for the admin workbench. Roles live in each Auth
-- account's raw_app_meta_data.jojo_roles; only the server API key may call
-- these RPCs, and every change is audited like the moderation actions.

create or replace function public.admin_list_members(
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 200 or p_offset < 0 then
    raise invalid_parameter_value using message = 'Member list paging is invalid';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', account.id,
      'email', account.email::text,
      'displayName', profile.display_name,
      'roles', coalesce(account.raw_app_meta_data->'jojo_roles', '[]'::jsonb),
      'createdAt', account.created_at
    ) order by account.created_at desc)
    from auth.users account
    left join public.profiles profile on profile.id = account.id
    where p_query is null
      or account.email ilike '%' || p_query || '%'
      or coalesce(profile.display_name, '') ilike '%' || p_query || '%'
    limit least(200, greatest(1, p_limit))
    offset greatest(0, p_offset)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_change_member_role(
  p_actor_id uuid,
  p_account_id uuid,
  p_mode text,
  p_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  known_roles text[] := array['admin', 'moderator', 'editorial', 'librarian'];
  current_roles jsonb;
  next_roles jsonb;
begin
  if p_actor_id is null then
    raise insufficient_privilege;
  end if;
  if p_mode not in ('grant', 'revoke') then
    raise invalid_parameter_value using message = 'Unknown role change mode';
  end if;
  if not (p_role = any(known_roles)) then
    raise invalid_parameter_value using message = 'Unknown role';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 500 then
    raise invalid_parameter_value using message = 'Role change reason is required';
  end if;
  if p_actor_id = p_account_id then
    raise invalid_parameter_value using message = 'You cannot change your own roles';
  end if;

  select coalesce(raw_app_meta_data->'jojo_roles', '[]'::jsonb)
    into current_roles
    from auth.users account
    where account.id = p_account_id
    for update;
  if not found then
    raise no_data_found using message = 'Account not found';
  end if;

  if p_mode = 'grant' then
    if current_roles ? p_role then
      raise invalid_parameter_value using message = 'Account already has this role';
    end if;
    next_roles := current_roles || to_jsonb(p_role::text);
  else
    if not current_roles ? p_role then
      raise invalid_parameter_value using message = 'Account does not have this role';
    end if;
    next_roles := (
      select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
      from jsonb_array_elements(current_roles) with ordinality as entry(value, ordinality)
      where entry.value <> to_jsonb(p_role::text)
    );
  end if;

  update auth.users account
    set raw_app_meta_data = case
      when jsonb_array_length(next_roles) = 0 then coalesce(raw_app_meta_data, '{}'::jsonb) - 'jojo_roles'
      else jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{jojo_roles}', next_roles)
    end
    where account.id = p_account_id;

  insert into private.admin_actions(actor_id, action, target_id, reason)
    values (p_actor_id, 'member.role.' || p_mode, p_account_id,
      p_role || '：' || left(btrim(p_reason), 500));

  return jsonb_build_object(
    'accountId', p_account_id,
    'roles', next_roles,
    'mode', p_mode,
    'role', p_role
  );
end;
$$;

revoke all on function public.admin_list_members(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_change_member_role(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_list_members(text, integer, integer) to service_role;
grant execute on function public.admin_change_member_role(uuid, uuid, text, text, text) to service_role;
