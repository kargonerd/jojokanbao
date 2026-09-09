-- Configuration only: Healthchecks owns incident state. No new settings table.
create function private.validate_email_quota_monitor_config()
returns trigger language plpgsql set search_path = '' as $$
declare warning numeric; critical numeric; field_name text; field_value numeric;
begin
  if new.key <> 'ops.email_quota' then return new; end if;
  if jsonb_typeof(new.config->'warningPercent') is distinct from 'number'
    or jsonb_typeof(new.config->'criticalPercent') is distinct from 'number' then
    raise invalid_parameter_value using message = 'Email quota thresholds must be integer percentages';
  end if;
  warning := (new.config->>'warningPercent')::numeric;
  critical := (new.config->>'criticalPercent')::numeric;
  if trunc(warning) <> warning or trunc(critical) <> critical or warning < 1 or warning >= critical or critical > 99 then
    raise invalid_parameter_value using message = 'Email quota thresholds require 1 <= warning < critical <= 99';
  end if;
  if (new.config->>'usageSource') is null or (new.config->>'usageSource') not in ('records','usage_api') then
    raise invalid_parameter_value using message = 'Email quota source must be records or usage_api';
  end if;
  foreach field_name in array array['dailyLimit','monthlyLimit'] loop
    if jsonb_typeof(new.config->field_name) is distinct from 'number' then
      raise invalid_parameter_value using message = 'Email quota limits must be positive integers';
    end if;
    field_value := (new.config->>field_name)::numeric;
    if trunc(field_value) <> field_value or field_value < 1 or field_value > (case when field_name='dailyLimit' then 1000000 else 100000000 end) then
      raise invalid_parameter_value using message = 'Email quota limits are out of range';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.validate_email_quota_monitor_config() from public, anon, authenticated;
create trigger validate_email_quota_monitor_config before insert or update of key, config on private.feature_flags
  for each row execute function private.validate_email_quota_monitor_config();

with initial as (
  select '{"warningPercent":80,"criticalPercent":90,"usageSource":"records","dailyLimit":100,"monthlyLimit":3000}'::jsonb as config,
    private.feature_flag_normalize_rules('[{"name":"全部账号","conditionType":"global","serve":true,"enabled":true,"isFallback":true}]'::jsonb) as rules
)
insert into private.feature_flags(key, description, rules, config, history)
select 'ops.email_quota', '邮件额度告警：预警和紧急百分比，耗尽固定为 100%，每 30 分钟检查', rules, config,
  jsonb_build_array(jsonb_build_object('revision', 1, 'rules', rules, 'config', config,
    'reason', '启用 Resend 额度预警', 'requestId', null, 'updatedAt', timezone('utc', now())))
from initial on conflict (key) do nothing;

-- Public, non-sensitive policy only: never expose usage, credentials or rules.
create function public.get_email_quota_monitor_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'warningPercent', private.feature_flag_config_integer('ops.email_quota', array['warningPercent'], 80, 1, 98),
    'criticalPercent', private.feature_flag_config_integer('ops.email_quota', array['criticalPercent'], 90, 2, 99),
    'usageSource', coalesce((select config->>'usageSource' from private.feature_flags where key='ops.email_quota'), 'records'),
    'dailyLimit', private.feature_flag_config_integer('ops.email_quota', array['dailyLimit'], 100, 1, 1000000),
    'monthlyLimit', private.feature_flag_config_integer('ops.email_quota', array['monthlyLimit'], 3000, 1, 100000000)
  );
$$;
revoke all on function public.get_email_quota_monitor_config() from public;
grant execute on function public.get_email_quota_monitor_config() to anon, authenticated;
comment on function public.get_email_quota_monitor_config() is 'Non-sensitive email quota thresholds. Rules do not disable monitoring; changes apply on the next 30-minute check.';
