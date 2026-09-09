import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, parseUsage, parsePolicy, signals, run, SLUG, PERIODS, LEVELS } from './monitor.mjs';
const now = Date.parse('2026-09-09T12:00:00Z');
const env = { RESEND_QUOTA_API_KEY: 're_test', HEALTHCHECKS_API_KEY: 'test', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test' };
const usage = (daily = 43, monthly = 64) => ({ object: 'usage', generated_at: new Date(now).toISOString(), emails: {
  daily: { used: daily, limit: 100, resets_at: '2026-09-10T00:00:00Z' }, monthly: { used: monthly, limit: 3000, resets_at: '2026-10-01T00:00:00Z' },
} });
const policy = { warningPercent: 80, criticalPercent: 90 };
function fixture() {
  const slugs = [SLUG, ...PERIODS.flatMap((p) => LEVELS.map((l) => `${SLUG}-${p}-${l}`))];
  const checks = slugs.map((slug, i) => ({ slug, status: 'up', ping_url: `https://hc-ping.com/00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
  const data = { raw: usage(), usageStatus: 200, config: policy, checks, writes: [], transitions: [], history: new Map(), ignored: false, seen: [] };
  data.fetcher = async (url, init = {}) => {
    data.seen.push({ url, init });
    if (url === 'https://api.resend.com/usage') return Response.json(data.raw, { status: data.usageStatus });
    if (url.includes('/rpc/')) return Response.json(data.config);
    if (url === 'https://healthchecks.io/api/v3/checks/') return Response.json({ checks });
    if (url.startsWith('https://healthchecks.io/')) {
      const id = url.split('/')[6];
      const body = data.history.get(id);
      return Response.json(url.endsWith('/body') ? body : { pings: body ? [{ n: 1, type: 'fail' }] : [] });
    }
    const check = checks.find((check) => url.startsWith(check.ping_url));
    assert.ok(check);
    const down = url.endsWith('/fail'); const body = JSON.parse(init.body);
    data.writes.push({ slug: check.slug, down, body });
    if (data.ignored) return new Response('OK (rate limited)');
    const status = down ? 'down' : 'up';
    if (status !== check.status) data.transitions.push({ slug: check.slug, down });
    check.status = status;
    if (down) data.history.set(check.ping_url.split('/').at(-1), body);
    return new Response('OK');
  };
  return data;
}
test('exact boundaries independently cover daily and monthly quotas', () => {
  for (const [used, count] of [[79, 0], [80, 1], [89, 1], [90, 2], [99, 2], [100, 3], [101, 3]]) {
    const rows = signals(parseUsage(usage(used, used * 30), now), parsePolicy(policy));
    assert.equal(rows.filter((r) => r.down).length, count * 2);
  }
});
test('paid daily unlimited is not zero; monthly still warns', () => {
  const raw = usage(100000, 2700); raw.emails.daily.limit = null;
  assert.deepEqual(signals(parseUsage(raw, now), parsePolicy(policy)).filter((r) => r.down).map((r) => r.period), ['monthly', 'monthly']);
});
test('missing, stale, negative, zero-limit and already-reset usage is rejected', () => {
  for (const mutate of [(r) => delete r.emails.monthly, (r) => r.generated_at = '2026-09-09T11:44:00Z',
    (r) => r.emails.daily.used = -1, (r) => r.emails.daily.limit = 0, (r) => r.emails.monthly.limit = null,
    (r) => r.emails.daily.resets_at = '2026-09-09T00:00:00Z']) {
    const raw = usage(); mutate(raw); assert.throws(() => parseUsage(raw, now));
  }
  for (const config of [{}, { warningPercent: 90, criticalPercent: 80 }, { warningPercent: 80, criticalPercent: 100 }]) assert.throws(() => parsePolicy(config));
});
test('repeated invocations stay down without duplicate transition notifications, then recover', async () => {
  const f = fixture(); f.raw = usage(90);
  assert.equal((await run(env, { now, fetcher: f.fetcher })).ok, true);
  assert.equal((await run(env, { now, fetcher: f.fetcher })).ok, true);
  assert.equal(f.transitions.filter((r) => r.down).length, 2);
  f.raw = usage(1);
  assert.equal((await run(env, { now, fetcher: f.fetcher })).ok, true);
  assert.equal(f.transitions.filter((r) => !r.down).length, 2);
});
test('new quota period alerts even if the first observation already exceeds the same threshold', async () => {
  const f = fixture(); f.raw = usage(81);
  await run(env, { now, fetcher: f.fetcher });
  const next = now + 86_400_000;
  f.raw.generated_at = new Date(next).toISOString(); f.raw.emails.daily.resets_at = '2026-09-11T00:00:00Z';
  assert.equal((await run(env, { now: next, fetcher: f.fetcher })).ok, true);
  assert.equal(f.transitions.filter((r) => r.down).length, 2);
});
test('usage failure alerts on collector only and never clears an existing quota incident', async () => {
  const f = fixture(); f.raw = usage(80); await run(env, { now, fetcher: f.fetcher }); f.writes.length = 0;
  f.usageStatus = 403;
  const result = await run(env, { now, fetcher: f.fetcher });
  assert.equal(result.error, 'resend_http_403');
  assert.deepEqual(f.writes.map(({ slug, down }) => ({ slug, down })), [{ slug: SLUG, down: true }]);
  assert.equal(f.checks[1].status, 'down');
});
test('probe reads only; no email sending endpoint, even when over quota', async () => {
  const f = fixture(); f.raw = usage(100);
  assert.equal((await handle({ mode: 'probe' }, env, { now, fetcher: f.fetcher })).ok, true);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.seen.filter((r) => r.url.startsWith('https://api.resend.com/')).map((r) => [r.url, r.init.method ?? 'GET']), [['https://api.resend.com/usage', 'GET']]);
});
test('ignored Healthchecks HTTP 200 is a failure, and malformed checks cannot leak credentials', async () => {
  const f = fixture(); f.ignored = true;
  assert.equal((await run(env, { now, fetcher: f.fetcher })).ok, false);
  f.checks[0].ping_url = 'https://attacker.invalid/'; f.writes.length = 0;
  assert.equal((await run(env, { now, fetcher: f.fetcher })).ok, false);
  assert.equal(f.writes.length, 0);
});
test('timer replays and wrong triggers do not call external services', async () => {
  const fetcher = () => { throw new Error('must not run'); };
  for (const event of [{}, { Type: 'Timer', Time: new Date(now - 360000).toISOString(), TriggerName: 'email-quota-half-hour' },
    { Type: 'Timer', Time: new Date(now).toISOString(), TriggerName: 'other' }]) {
    assert.equal((await handle(event, env, { now, fetcher })).skipped, 'invalid_or_stale_timer');
  }
});
