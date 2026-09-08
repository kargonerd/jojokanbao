-- Shared across Agent instances and products. Only the trusted Agent can reserve
-- usage after authenticating a reader; browser-supplied counters are never used.
create table private.agent_usage_policy (
  singleton boolean primary key default true check (singleton),
  requests_per_minute integer not null default 3 check (requests_per_minute between 1 and 60),
  requests_per_day integer not null default 100 check (requests_per_day between 1 and 10000),
  max_run_seconds integer not null default 300 check (max_run_seconds between 30 and 600)
);
insert into private.agent_usage_policy(singleton) values (true);

create table private.agent_usage_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  usage_day date not null,
  day_count integer not null default 0 check (day_count >= 0),
  recent_requests timestamptz[] not null default '{}',
  active_request_id uuid,
  active_until timestamptz,
  check ((active_request_id is null) = (active_until is null))
);
revoke all on private.agent_usage_policy, private.agent_usage_state from public, anon, authenticated;

create function public.acquire_agent_usage(
  p_operator_token text,
  p_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy private.agent_usage_policy%rowtype;
  usage private.agent_usage_state%rowtype;
  v_now timestamptz;
  v_day date;
  retry_seconds integer;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_user_id is null or p_request_id is null then
    raise exception 'User and request identifiers are required' using errcode = '22023';
  end if;
  select * into strict policy from private.agent_usage_policy where singleton;
  insert into private.agent_usage_state(user_id, usage_day)
    values (p_user_id, (pg_catalog.clock_timestamp() at time zone 'Asia/Shanghai')::date)
    on conflict (user_id) do nothing;
  select * into strict usage from private.agent_usage_state
    where user_id = p_user_id for update;
  v_now := pg_catalog.clock_timestamp();
  v_day := (v_now at time zone 'Asia/Shanghai')::date;

  if usage.active_until > v_now then
    return jsonb_build_object('allowed', false, 'reason', 'concurrent',
      'retryAfter', greatest(1, ceil(extract(epoch from usage.active_until - v_now))::integer));
  end if;
  if usage.usage_day <> v_day then
    usage.day_count := 0;
  end if;
  if usage.day_count >= policy.requests_per_day then
    retry_seconds := ceil(extract(epoch from
      ((v_day + 1)::timestamp at time zone 'Asia/Shanghai') - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'daily',
      'retryAfter', greatest(1, retry_seconds), 'limit', policy.requests_per_day);
  end if;
  select coalesce(array_agg(request_time order by request_time), '{}'::timestamptz[])
    into usage.recent_requests from unnest(usage.recent_requests) as request_time
    where request_time > v_now - interval '1 minute';
  if cardinality(usage.recent_requests) >= policy.requests_per_minute then
    retry_seconds := ceil(extract(epoch from usage.recent_requests[1] + interval '1 minute' - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'minute',
      'retryAfter', greatest(1, retry_seconds), 'limit', policy.requests_per_minute);
  end if;

  update private.agent_usage_state set
    usage_day = v_day,
    day_count = usage.day_count + 1,
    recent_requests = array_append(usage.recent_requests, v_now),
    active_request_id = p_request_id,
    -- The Agent aborts at max_run_seconds; this grace period covers cancellation
    -- and cleanup. A crashed instance cannot leave an account locked forever.
    active_until = v_now + make_interval(secs => policy.max_run_seconds + 30)
    where user_id = p_user_id;
  return jsonb_build_object('allowed', true, 'maxRunSeconds', policy.max_run_seconds);
end;
$$;

create function public.release_agent_usage(
  p_operator_token text,
  p_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_feature_flag_operator(p_operator_token);
  update private.agent_usage_state set active_request_id = null, active_until = null
    where user_id = p_user_id and active_request_id = p_request_id;
  -- Do not refund admitted requests: cancellation/errors must not let a caller
  -- start unlimited model work. Rejected requests never consume allowance.
end;
$$;

revoke all on function public.acquire_agent_usage(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_agent_usage(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_agent_usage(text, uuid, uuid) to anon, authenticated;
grant execute on function public.release_agent_usage(text, uuid, uuid) to anon, authenticated;
