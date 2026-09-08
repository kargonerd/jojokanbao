-- Runtime configuration belongs to the existing feature flag document.
-- Keep request counters and active leases intact during this migration.
create function private.validate_agent_usage_feature_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  field_name text;
  field_value jsonb;
  numeric_value numeric;
  minimum_value integer;
  maximum_value integer;
begin
  if new.key <> 'ai.usage_limits' then
    return new;
  end if;
  foreach field_name in array array['requestsPerMinute', 'requestsPerDay', 'maxRunSeconds'] loop
    field_value := new.config -> field_name;
    minimum_value := case when field_name = 'maxRunSeconds' then 30 else 1 end;
    maximum_value := case field_name when 'requestsPerMinute' then 60 when 'requestsPerDay' then 10000 else 600 end;
    if jsonb_typeof(field_value) is distinct from 'number' then
      raise invalid_parameter_value using message = format('AI usage config %s must be an integer between %s and %s', field_name, minimum_value, maximum_value);
    end if;
    numeric_value := (field_value::text)::numeric;
    if trunc(numeric_value) <> numeric_value or numeric_value < minimum_value or numeric_value > maximum_value then
      raise invalid_parameter_value using message = format('AI usage config %s must be an integer between %s and %s', field_name, minimum_value, maximum_value);
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.validate_agent_usage_feature_config() from public, anon, authenticated;
create trigger validate_agent_usage_feature_config
  before insert or update of key, config on private.feature_flags
  for each row execute function private.validate_agent_usage_feature_config();

with previous_config as (
  select jsonb_build_object(
    'requestsPerMinute', requests_per_minute,
    'requestsPerDay', requests_per_day,
    'maxRunSeconds', max_run_seconds
  ) as config,
  private.feature_flag_normalize_rules('[{"name":"全部账号","conditionType":"global","serve":true,"enabled":true,"isFallback":true}]'::jsonb) as rules
  from private.agent_usage_policy where singleton
)
insert into private.feature_flags(key, description, rules, config, history)
select 'ai.usage_limits', 'AI 使用限额：每分钟、每天次数与单次最长执行时间', rules, config,
  jsonb_build_array(jsonb_build_object(
    'revision', 1, 'rules', rules, 'config', config,
    'reason', '迁移现有 AI 限额配置', 'requestId', null,
    'updatedAt', timezone('utc', now())
  ))
from previous_config;

-- Quotas always apply. The feature flag config supplies their values; rule
-- toggles cannot disable admission or reset a reader's existing usage.
create or replace function public.acquire_agent_usage(
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
  per_minute integer;
  per_day integer;
  max_run_seconds integer;
  usage private.agent_usage_state%rowtype;
  v_now timestamptz;
  v_day date;
  retry_seconds integer;
begin
  perform private.require_feature_flag_operator(p_operator_token);
  if p_user_id is null or p_request_id is null then
    raise exception 'User and request identifiers are required' using errcode = '22023';
  end if;
  select
    private.feature_flag_config_integer('ai.usage_limits', array['requestsPerMinute'], 3, 1, 60),
    private.feature_flag_config_integer('ai.usage_limits', array['requestsPerDay'], 100, 1, 10000),
    private.feature_flag_config_integer('ai.usage_limits', array['maxRunSeconds'], 300, 30, 600)
    into per_minute, per_day, max_run_seconds;
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
  if usage.day_count >= per_day then
    retry_seconds := ceil(extract(epoch from
      ((v_day + 1)::timestamp at time zone 'Asia/Shanghai') - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'daily',
      'retryAfter', greatest(1, retry_seconds), 'limit', per_day);
  end if;
  select coalesce(array_agg(request_time order by request_time), '{}'::timestamptz[])
    into usage.recent_requests from unnest(usage.recent_requests) as request_time
    where request_time > v_now - interval '1 minute';
  if cardinality(usage.recent_requests) >= per_minute then
    retry_seconds := ceil(extract(epoch from usage.recent_requests[1] + interval '1 minute' - v_now))::integer;
    return jsonb_build_object('allowed', false, 'reason', 'minute',
      'retryAfter', greatest(1, retry_seconds), 'limit', per_minute);
  end if;

  update private.agent_usage_state set
    usage_day = v_day,
    day_count = usage.day_count + 1,
    recent_requests = array_append(usage.recent_requests, v_now),
    active_request_id = p_request_id,
    -- The Agent aborts at max_run_seconds; this grace period covers cancellation
    -- and cleanup. A crashed instance cannot leave an account locked forever.
    active_until = v_now + make_interval(secs => max_run_seconds + 30)
    where user_id = p_user_id;
  return jsonb_build_object('allowed', true, 'maxRunSeconds', max_run_seconds);
end;
$$;


-- No counters or running leases are removed. Only the redundant configuration table goes away.
drop table private.agent_usage_policy;
