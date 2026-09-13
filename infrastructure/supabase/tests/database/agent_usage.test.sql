begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();


set local session_replication_role = replica;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000081', 'usage-one@example.invalid'),
  ('00000000-0000-4000-8000-000000000082', 'usage-two@example.invalid');
set local session_replication_role = origin;

select extensions.ok(not has_table_privilege('authenticated', 'private.agent_usage_state', 'SELECT'), 'readers cannot inspect usage state');
select extensions.hasnt_table('private','feature_flags','callers cannot edit a database flag store');
select extensions.hasnt_table('private', 'agent_usage_policy', 'usage configuration does not retain a separate policy table');
select extensions.ok(not has_function_privilege('authenticated', 'public.acquire_agent_usage(uuid,uuid,integer,integer,integer)', 'execute'), 'clients cannot set AI limits');
select extensions.ok(not has_function_privilege('authenticated', 'public.release_agent_usage(uuid,uuid)', 'execute'), 'clients cannot release another usage lease');
select extensions.is((select count(*)::integer from private.agent_usage_state), 0, 'unauthorized calls create no counters');
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000091', 3,100,300)->>'allowed',
  'true', 'first request obtains a lease');
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000092', 3,100,300)->>'reason',
  'concurrent', 'another instance for the same user is rejected');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'rejection does not consume daily allowance');
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-000000000092', 3,100,300)->>'allowed',
  'true', 'a different account remains independent');
select public.release_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000092');
select extensions.ok((select active_request_id is not null from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 'old request cannot release a newer lease');
select public.release_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000091');
select extensions.ok((select active_request_id is null from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 'matching request releases its lease');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'cancellation does not refund admitted work');

select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid(), 1,100,120)->>'reason',
  'minute', 'rolling-minute allowance applies after release');
update private.agent_usage_state set recent_requests=array[clock_timestamp()-interval '61 seconds'] where user_id='00000000-0000-4000-8000-000000000081';
select extensions.ok(
  decision->>'allowed' = 'true' and decision->>'maxRunSeconds' = '120',
  'expired minute entries allow a new request with the server-provided deadline'
) from (select public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093', 1,100,120) as decision) admitted;
select public.release_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093');
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid(), 1,2,120)->>'reason',
  'daily', 'daily allowance cannot be bypassed by waiting for a minute');
select extensions.ok(
  (public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid(), 1,2,120)->>'retryAfter')::integer between 1 and 86400,
  'daily retry identifies the next Beijing midnight');
update private.agent_usage_state set usage_day=(clock_timestamp() at time zone 'Asia/Shanghai')::date-1, recent_requests='{}' where user_id='00000000-0000-4000-8000-000000000081';
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000094', 1,2,120)->>'allowed',
  'true', 'new Beijing day resets allowance');
select extensions.is((select day_count from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'daily reset counts only the new request');
select extensions.is((select usage_day from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), (clock_timestamp() at time zone 'Asia/Shanghai')::date, 'stored day uses Beijing time');
update private.agent_usage_state set active_until=clock_timestamp()-interval '1 second', recent_requests='{}' where user_id='00000000-0000-4000-8000-000000000081';
select extensions.is(
  public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000095', 1,2,120)->>'allowed',
  'true', 'a crashed instance lease expires');
select public.release_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000094');
select extensions.is((select active_request_id::text from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), '00000000-0000-4000-8000-000000000095', 'late cleanup cannot release the replacement request');
select extensions.is((select cardinality(recent_requests) from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 1, 'expired rolling history is discarded');
select public.release_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000095');
select extensions.ok(
  decision->>'allowed' = 'true' and decision->>'maxRunSeconds' = '300',
  'the next request uses updated daily allowance and generation deadline'
) from (select public.acquire_agent_usage('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000096', 3,100,300) as decision) admitted;

select extensions.throws_ok(format(
  'select public.acquire_agent_usage(''00000000-0000-4000-8000-000000000081'', extensions.gen_random_uuid(), %s, %s, %s)',
  coalesce(minute::text,'null'), coalesce(day::text,'null'), coalesce(seconds::text,'null')
), '22023', 'AI usage parameters are invalid', description)
from (values
  (null::integer,100,300,'missing parameters cannot bypass admission'),
  (0,100,300,'minute allowance must be positive'),(61,100,300,'minute allowance cannot exceed 60'),
  (3,0,300,'daily allowance must be positive'),(3,10001,300,'daily allowance cannot exceed 10000'),
  (3,100,29,'execution must last at least 30 seconds'),(3,100,601,'execution cannot exceed 600 seconds')
) invalid(minute,day,seconds,description);

delete from auth.users where id='00000000-0000-4000-8000-000000000081';
select extensions.is((select count(*)::integer from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 0, 'account deletion removes usage state');
select * from extensions.finish();
rollback;
