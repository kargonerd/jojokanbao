// Explicit hosted configuration smoke test. Every SQL mutation is rolled back.
// Run after the reviewed migration is applied:
//   node tools/beta-smoke/feature-flags.mjs [env-directory]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvironment, literal, query, request } from './lib.mjs';

const env = loadEnvironment(process.argv[2]);
for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'JOJO_OPERATOR_TOKEN']) {
  assert.ok(env[key], `Missing ${key}`);
}
const run = `feature_smoke_${randomUUID().replaceAll('-', '')}`;
const flagKey = literal(run);
// Use an ephemeral credential only inside the rollback transaction. The real
// operator credential is used solely in the intended authenticated HTTP RPCs,
// never interpolated into management SQL or its possible query logs.
const operator = literal(`smoke-only-${randomUUID()}-${randomUUID()}`);
const passed = [];
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };
const rules = [{ name: 'Smoke fallback', conditionType: 'global', serve: false, enabled: true, isFallback: true }];

const [schema] = await query(env, `select
  exists(select 1 from supabase_migrations.schema_migrations where version = '202608290002') as migration_recorded,
  exists(select 1 from information_schema.columns where table_schema = 'private' and table_name = 'feature_flags' and column_name = 'config') as config_column,
  to_regclass('private.annotation_settings') is null as old_settings_removed,
  to_regprocedure('public.operator_publish_feature_flag(text,text,jsonb,jsonb,bigint,text,text)') is not null as config_publish,
  to_regprocedure('public.operator_publish_feature_flag(text,text,jsonb,bigint,text,text)') is null as legacy_publish_removed,
  not pg_catalog.has_table_privilege('anon', 'private.feature_flags', 'select')
    and not pg_catalog.has_table_privilege('authenticated', 'private.feature_flags', 'select') as table_private`);
for (const [name, value] of Object.entries(schema)) check(name, value === true);

// The synthetic row is never committed or visible to another session. The
// public RPC calls execute as anon, exactly as the local operator HTTP client.
// A failure aborts this transaction; a success explicitly rolls it back.
const [transaction] = await query(env, `begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local idle_in_transaction_session_timeout = '30s';
set local jojo.feature_smoke_operator = ${operator};
update private.feature_flag_operator_secret
  set token_digest = extensions.digest(current_setting('jojo.feature_smoke_operator'), 'sha256')
  where singleton;
insert into private.feature_flags(key, description, rules, config, history)
select ${flagKey}, 'Temporary configuration verification', normalized.rules,
  '{"publicMarkThreshold":2}'::jsonb,
  jsonb_build_array(jsonb_build_object('revision', 1, 'rules', normalized.rules, 'config', '{"publicMarkThreshold":2}'::jsonb))
from (select private.feature_flag_normalize_rules(${literal(JSON.stringify(rules))}::jsonb) as rules) normalized;
set local role anon;
do $smoke$
declare
  snapshot jsonb;
  initial_rules jsonb;
  operator_token text := current_setting('jojo.feature_smoke_operator');
begin
  snapshot := public.operator_get_feature_flag(operator_token, ${flagKey});
  initial_rules := snapshot->'rules';
  if snapshot->'config' is distinct from '{"publicMarkThreshold":2}'::jsonb then
    raise exception 'Initial config is not readable';
  end if;
  begin
    perform public.operator_publish_feature_flag('invalid-smoke-token', ${flagKey}, initial_rules, '{}'::jsonb, 1, 'Reject unauthorized publish', null);
    raise exception 'Unauthorized publish was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.operator_publish_feature_flag(operator_token, ${flagKey}, initial_rules, '[]'::jsonb, 1, 'Reject invalid config', null);
    raise exception 'Array config was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.operator_publish_feature_flag(operator_token, ${flagKey}, initial_rules, jsonb_build_object('large', repeat('x', 16384)), 1, 'Reject oversized config', null);
    raise exception 'Oversized config was accepted';
  exception when invalid_parameter_value then null;
  end;
  snapshot := public.operator_publish_feature_flag(operator_token, ${flagKey}, initial_rules, '{"publicMarkThreshold":3}'::jsonb, 1, 'Verify config publish', null);
  if snapshot->>'revision' is distinct from '2' or snapshot->'config' is distinct from '{"publicMarkThreshold":3}'::jsonb then
    raise exception 'Nonempty config did not publish';
  end if;
  begin
    perform public.operator_publish_feature_flag(operator_token, ${flagKey}, initial_rules, '{}'::jsonb, 1, 'Reject stale revision', null);
    raise exception 'Stale revision was accepted';
  exception when serialization_failure then null;
  end;
  snapshot := public.operator_rollback_feature_flag(operator_token, ${flagKey}, 1, 2, null);
  if snapshot->>'revision' is distinct from '3' or snapshot->'config' is distinct from '{"publicMarkThreshold":2}'::jsonb
    or snapshot->'rules' is distinct from initial_rules or jsonb_array_length(snapshot->'history') is distinct from 3
    or snapshot->'history'->1->'config' is distinct from '{"publicMarkThreshold":3}'::jsonb then
    raise exception 'Rollback or configuration history is incorrect';
  end if;
end;
$smoke$;
reset role;
rollback;
select count(*)::integer as remaining_test_flags from private.feature_flags where key = ${flagKey};`, false);
check('config publish, authorization, validation, revision conflict and rollback passed as anon', transaction?.remaining_test_flags === 0);

const rpc = (name, body) => request(env, `rest/v1/rpc/${name}`, { body });
const current = await rpc('operator_get_feature_flag', { p_operator_token: env.JOJO_OPERATOR_TOKEN, p_key: 'reader.annotations' });
check('HTTP runtime read includes configuration', current.ok && current.data?.config && typeof current.data.config === 'object');
const invalidConfig = await rpc('operator_publish_feature_flag', {
  p_operator_token: env.JOJO_OPERATOR_TOKEN, p_key: 'reader.annotations', p_rules: rules,
  p_config: [], p_expected_revision: current.data.revision, p_reason: 'Reject smoke invalid config', p_request_id: run,
});
check('PostgREST exposes the new signature and rejects invalid configuration', invalidConfig.status === 400 && invalidConfig.data?.code === '22023');
const denied = await rpc('operator_publish_feature_flag', {
  p_operator_token: 'invalid-smoke-token', p_key: run, p_rules: rules,
  p_config: {}, p_expected_revision: 1, p_reason: 'Reject smoke unauthorized request', p_request_id: run,
});
check('HTTP publish rejects an invalid operator token', [401, 403].includes(denied.status) && denied.data?.code === '42501');
const [cleanup] = await query(env, `select count(*)::integer as remaining_test_flags from private.feature_flags where key = ${flagKey}`);
check('no synthetic feature flag remains', cleanup.remaining_test_flags === 0);

mkdirSync('.runtime/beta-smoke', { recursive: true });
const reportPath = `.runtime/beta-smoke/${run}.json`;
writeFileSync(reportPath, JSON.stringify({ run, passed, remainingTestFlags: cleanup.remaining_test_flags }, null, 2));
console.log(JSON.stringify({ passed: passed.length, remainingTestFlags: cleanup.remaining_test_flags, reportPath }));
