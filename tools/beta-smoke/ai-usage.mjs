// Explicit hosted quota smoke test. Calls Supabase only; never requests a model.
// Run after migration 202609080003 is applied:
//   node tools/beta-smoke/ai-usage.mjs [env-directory]
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getAdminKey, literal, loadEnvironment, query, request } from './lib.mjs';

const env = loadEnvironment(process.argv[2]);
for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'JOJO_OPERATOR_TOKEN']) {
  assert.ok(env[key], `Missing ${key}`);
}
const run = `ai-usage-smoke-${randomUUID()}`;
const passed = [];
const userIds = new Set();
let userId;
let userToken;
let fixturesStarted = false;
let policy;
let failure;
let cleanupFailure;
let cleanup;
mkdirSync('.runtime/beta-smoke', { recursive: true });
const reportPath = `.runtime/beta-smoke/${run}.json`;
const save = status => writeFileSync(reportPath, JSON.stringify({
  run, status, passed, userIds: [...userIds], policy, cleanup,
  error: failure?.message, cleanupError: cleanupFailure?.message,
}, null, 2));
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
save('running');

const markedUser = () => `user_id = ${literal(userId)}::uuid and exists (
  select 1 from auth.users where id = ${literal(userId)}::uuid
    and raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)}
)`;
async function state() {
  const [value] = await query(env, `select usage_day, day_count, recent_requests,
    active_request_id, active_until from private.agent_usage_state where ${markedUser()}`);
  return value;
}
async function setFixtureState(assignments) {
  // Assignments are fixed SQL below. Both the account ID and this run's marker
  // must match, so simulated clock/quota state cannot affect a real reader.
  const rows = await query(env, `update private.agent_usage_state set ${assignments}
    where ${markedUser()} returning user_id`, false);
  assert.equal(rows.length, 1, 'Only the marked fixture state may be changed');
}
const rpc = (name, requestId, operatorToken = env.JOJO_OPERATOR_TOKEN, token) => request(env, `rest/v1/rpc/${name}`, {
  token, body: { p_operator_token: operatorToken, p_user_id: userId, p_request_id: requestId },
});
async function acquire(requestId) {
  const result = await rpc('acquire_agent_usage', requestId);
  assert.ok(result.ok, `acquire_agent_usage: HTTP ${result.status}, code ${result.data?.code ?? ''}`);
  return result.data;
}
async function release(requestId) {
  const result = await rpc('release_agent_usage', requestId);
  assert.ok(result.ok, `release_agent_usage: HTTP ${result.status}, code ${result.data?.code ?? ''}`);
}
const deniedOperator = result => [401, 403].includes(result.status) && result.data?.code === '42501';

try {
  const [schema] = await query(env, `select
    exists(select 1 from supabase_migrations.schema_migrations where version = '202609080003') as migration_recorded,
    to_regprocedure('public.acquire_agent_usage(text,uuid,uuid)') is not null as acquire_rpc,
    to_regprocedure('public.release_agent_usage(text,uuid,uuid)') is not null as release_rpc`);
  check('usage migration and RPCs are present', Object.values(schema).every(value => value === true));
  [policy] = await query(env, `select requests_per_minute, requests_per_day, max_run_seconds
    from private.agent_usage_policy where singleton`);
  assert.ok(Number.isInteger(policy?.requests_per_minute) && policy.requests_per_minute >= 1 && policy.requests_per_minute <= 60);
  assert.ok(policy.requests_per_day > policy.requests_per_minute && policy.requests_per_day >= 3,
    'The daily policy must allow the minute-limit and expired-lease scenarios');
  const adminKey = await getAdminKey(env);
  fixturesStarted = true;
  const [invitation] = await query(env, `select * from private.create_signup_invitation(null, interval '1 hour', 1, ${literal(run)})`, false);
  const email = `${run}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const created = await request(env, 'auth/v1/admin/users', {
    token: adminKey, key: adminKey, body: {
      email, password, email_confirm: true,
      user_metadata: { invitation_code: invitation.code, beta_smoke_run: run },
    },
  });
  assert.ok(created.ok, `Temporary account creation: HTTP ${created.status}`);
  userId = created.data?.id;
  assert.ok(userId, 'Temporary account ID was returned');
  userIds.add(userId);
  save('running');
  const signedIn = await request(env, 'auth/v1/token?grant_type=password', { body: { email, password } });
  assert.ok(signedIn.ok && signedIn.data?.user?.id === userId, `Temporary account sign-in: HTTP ${signedIn.status}`);
  userToken = signedIn.data.access_token;
  check('one isolated confirmed account authenticated without email', Boolean(userToken));

  const deniedAcquire = await rpc('acquire_agent_usage', randomUUID(), null, userToken);
  check('a signed-in reader cannot acquire without the operator token', deniedOperator(deniedAcquire));
  const deniedRelease = await rpc('release_agent_usage', randomUUID(), null, userToken);
  check('a signed-in reader cannot release without the operator token', deniedOperator(deniedRelease));
  check('unauthorized calls create no usage state', await state() === undefined);

  const requestIds = [randomUUID(), randomUUID()];
  // Await both responses even if one fails; cleanup must not race an in-flight
  // acquire after an uncertain network result.
  const responses = await Promise.allSettled(requestIds.map(id => acquire(id)));
  const rejected = responses.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const results = responses.map(result => result.value);
  const winner = results.findIndex(result => result.allowed === true);
  check('two simultaneous calls admit exactly one request', results.filter(result => result.allowed === true).length === 1);
  const blocked = results[1 - winner];
  check('the other concurrent call has a retry delay', blocked?.allowed === false && blocked.reason === 'concurrent' && blocked.retryAfter > 0);
  const firstState = await state();
  check('concurrent rejection does not consume allowance', firstState.day_count === 1 && firstState.recent_requests.length === 1 && firstState.active_request_id === requestIds[winner]);
  check('the response carries the configured generation deadline', results[winner].maxRunSeconds === policy.max_run_seconds);
  await release(requestIds[winner]);
  check('release clears the lease without refunding admitted usage', (await state()).active_request_id === null && (await state()).day_count === 1);

  // With the launch policy this admits requests two and three, then rejects the
  // fourth within the rolling minute. No policy settings are changed.
  for (let admitted = 1; admitted < policy.requests_per_minute; admitted++) {
    const id = randomUUID();
    check(`request ${admitted + 1} is admitted after release`, (await acquire(id)).allowed === true);
    await release(id);
  }
  const beforeMinute = await state();
  const minute = await acquire(randomUUID());
  check('the next request exceeds the configured rolling-minute limit', minute.allowed === false && minute.reason === 'minute' && minute.limit === policy.requests_per_minute && minute.retryAfter > 0 && minute.retryAfter <= 60);
  assert.deepEqual(await state(), beforeMinute, 'Minute rejection must not change counters or leases');
  passed.push('minute rejection does not consume allowance');

  await setFixtureState(`usage_day = (clock_timestamp() at time zone 'Asia/Shanghai')::date,
    day_count = ${Number(policy.requests_per_day)}, recent_requests = '{}', active_request_id = null, active_until = null`);
  const beforeDaily = await state();
  const daily = await acquire(randomUUID());
  check('the daily limit rejects with a delay until Shanghai midnight', daily.allowed === false && daily.reason === 'daily' && daily.limit === policy.requests_per_day && daily.retryAfter > 0 && daily.retryAfter <= 86400);
  assert.deepEqual(await state(), beforeDaily, 'Daily rejection must not change counters or leases');
  passed.push('daily rejection does not consume allowance');

  await setFixtureState(`usage_day = (clock_timestamp() at time zone 'Asia/Shanghai')::date - 1,
    day_count = ${Number(policy.requests_per_day)}, recent_requests = '{}', active_request_id = null, active_until = null`);
  const newDayId = randomUUID();
  check('a full allowance from yesterday permits a new request today', (await acquire(newDayId)).allowed === true);
  const [newDay] = await query(env, `select day_count,
    usage_day = (clock_timestamp() at time zone 'Asia/Shanghai')::date as current_day
    from private.agent_usage_state where ${markedUser()}`);
  check('the first request of a new day starts its counter at one', newDay.current_day && newDay.day_count === 1);
  await release(newDayId);

  // Simulate only this fixture's expired lease. Clearing the rolling window
  // keeps this scenario independent from the configured minute allowance.
  await setFixtureState(`recent_requests = '{}'`);
  const expiredId = randomUUID();
  check('an initial request acquires the lease for expiry testing', (await acquire(expiredId)).allowed === true);
  await setFixtureState(`active_until = clock_timestamp() - interval '1 second', recent_requests = '{}'`);
  const replacementId = randomUUID();
  check('an expired lease allows a replacement request', (await acquire(replacementId)).allowed === true);
  const replacement = await state();
  check('the replacement owns a new lease and increments usage once', replacement.active_request_id === replacementId && replacement.day_count === 3);
  await release(expiredId);
  assert.deepEqual(await state(), replacement, 'An old request must not release a newer lease');
  passed.push('a late release from the old request preserves the replacement lease');
  const unauthorizedLateRelease = await rpc('release_agent_usage', replacementId, null, userToken);
  check('a reader cannot clear the active replacement lease', deniedOperator(unauthorizedLateRelease) && (await state()).active_request_id === replacementId);
  await release(replacementId);
  const finished = await state();
  check('the matching release clears the lease and keeps charged usage', finished.active_request_id === null && finished.active_until === null && finished.day_count === 3);
} catch (error) {
  failure = error;
} finally {
  if (fixturesStarted) {
    try {
      // Reconcile by the exact marker even if Auth creation committed but its
      // response was lost. Save IDs before deletion so usage cleanup is checked.
      const markedUsers = await query(env, `select id from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)}`);
      for (const user of markedUsers) userIds.add(user.id);
      save('cleaning');
      if (userToken) {
        // Deleting this fixture below is also authoritative session cleanup.
        await request(env, 'auth/v1/logout?scope=local', { token: userToken, body: {} }).catch(() => undefined);
      }
      await query(env, `begin;
        set local lock_timeout = '5s';
        set local statement_timeout = '30s';
        delete from private.agent_usage_state where user_id in (
          select id from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)}
        );
        delete from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)};
        delete from private.signup_invitations where note = ${literal(run)};
        commit;`, false);
      const ids = `array[${[...userIds].map(literal).join(',')}]::uuid[]`;
      [cleanup] = await query(env, `select
        (select count(*) from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)}) as users,
        (select count(*) from private.signup_invitations where note = ${literal(run)}) as invitations,
        (select count(*) from private.agent_usage_state where user_id = any(${ids})) as usage_state,
        (select count(*) from private.signup_invitation_redemptions where user_id = any(${ids})) as redemptions`);
      check('all fixture accounts, invitations, usage state and redemptions are removed', Object.values(cleanup).every(value => Number(value) === 0));
    } catch (error) {
      cleanupFailure = error;
    }
  }
  save(cleanupFailure ? 'cleanup-required' : failure ? 'failed' : 'passed');
  console.log(JSON.stringify({ run, passed, policy, cleanup, reportPath, cleanupRequired: Boolean(cleanupFailure) }, null, 2));
}
if (cleanupFailure) throw new Error(`AI usage cleanup requires reconciliation of ${run}; see ${reportPath}`, { cause: cleanupFailure });
if (failure) throw failure;
