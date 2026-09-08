begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(23);

insert into private.feature_flag_operator_secret(singleton, token_digest)
values (true, extensions.digest(repeat('u', 32), 'sha256'))
on conflict (singleton) do update set token_digest = excluded.token_digest;
set local session_replication_role = replica;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000081', 'usage-one@example.invalid'),
  ('00000000-0000-4000-8000-000000000082', 'usage-two@example.invalid');
set local session_replication_role = origin;

select extensions.ok(not has_table_privilege('authenticated', 'private.agent_usage_state', 'SELECT'), 'readers cannot inspect usage state');
select extensions.ok(not has_table_privilege('anon', 'private.agent_usage_policy', 'UPDATE'), 'callers cannot raise their limits');
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

update private.agent_usage_policy set requests_per_minute=1;
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', extensions.gen_random_uuid())->>'reason',
  'minute', 'rolling-minute allowance applies after release');
update private.agent_usage_state set recent_requests=array[clock_timestamp()-interval '61 seconds'] where user_id='00000000-0000-4000-8000-000000000081';
select extensions.is(
  public.acquire_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093')->>'allowed',
  'true', 'expired minute entries no longer block requests');
select public.release_agent_usage(repeat('u',32), '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000093');
update private.agent_usage_policy set requests_per_day=2;
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
delete from auth.users where id='00000000-0000-4000-8000-000000000081';
select extensions.is((select count(*)::integer from private.agent_usage_state where user_id='00000000-0000-4000-8000-000000000081'), 0, 'account deletion removes usage state');
select * from extensions.finish();
rollback;
