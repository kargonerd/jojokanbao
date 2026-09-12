begin;
-- Exercise legacy Operator quota editing; PostHog ownership/sync is covered in tools/posthog/runtime-config-sql.test.mjs.
update private.feature_flags set config_provider = 'supabase' where key = 'ai.usage_limits';
create extension if not exists pgtap with schema extensions;
select extensions.plan(41);

insert into private.feature_flag_operator_secret(singleton, token_digest)
values (true, extensions.digest(repeat('u', 32), 'sha256'))
on conflict (singleton) do update set token_digest = excluded.token_digest;
set local session_replication_role = replica;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000081', 'usage-one@example.invalid'),
  ('00000000-0000-4000-8000-000000000082', 'usage-two@example.invalid');
set local session_replication_role = origin;

select extensions.ok(not has_table_privilege('authenticated', 'private.agent_usage_state', 'SELECT'), 'readers cannot inspect usage state');
select extensions.ok(not has_table_privilege('anon', 'private.feature_flags', 'UPDATE'), 'callers cannot raise their limits');
select extensions.hasnt_table('private', 'agent_usage_policy', 'usage configuration does not retain a separate policy table');
select extensions.is(
  private.feature_flag_snapshot('ai.usage_limits')->'config',
  '{"requestsPerMinute":3,"requestsPerDay":100,"maxRunSeconds":300}'::jsonb,
  'migration preserves all three launch limits on the feature flag');
select extensions.throws_ok(
  $$select public.acquire_agent_usage('bad', '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())$$,
  '42501', 'Feature flag operator token is invalid', 'forged reservations are rejected');
select extensions.throws_ok(
  $$select public.release_agent_usage('bad', '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())$$,
  '42501', 'Feature flag operator token is invalid', 'forged releases are rejected');
select extensions.is((select count(*)::integer from private.agent_usage_state), 0, 'unauthorized calls create no counters');
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000091')->>'allowed',
  'true', 'first request obtains a lease');
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000092')->>'reason',
  'concurrent', 'another instance for the same user is rejected');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'rejection does not consume daily allowance');
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-000000000092')->>'allowed',
  'true', 'a different account remains independent');
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000092');
select extensions.ok((select active_request_id is not null from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 'old request cannot release a newer lease');
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000091');
select extensions.ok((select active_request_id is null from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 'matching request releases its lease');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'cancellation does not refund admitted work');

select extensions.is(public.operator_publish_feature_flag(
  repeat('u',32), 'ai.usage_limits',
  private.feature_flag_snapshot('ai.usage_limits')->'rules',
  '{"requestsPerMinute":1,"requestsPerDay":100,"maxRunSeconds":120}'::jsonb,
  1, 'Lower minute allowance and execution deadline', 'usage-minute-config'
)->>'revision', '2', 'operator publishing updates usage limits through the existing revision workflow');
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())->>'reason',
  'minute', 'rolling-minute allowance applies after release');
update private.agent_usage_state set recent_requests=array[clock_timestamp()-interval '61 seconds'] where user_id='00000000-0000-4000-8000-000000000081';
select extensions.ok(
  decision->>'allowed' = 'true' and decision->>'maxRunSeconds' = '120',
  'expired minute entries allow a new request with the freshly published deadline'
) from (select public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093') as decision) admitted;
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093');
select extensions.is(public.operator_publish_feature_flag(
  repeat('u',32), 'ai.usage_limits',
  private.feature_flag_snapshot('ai.usage_limits')->'rules',
  '{"requestsPerMinute":1,"requestsPerDay":2,"maxRunSeconds":120}'::jsonb,
  2, 'Lower daily allowance', 'usage-daily-config'
)->>'revision', '3', 'daily allowance is published on the same feature flag');
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())->>'reason',
  'daily', 'daily allowance cannot be bypassed by waiting for a minute');
select extensions.ok(
  (public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())->>'retryAfter')::integer between 1 and 86400,
  'daily retry identifies the next Beijing midnight');
update private.agent_usage_state set usage_day=(clock_timestamp() at time zone 'Asia/Shanghai')::date-1, recent_requests='{}' where user_id='00000000-0000-4000-8000-000000000081';
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000094')->>'allowed',
  'true', 'new Beijing day resets allowance');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'daily reset counts only the new request');
select extensions.is((select usage_day from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), (clock_timestamp() at time zone 'Asia/Shanghai')::date, 'stored day uses Beijing time');
update private.agent_usage_state set active_until=clock_timestamp()-interval '1 second', recent_requests='{}' where user_id='00000000-0000-4000-8000-000000000081';
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000095')->>'allowed',
  'true', 'a crashed instance lease expires');
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000094');
select extensions.is((select active_request_id::text from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), '00000000-0000-4000-8000-000000000095', 'late cleanup cannot release the replacement request');
select extensions.is((select cardinality(recent_requests) from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'expired rolling history is discarded');
select extensions.is(public.operator_rollback_feature_flag(
  repeat('u',32), 'ai.usage_limits', 1, 3, 'usage-config-rollback'
)->>'revision', '4', 'usage limit rollback publishes the original settings as a new revision');
select extensions.is(
  private.feature_flag_snapshot('ai.usage_limits')->'config',
  '{"requestsPerMinute":3,"requestsPerDay":100,"maxRunSeconds":300}'::jsonb,
  'rollback restores the original minute, daily and execution limits');
select extensions.is(
  private.feature_flag_snapshot('ai.usage_limits')->'history'->2->'config',
  '{"requestsPerMinute":1,"requestsPerDay":2,"maxRunSeconds":120}'::jsonb,
  'history retains the complete configuration that was rolled back');
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000095');
select extensions.ok(
  decision->>'allowed' = 'true' and decision->>'maxRunSeconds' = '300',
  'the next request uses restored daily allowance and generation deadline'
) from (select public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000096') as decision) admitted;

select extensions.throws_ok(format(
  'select public.operator_publish_feature_flag(repeat(''u'',32), ''ai.usage_limits'', private.feature_flag_snapshot(''ai.usage_limits'')->''rules'', %L::jsonb, 4, ''Reject invalid quota configuration'', null)',
  invalid.config
), '22023', null, invalid.description)
from (values
  ('{}'::jsonb, 'missing quota fields cannot be published'),
  ('{"requestsPerMinute":1.5,"requestsPerDay":100,"maxRunSeconds":300}'::jsonb, 'fractional request limits cannot be published'),
  ('{"requestsPerMinute":3,"requestsPerDay":"100","maxRunSeconds":300}'::jsonb, 'string request limits cannot be published'),
  ('{"requestsPerMinute":3,"requestsPerDay":100,"maxRunSeconds":false}'::jsonb, 'boolean execution limits cannot be published'),
  ('{"requestsPerMinute":0,"requestsPerDay":100,"maxRunSeconds":300}'::jsonb, 'minute allowance must be positive'),
  ('{"requestsPerMinute":61,"requestsPerDay":100,"maxRunSeconds":300}'::jsonb, 'minute allowance cannot exceed 60'),
  ('{"requestsPerMinute":3,"requestsPerDay":0,"maxRunSeconds":300}'::jsonb, 'daily allowance must be positive'),
  ('{"requestsPerMinute":3,"requestsPerDay":10001,"maxRunSeconds":300}'::jsonb, 'daily allowance cannot exceed 10000'),
  ('{"requestsPerMinute":3,"requestsPerDay":100,"maxRunSeconds":29}'::jsonb, 'execution limit must be at least 30 seconds'),
  ('{"requestsPerMinute":3,"requestsPerDay":100,"maxRunSeconds":601}'::jsonb, 'execution limit cannot exceed 600 seconds')
) as invalid(config, description);

delete from auth.users where id='00000000-0000-4000-8000-000000000081';
select extensions.is((select count(*)::integer from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 0, 'account deletion removes usage state');
select * from extensions.finish();
rollback;
