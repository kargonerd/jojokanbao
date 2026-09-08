import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runHealthcheck } from './run.mjs';

const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'kargonerd/jojokanbao',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  JOJO_EMAIL_HEALTHCHECK_PING_URL: 'https://hc-ping.com/12345678-1234-1234-1234-123456789012' };
const result = () => ({ scanStart: new Date(Date.now() - 86400_000).toISOString(), scanComplete: true,
  messages: [], transportProbe: { outcome: 'not_run', at: new Date().toISOString() } });

test('empty scan is buffered as observation, never a direct health success', async () => {
  const calls = [];
  const summary = await runHealthcheck(env, async (url, options) => {
    calls.push([url, options]); return new Response('OK');
  }, async () => result());
  assert.deepEqual(summary, { ok: true, scannedMessages: 0, scanComplete: true, transport: 'not_run' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${env.JOJO_EMAIL_HEALTHCHECK_PING_URL}/log`);
  const observation = JSON.parse(calls[0][1].body);
  assert.equal(observation.mail_observation, 'v1');
  assert.equal(observation.task, 'jojo-email-delivery');
  assert.equal(observation.run, 'https://github.com/kargonerd/jojokanbao/actions/runs/123');
  assert.equal(observation.transportProbe.outcome, 'not_run');
});

test('unexpected provider exceptions are redacted and fail the collector', async () => {
  let reported;
  const summary = await runHealthcheck(env, async (_, options) => {
    reported = options.body; return new Response('OK');
  }, async () => { throw new Error('private@example.com OTP 123456 token=re_secret'); });
  assert.equal(summary.ok, false);
  assert.equal(JSON.parse(reported).scanError, 'probe_internal_error');
  assert.doesNotMatch(reported, /private@example|123456|re_secret/);
});

test('report failure is not replaced with a health success', async () => {
  await assert.rejects(runHealthcheck(env, async () => new Response('sensitive', { status: 503 }), async () => result()), /^Error: monitor_report_failed$/);
});

test('invalid report destination or workflow identity fails before data access', async () => {
  let accessed = false;
  for (const change of [
    { JOJO_EMAIL_HEALTHCHECK_PING_URL: 'https://attacker.example/leak' },
    { JOJO_EMAIL_HEALTHCHECK_PING_URL: `${env.JOJO_EMAIL_HEALTHCHECK_PING_URL}?token=bad` },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_RUN_ID: '123\nfalse' },
  ]) {
    await assert.rejects(runHealthcheck({ ...env, ...change }, async () => { accessed = true; }, async () => { accessed = true; }));
  }
  assert.equal(accessed, false);
});

test('workflow keeps credentials and live reads away from PR runs and uses existing scheduler', () => {
  const source = readFileSync(new URL('../../.github/workflows/monitor-email.yml', import.meta.url), 'utf8');
  assert.match(source, /github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/master'/);
  assert.match(source, /permissions:\s+contents: read/);
  assert.doesNotMatch(source, /\n\s+schedule:|SUPABASE_ACCESS_TOKEN|service_role|upload-artifact|actions\/cache/);
  assert.match(source, /JOJO_EMAIL_VERIFY_TRANSPORT: \$\{\{ inputs.verify_transport \}\}/);
});
