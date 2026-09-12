import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_KEYS, prepareUpdates, syncRuntimeConfig } from './sync-runtime-config.mjs';

export const configs = {
  'auth.signup': {invitationRequired: false},
  'reader.annotations': {publicMarkThreshold: 5},
  'ai.usage_limits': {requestsPerMinute: 4, requestsPerDay: 150, maxRunSeconds: 240},
  'ops.email_quota': {warningPercent: 75, criticalPercent: 95, usageSource: 'records', dailyLimit: 200, monthlyLimit: 4000},
};
const current = Object.keys(CONFIG_KEYS).map(key => ({key, configProvider: 'posthog', revision: 7}));
const remote = () => ({errorsWhileComputingFlags: false, flags: Object.fromEntries(
  Object.entries(CONFIG_KEYS).map(([key, remoteKey], i) => [remoteKey, {
    key: remoteKey, enabled: true, metadata: {id: 100 + i, version: 2, payload: JSON.stringify(configs[key])},
  }]))});
const env = {POSTHOG_PROJECT_TOKEN: 'phc_test', JOJO_OPERATOR_TOKEN: 'test-operator-token-with-at-least-32-characters',
  VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test'};

test('reads global configuration then publishes one versioned batch without sending operator credentials to PostHog', async () => {
  const calls = [];
  const result = await syncRuntimeConfig(env, async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)});
    return Response.json(url.includes('/flags/') ? remote() : url.endsWith('operator_list_feature_flags') ? current : {checked: 4, changed: []});
  });
  assert.deepEqual(result, {checked: 4, changed: []});
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body, {api_key: 'phc_test', distinct_id: 'jojo-runtime-config', disable_geoip: true});
  assert.equal(calls[0].headers.apikey, undefined);
  assert.equal(calls[2].body.p_operator_token, env.JOJO_OPERATOR_TOKEN);
  assert.deepEqual(calls[2].body.p_updates[1], {key: 'reader.annotations', config: configs['reader.annotations'], expectedRevision: 7, remoteId: 101, remoteVersion: 2});
  assert.ok(calls.every(call => call.redirect === 'error'));
});

test('an incomplete, disabled or invalid config cancels the whole batch before any database write', async () => {
  for (const change of [
    data => { data.errorsWhileComputingFlags = true; },
    data => { delete data.flags.auth_signup_config; },
    data => { data.flags.ai_usage_limits_config.enabled = false; },
    data => { data.flags.reader_annotations_config.metadata.payload = '{bad json'; },
    data => { data.flags.reader_annotations_config.metadata.payload = '{"publicMarkThreshold":0}'; },
    data => { data.flags.auth_signup_config.metadata.payload = '{"invitationRequired":"false"}'; },
    data => { data.flags.ops_email_quota_config.metadata.payload = JSON.stringify({...configs['ops.email_quota'], criticalPercent: 50}); },
  ]) {
    const data = remote(); change(data);
    const calls = [];
    await assert.rejects(syncRuntimeConfig(env, async url => {
      calls.push(url);
      return Response.json(url.includes('/flags/') ? data : current);
    }));
    assert.equal(calls.length, 2);
    assert.ok(!calls.some(url => url.includes('operator_sync')));
  }
});

test('requires the migration and rejects nonpositive remote versions', () => {
  assert.throws(() => prepareUpdates(remote(), current.map(flag => ({...flag, configProvider: 'supabase'}))), /not enabled/);
  const data = remote(); data.flags.auth_signup_config.metadata.version = 0;
  assert.throws(() => prepareUpdates(data, current), /Missing or disabled/);
});

test('does not retry an ambiguous database publication or leak its response body', async () => {
  let writes = 0;
  await assert.rejects(syncRuntimeConfig(env, async url => {
    if (url.includes('/flags/')) return Response.json(remote());
    if (url.endsWith('operator_list_feature_flags')) return Response.json(current);
    writes++; return new Response('secret diagnostic', {status: 503});
  }), error => error.message === 'Configuration request failed: HTTP 503');
  assert.equal(writes, 1);
});
