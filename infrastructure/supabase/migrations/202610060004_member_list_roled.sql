-- The members page lists only accounts that already carry roles by default;
-- free-text search finds any account (that is how you grant a first role).

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
declare
  q text := nullif(btrim(coalesce(p_query, '')), '');
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
    where case
      when q is not null then
        account.email ilike '%' || q || '%'
        or coalesce(profile.display_name, '') ilike '%' || q || '%'
      else coalesce(
        case when jsonb_typeof(account.raw_app_meta_data -> 'jojo_roles') = 'array'
          then jsonb_array_length(account.raw_app_meta_data -> 'jojo_roles') else 0 end, 0) > 0
    end
    limit least(200, greatest(1, p_limit))
    offset greatest(0, p_offset)
  ), '[]'::jsonb);
end;
$$;
