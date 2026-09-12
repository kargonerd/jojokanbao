import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const token = 'fixture-operator-token-with-at-least-32-characters';
const user = '10000000-0000-4000-8000-000000000001';
const request = '20000000-0000-4000-8000-000000000001';
const migration = name => readFile(new URL(`../../infrastructure/supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const queryValue = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const snapshot = key => queryValue('select private.feature_flag_snapshot($1) as value', [key]);
const sync = (updates, credential = token) => queryValue('select public.operator_sync_posthog_configs($1, $2::jsonb) as value', [credential, JSON.stringify(updates)]);
const update = (key, config, extra = {}) => ({key, config, expectedRevision: 1, remoteId: 100, remoteVersion: 2, ...extra});
const ai = {requestsPerMinute: 4, requestsPerDay: 150, maxRunSeconds: 240};
let beforeMigration, beforeUsage;
async function isolatedFailure(run, matcher) {
  await db.exec('savepoint invalid_request');
  try { await assert.rejects(run, matcher); }
  finally { await db.exec('rollback to savepoint invalid_request; release savepoint invalid_request'); }
}

before(async () => {
  // Run the real feature/config/usage SQL. Only unrelated Auth infrastructure
  // and pgcrypto entry points are fixtures (PGlite has PostgreSQL sha256).
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create table auth.users(id uuid primary key);
    create function extensions.digest(text, text) returns bytea language sql as $$ select sha256(convert_to($1, 'UTF8')) $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select pg_catalog.gen_random_uuid() $$;`);
  const base = await migration('202608150001_feature_flags');
  await db.exec(base.replace('create extension if not exists pgcrypto with schema extensions;', '').split('drop policy if exists "reader_bookshelf_own"')[0]);
  await db.exec('create table private.annotation_settings(singleton boolean, public_mark_threshold integer);');
  await db.exec((await migration('202608290002_annotation_threshold_feature_config')).split('create or replace function private.annotation_snapshot')[0]);
  await db.exec(await migration('202609080003_agent_usage_limits'));
  await db.exec(await migration('202609080004_agent_usage_feature_config'));
  await db.exec((await migration('202609090001_optional_signup_invitations')).split('-- Expose only this public boolean')[0]);
  await db.exec(await migration('202609090002_email_quota_monitor_config'));
  await db.query('insert into private.feature_flag_operator_secret(token_digest) values (extensions.digest($1, \'sha256\'))', [token]);
  await db.query('insert into auth.users(id) values ($1)', [user]);
  await db.query(`update private.feature_flags set config = config || $1::jsonb where key='ai.usage_limits'`, [JSON.stringify({...ai, reserved: 'retain'})]);
  await db.query(`insert into private.agent_usage_state(user_id, usage_day, day_count, active_request_id, active_until)
    values ($1, (clock_timestamp() at time zone 'Asia/Shanghai')::date, 50, $2, clock_timestamp() + interval '1 hour')`, [user, request]);
  beforeMigration = await queryValue('select jsonb_agg(to_jsonb(f) order by key) as value from private.feature_flags f');
  beforeUsage = await queryValue('select to_jsonb(s) as value from private.agent_usage_state s');
  await db.exec(await migration('202609110001_posthog_product_flags'));
  await db.exec(await migration('202609120001_posthog_runtime_config'));
});
after(async () => db.close());
beforeEach(async () => {
  await db.exec('begin');
  const flags = await queryValue('select public.operator_list_feature_flags($1) as value', [token]);
  await sync(flags.filter(flag => flag.configProvider === 'posthog').map(flag =>
    update(flag.key, flag.config, {remoteVersion: 1, expectedRevision: flag.revision})));
});
afterEach(async () => db.exec('rollback'));

test('migration preserves every live value, rule, revision, history, counter and running lease', async () => {
  const afterMigration = await queryValue(`select jsonb_agg(to_jsonb(f) - array['config_provider','config_remote_id','config_remote_version','config_synced_at'] order by key) as value from private.feature_flags f`);
  assert.deepEqual(afterMigration, beforeMigration);
  assert.deepEqual(await queryValue('select to_jsonb(s) as value from private.agent_usage_state s'), beforeUsage);
  assert.equal((await snapshot('ai.usage_limits')).configProvider, 'posthog');
  assert.equal((await snapshot('library.bookshelf')).configProvider, 'supabase');
});

test('publishes once with audit, preserves rules and unknown fields, retries idempotently, and rolls forward an old payload', async () => {
  const before = await snapshot('ai.usage_limits');
  const data = update('ai.usage_limits', {...ai, requestsPerDay: 200});
  assert.deepEqual(await sync([data]), {checked: 1, changed: ['ai.usage_limits']});
  const first = await snapshot('ai.usage_limits');
  assert.equal(first.revision, 2);
  assert.equal(first.config.reserved, 'retain');
  assert.deepEqual(first.rules, before.rules);
  assert.deepEqual(first.history.slice(0, -1), before.history);
  assert.equal(first.history.at(-1).requestId, 'posthog:100:2');
  assert.ok(first.configSyncedAt);
  assert.deepEqual(await sync([data]), {checked: 1, changed: []});
  assert.deepEqual((await snapshot('ai.usage_limits')).history, first.history);
  await sync([update('ai.usage_limits', ai, {remoteVersion: 3, expectedRevision: 2})]);
  assert.equal((await snapshot('ai.usage_limits')).revision, 3);
  assert.deepEqual(await queryValue('select to_jsonb(s) as value from private.agent_usage_state s'), beforeUsage);
});

test('rejects stale versions, identity replacement and same-version payload changes', async () => {
  await sync([update('ai.usage_limits', ai, {remoteVersion: 2})]);
  for (const extra of [{remoteVersion: 1}, {remoteVersion: 3, remoteId: 101}, {remoteVersion: 2}]) {
    await isolatedFailure(async () => {
      await db.query('select public.operator_sync_posthog_configs($1, $2::jsonb)', [token,
        JSON.stringify([update('ai.usage_limits', {...ai, requestsPerDay: 199}, extra)])]);
    });
  }
  assert.equal((await snapshot('ai.usage_limits')).config.requestsPerDay, 150);
});

test('first synchronization cannot overwrite a live value changed since export', async () => {
  await db.exec("update private.feature_flags set config_remote_id=null, config_remote_version=0 where key='ai.usage_limits'");
  const before = await snapshot('ai.usage_limits');
  await isolatedFailure(() => sync([update('ai.usage_limits', {...ai, requestsPerDay: 199})]), /must match current server values/);
  assert.deepEqual(await snapshot('ai.usage_limits'), before);
});

test('a later revision conflict rolls back the entire batch, including earlier rows', async () => {
  const before = await snapshot('ai.usage_limits');
  await isolatedFailure(async () => {
    await db.query('select public.operator_sync_posthog_configs($1, $2::jsonb)', [token, JSON.stringify([
      update('ai.usage_limits', {...ai, requestsPerDay: 199}),
      update('auth.signup', {invitationRequired: true}, {expectedRevision: 999}),
    ])]);
  }, /revision conflict/);
  assert.deepEqual(await snapshot('ai.usage_limits'), before);
});

test('database rejects invalid parameters independently of the importer and keeps the local cache', async () => {
  const invalid = [
    update('ai.usage_limits', {...ai, requestsPerDay: 0}),
    update('ai.usage_limits', {requestsPerDay: 100}),
    update('auth.signup', {invitationRequired: 'false'}, {expectedRevision: 2}),
    ...[0, 101, 1.5, '2', null].map(publicMarkThreshold => update('reader.annotations', {publicMarkThreshold})),
    update('ops.email_quota', {warningPercent: 90, criticalPercent: 80, usageSource: 'records', dailyLimit: 100, monthlyLimit: 3000}),
  ];
  for (const item of invalid) {
    await isolatedFailure(async () => {
      await db.query('select public.operator_sync_posthog_configs($1, $2::jsonb)', [token, JSON.stringify([item])]);
    });
  }
  assert.equal((await snapshot('ai.usage_limits')).config.requestsPerDay, 150);
  assert.equal((await snapshot('reader.annotations')).config.publicMarkThreshold, 2);
});

test('requires operator authentication and blocks legacy config publication after migration', async () => {
  const before = await snapshot('ai.usage_limits');
  await isolatedFailure(async () => {
    await db.exec('set local role anon');
    await db.query('select public.operator_sync_posthog_configs($1, $2::jsonb)', ['wrong-token', JSON.stringify([update('ai.usage_limits', ai)])]);
  }, /operator token is invalid/);
  await isolatedFailure(async () => {
    await db.query('select public.operator_publish_feature_flag($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
      [token, 'ai.usage_limits', JSON.stringify(before.rules), JSON.stringify({...ai, requestsPerDay: 199}), before.revision, 'legacy edit']);
  }, /managed in PostHog/);
});

test('server admission reads new limits immediately but retains existing counters and concurrency protection', async () => {
  await sync([update('ai.usage_limits', {...ai, requestsPerDay: 40})]);
  let result = await queryValue('select public.acquire_agent_usage($1,$2,$3) as value', [token, user, request]);
  assert.equal(result.allowed, false); assert.equal(result.reason, 'concurrent');
  await db.query('select public.release_agent_usage($1,$2,$3)', [token, user, request]);
  result = await queryValue('select public.acquire_agent_usage($1,$2,$3) as value', [token, user, request]);
  assert.equal(result.allowed, false); assert.equal(result.reason, 'daily'); assert.equal(result.limit, 40);
  assert.equal(await queryValue('select day_count as value from private.agent_usage_state where user_id=$1', [user]), 50);
});
