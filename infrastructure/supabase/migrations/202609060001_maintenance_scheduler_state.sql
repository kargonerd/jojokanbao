-- Private, bounded state for the portable maintenance scheduler. No Auth/Reader data.
create schema if not exists private;

create table private.maintenance_scheduler_secret (
  singleton boolean primary key default true check (singleton),
  token_digest bytea not null check (octet_length(token_digest) = 32)
);
create table private.maintenance_scheduler_control (
  singleton boolean primary key default true check (singleton),
  backend text not null default 'cloudflare' check (backend in ('cloudflare', 'tencent', 'paused')),
  owner uuid,
  lease_until timestamptz,
  last_tick timestamptz,
  imported_at timestamptz
);
insert into private.maintenance_scheduler_control(singleton) values (true);
create table private.maintenance_scheduler_state (
  key text primary key check (length(key) between 1 and 200),
  value jsonb not null check (octet_length(value::text) <= 131072),
  updated_at timestamptz not null default clock_timestamp()
);
revoke all on private.maintenance_scheduler_secret, private.maintenance_scheduler_control,
  private.maintenance_scheduler_state from public, anon, authenticated;
alter table private.maintenance_scheduler_secret enable row level security;
alter table private.maintenance_scheduler_control enable row level security;
alter table private.maintenance_scheduler_state enable row level security;

-- A dedicated random token authorizes ONLY this bounded state interface. It is
-- not a Supabase management/service-role key and cannot access business tables.
create function public.maintenance_scheduler_rpc(
  p_token text, p_operation text, p_owner uuid default null,
  p_key text default null, p_value jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctl private.maintenance_scheduler_control%rowtype;
  now_at timestamptz := clock_timestamp();
  tick_at timestamptz;
  result jsonb;
  entry record;
begin
  if length(coalesce(p_token, '')) < 32 or not exists (
    select 1 from private.maintenance_scheduler_secret
    where token_digest = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
  ) then raise exception 'Invalid scheduler credential' using errcode = '42501'; end if;

  -- The row lock also fences a concurrent administrative backend switch.
  select * into strict ctl from private.maintenance_scheduler_control
    where singleton for update;
  if p_operation = 'status' then
    return jsonb_build_object('backend', ctl.backend, 'lastTick', ctl.last_tick,
      'leaseUntil', ctl.lease_until, 'importedAt', ctl.imported_at, 'serverTime', now_at);
  end if;

  if p_operation = 'import' then
    if ctl.backend <> 'cloudflare' or ctl.lease_until > now_at then
      raise exception 'Migration import is closed' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value) is distinct from 'object' or jsonb_typeof(p_value->'states') is distinct from 'object'
      or octet_length(p_value::text) > 1048576 then raise exception 'Invalid migration snapshot'; end if;
    for entry in select * from jsonb_each(p_value->'states') loop
      if length(entry.key) > 200 or entry.key !~ '^monitor:[a-z0-9-]+:(monitor|queue-monitor)$'
        or jsonb_typeof(entry.value) <> 'object' or octet_length(entry.value::text) > 131072
        then raise exception 'Invalid migration state'; end if;
      insert into private.maintenance_scheduler_state(key, value) values (entry.key, entry.value)
        on conflict (key) do update set value=excluded.value, updated_at=now_at;
    end loop;
    if not exists (select 1 from jsonb_each(p_value->'states')) then raise exception 'Empty migration snapshot'; end if;
    update private.maintenance_scheduler_control set imported_at=now_at where singleton;
    return jsonb_build_object('importedAt', now_at, 'keys', (select jsonb_agg(key) from jsonb_each(p_value->'states')));
  end if;

  if p_operation = 'claim' then
    if p_owner is null then raise exception 'Owner is required'; end if;
    tick_at := (p_value->>'tick')::timestamptz;
    if tick_at is null or tick_at < now_at - interval '2 minutes'
      or tick_at > now_at + interval '30 seconds' then raise exception 'Invalid tick'; end if;
    if ctl.backend <> 'tencent' then return jsonb_build_object('claimed', false, 'reason', 'inactive'); end if;
    -- Safe retry of a claim whose HTTP response was lost.
    if ctl.owner = p_owner and ctl.lease_until > now_at then
      return jsonb_build_object('claimed', true);
    end if;
    if ctl.lease_until > now_at then return jsonb_build_object('claimed', false, 'reason', 'busy'); end if;
    if ctl.last_tick >= tick_at then return jsonb_build_object('claimed', false, 'reason', 'replayed'); end if;
    update private.maintenance_scheduler_control set owner = p_owner,
      lease_until = now_at + interval '90 seconds', last_tick = tick_at where singleton;
    return jsonb_build_object('claimed', true);
  end if;

  if ctl.backend <> 'tencent' or p_owner is null or ctl.owner is distinct from p_owner
    or ctl.lease_until is null or ctl.lease_until <= now_at then
    raise exception 'Scheduler lease lost' using errcode = '42501';
  end if;
  if p_operation = 'release' then
    update private.maintenance_scheduler_control set owner = null, lease_until = null where singleton;
    return '{}'::jsonb;
  end if;
  if p_key is null or length(p_key) > 200 or p_key !~ '^(monitor:[a-z0-9-]+:(monitor|queue-monitor)|dispatch:[a-z0-9-]+)$'
    then raise exception 'Invalid state key'; end if;
  if p_operation = 'get' then
    select value into result from private.maintenance_scheduler_state where key = p_key;
    return jsonb_build_object('value', result);
  elsif p_operation = 'put' then
    if p_value is null or jsonb_typeof(p_value) <> 'object' or octet_length(p_value::text) > 131072
      then raise exception 'Invalid state value'; end if;
    insert into private.maintenance_scheduler_state(key, value) values (p_key, p_value)
      on conflict (key) do update set value = excluded.value, updated_at = now_at;
    return '{}'::jsonb;
  end if;
  raise exception 'Invalid scheduler operation';
end;
$$;
revoke all on function public.maintenance_scheduler_rpc(text, text, uuid, text, jsonb) from public;
grant execute on function public.maintenance_scheduler_rpc(text, text, uuid, text, jsonb) to anon, authenticated;
comment on function public.maintenance_scheduler_rpc(text, text, uuid, text, jsonb)
  is 'Token-scoped scheduler state only; leased writes; backend cutover is admin-only.';
