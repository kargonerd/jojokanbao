import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseExecution } from '../src/monitor-events';
import { TaskMonitor } from '../src/monitor-object';

const slug = 'jojo-ai-availability';
const uuid = '11111111-1111-4111-8111-111111111111';
const pingUrl = `https://hc-ping.com/${uuid}`;
const base = Date.parse('2026-09-08T04:00:00Z');
const legacyResult = { ok: true, conversationId: 'jojo-ai-health-0123456789abcdef0123', durationMs: 123, tokens: 2 };
function historicalDirectSuccess() {
  // Freeze the four-field pre-rollout wire format. The current producer adds
  // cleanup diagnostics and cannot serve as a historical migration fixture.
  return { body: JSON.stringify(legacyResult), result: { ...legacyResult } };
}

let fixtureId = 0;
function monitorFixture() {
  const pings = [];
  const bodies = new Map();
  const stored = new Map();
  const deliveries = [];
  const faults = { body: false };
  let now = base;
  const add = (type, body, minute) => {
    const n = (pings.at(-1)?.n ?? 0) + 1;
    pings.push({ n, type, date: new Date(base + minute * 60_000).toISOString(), body_url: 'https://untrusted.example/ignored' });
    bodies.set(n, body);
  };
  const fail = (runId, minute) => add('log', [
    'monitor_event=v1', `task=${slug}`, `run_id=${runId}`, 'run_attempt=1',
    `event_time=${new Date(base + minute * 60_000).toISOString()}`,
    'outcome=failure', 'failure_class=retryable', `run=https://github.com/owner/repo/actions/runs/${runId}`,
  ].join('\n'), minute);
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = String(input);
    if (url === 'https://healthchecks.io/api/v3/checks/') return Response.json({ ping_url: pingUrl });
    if (url.endsWith('/pings/')) return Response.json({ pings: [...pings].reverse() });
    if (url.endsWith('/body')) {
      if (faults.body) return new Response('unavailable', { status: 503 });
      const n = Number(url.split('/').at(-2));
      expect(url).toBe(`https://healthchecks.io/api/v3/checks/${uuid}/pings/${n}/body`);
      return new Response(bodies.get(n));
    }
    expect([pingUrl, `${pingUrl}/fail`]).toContain(url);
    const signal = url.endsWith('/fail') ? 'fail' : 'success';
    deliveries.push({ signal, payload: JSON.parse(options.body) });
    add(signal, options.body, (now - base) / 60_000);
    return new Response('OK');
  }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const context = { storage: {
    get: async key => structuredClone(stored.get(key)),
    put: async (key, value) => { stored.set(key, structuredClone(value)); },
  } };
  const env = { HEALTHCHECKS_API_KEY: `ai-legacy-fixture-${++fixtureId}` };
  let monitor = new TaskMonitor(context, env);
  return { add, fail, faults, deliveries, state: () => stored.get('monitor'),
    restart: () => { monitor = new TaskMonitor(context, env); },
    tick: minute => { now = base + minute * 60_000; return monitor.tick({ slug, now }); },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('legacy AI direct-success handoff', () => {
  it('consumes the historical direct producer format using only its probe ID and inbox date', () => {
    const { body, result } = historicalDirectSuccess();
    expect(parseExecution(body, slug, base, true)).toEqual({
      id: `legacy:ai:${result.conversationId}`, at: base, outcome: 'success', permanent: false,
    });
    expect(parseExecution(body, slug, base)).toBeUndefined();
    expect(parseExecution(body, 'times-capture', base, true)).toBeUndefined();
    expect(parseExecution(body, slug, Number.NaN, true)).toBeUndefined();
  });

  it.each([
    ['failed probe', { ...legacyResult, ok: false }],
    ['failure report', { ok: false, reason: 'provider_auth_failed' }],
    ['decision ping', { taskId: slug, status: 'success' }],
    ['extra field', { ...legacyResult, run: 'https://github.com/owner/repo/actions/runs/1' }],
    ['missing field', { ok: true, conversationId: legacyResult.conversationId, durationMs: 1 }],
    ['wrong prefix', { ...legacyResult, conversationId: 'manual-ai-health-0123456789abcdef0123' }],
    ['wrong length', { ...legacyResult, conversationId: 'jojo-ai-health-0123456789abcdef0123456789abcdef' }],
    ['uppercase hex', { ...legacyResult, conversationId: 'jojo-ai-health-0123456789ABCDEF0123' }],
    ['trailing newline', { ...legacyResult, conversationId: `${legacyResult.conversationId}\n` }],
    ['negative duration', { ...legacyResult, durationMs: -1 }],
    ['string duration', { ...legacyResult, durationMs: '1' }],
    ['negative tokens', { ...legacyResult, tokens: -1 }],
    ['string tokens', { ...legacyResult, tokens: '2' }],
    ['null tokens', { ...legacyResult, tokens: null }],
    ['array', [legacyResult]], ['null', null],
  ])('ignores %s', (_label, result) => {
    expect(parseExecution(JSON.stringify(result), slug, base, true)).toBeUndefined();
  });

  it.each(['durationMs', 'tokens'])('rejects nonfinite %s parsed from JSON', field => {
    const body = JSON.stringify({ ...legacyResult, [field]: 'overflow' }).replace('"overflow"', '1e400');
    expect(parseExecution(body, slug, base, true)).toBeUndefined();
  });

  it('recovers internally without echo, persists deduplication, and can alert on the next v1 failure', async () => {
    const { body, result } = historicalDirectSuccess();
    const f = monitorFixture();
    f.fail(1, 1);
    await f.tick(2);
    expect(f.state().down).toBe(true);
    expect(f.deliveries.map(entry => entry.signal)).toEqual(['fail']);

    // /log with the same JSON never claims the direct heartbeat reached HC.
    f.add('log', body, 3);
    await f.tick(4);
    expect(f.state().down).toBe(true);
    f.add('success', body, 5);
    f.faults.body = true;
    const cursor = f.state().cursor;
    await expect(f.tick(6)).rejects.toThrow('HTTP 503');
    expect(f.state().cursor).toBe(cursor);
    f.restart();
    f.faults.body = false;
    await f.tick(7);
    expect(f.state()).toMatchObject({ down: false, executionFailures: 0, lastSuccessAt: base + 5 * 60_000 });
    expect(f.state().seen).toContain(`legacy:ai:${result.conversationId}`);
    expect(f.state().pending).toBeUndefined();
    expect(f.deliveries.map(entry => entry.signal)).toEqual(['fail']);

    f.restart();
    f.add('success', body, 8);
    await f.tick(9);
    expect(f.state().lastSuccessAt).toBe(base + 5 * 60_000);
    f.fail(2, 10);
    await f.tick(11);
    expect(f.state().down).toBe(true);
    expect(f.deliveries.map(entry => entry.signal)).toEqual(['fail', 'fail']);
    expect(f.deliveries[1].payload.run).toBe('https://github.com/owner/repo/actions/runs/2');
  });
});
