import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from './probe.mjs';

const NOW = Date.parse('2026-09-09T00:08:01.000Z');
const sender = 'auth@example.com';
const monitorAddress = 'delivered+jojo-monitor@resend.dev';
const env = {
  RESEND_MONITOR_API_KEY: 'private-resend-token', JOJO_EMAIL_SENDER: sender,
  JOJO_EMAIL_MONITOR_ADDRESS: monitorAddress,
  VITE_SUPABASE_URL: 'https://testproject.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'private-publishable-key',
  GITHUB_RUN_ATTEMPT: '1',
};
const uuid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const message = (number, overrides = {}) => ({
  id: uuid(number), created_at: new Date(NOW - number * 1000).toISOString(),
  from: `JOJO <${sender}>`, to: ['private-recipient@example.net'], last_event: 'delivered',
  subject: 'private-subject', ...overrides,
});
const page = (data = [], more = false) => Response.json({ object: 'list', has_more: more, data });
function clock(start = NOW) {
  let time = start;
  return { now: () => time, sleep: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}
function automatic(at = '2026-09-09T00:08:00.000Z') {
  return { ...env, JOJO_EMAIL_AUTOMATIC: 'true', JOJO_EMAIL_SCHEDULED_AT: at, JOJO_EMAIL_SCHEDULE_SLOT: `jojo-email-delivery:${at}` };
}
const manual = { ...env, JOJO_EMAIL_VERIFY_TRANSPORT: 'true' };

test('reads only bounded metadata and returns no credentials, addresses, subjects, or bodies', async () => {
  const calls = [];
  const result = await probe(env, async (url, options) => {
    calls.push({ url, options });
    return page([message(1)]);
  }, clock());
  assert.deepEqual(result, {
    scanStart: '2026-09-08T00:08:01.000Z', scanComplete: true,
    messages: [{ id: uuid(1), createdAt: '2026-09-09T00:08:00.000Z', status: 'delivered' }],
    transportProbe: { outcome: 'not_run', at: new Date(NOW).toISOString() },
  });
  assert.equal(calls[0].url, 'https://api.resend.com/emails?limit=100');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.RESEND_MONITOR_API_KEY}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result), /private-|example\.com|example\.net|resend\.dev|subject|html/);
});

test('matches the parsed sender mailbox exactly and normalizes Resend PostgreSQL timestamps', async () => {
  const result = await probe(env, async () => page([
    message(1, { from: 'JOJO <AUTH@EXAMPLE.COM>', created_at: '2026-09-09 00:08:00.674981+00' }),
    message(2, { from: 'auth@example.com <impostor@example.com>' }),
    message(3, { from: 'auth@example.com.evil' }),
    message(4, { from: 'other+auth@example.com' }),
  ]), clock());
  assert.equal(result.scanComplete, true);
  assert.deepEqual(result.messages, [{ id: uuid(1), createdAt: '2026-09-09T00:08:00.674Z', status: 'delivered' }]);
});

test('follows after cursors only until the full 24-hour window is covered', async () => {
  const urls = [];
  const result = await probe(env, async (url) => {
    urls.push(url);
    if (urls.length === 1) return page([message(1), message(2)], true);
    return page([message(3), message(4, { created_at: '2026-09-07T00:00:00.000Z' })], true);
  }, clock());
  assert.equal(result.scanComplete, true);
  assert.equal(result.messages.length, 3);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get('after'), uuid(2));
});

test('empty history is a successful scan, not a successful transport probe', async () => {
  const result = await probe(env, async () => page(), clock());
  assert.equal(result.scanComplete, true);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(NOW).toISOString() });
});

test('passive scans exclude the exact test recipient without hiding real recipient delivery', async () => {
  const result = await probe(env, async () => page([
    message(1, { to: [monitorAddress] }),
    message(2, { to: [`Monitor <${monitorAddress.toUpperCase()}>`] }),
    message(3, { to: [monitorAddress, 'private-recipient@example.net'] }),
    message(4, { to: ['delivered+different-label@resend.dev'] }),
    message(5, { last_event: 'bounced' }),
  ]), clock());
  assert.equal(result.scanComplete, true);
  assert.deepEqual(result.messages.map(({ id }) => id), [uuid(4), uuid(5)]);
  assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(NOW).toISOString() });
});

test('more than 200 matching messages makes coverage explicitly incomplete', async () => {
  let requests = 0;
  const result = await probe(env, async () => {
    const offset = requests++ * 100;
    return page(Array.from({ length: 100 }, (_, i) => message(offset + i + 1)), true);
  }, clock());
  assert.equal(requests, 3);
  assert.equal(result.scanComplete, false);
  assert.equal(result.scanError, 'resend_message_limit');
  assert.equal(result.messages.length, 200);
});

test('ten pages without reaching the window boundary fail closed even for unrelated mail', async () => {
  let requests = 0;
  const result = await probe(env, async () => {
    const offset = requests++ * 100;
    return page(Array.from({ length: 100 }, (_, i) => message(offset + i + 1, { from: 'other@example.com' })), true);
  }, clock());
  assert.equal(requests, 10);
  assert.equal(result.scanComplete, false);
  assert.equal(result.scanError, 'resend_scan_limit');
});

test('invalid, duplicated, out-of-order, future, or unknown-status results cannot claim coverage', async (t) => {
  for (const [name, value] of [
    ['missing-list', {}], ['empty-next-page', { object: 'list', has_more: true, data: [] }],
    ['missing-id', { object: 'list', has_more: false, data: [message(1, { id: 'private-subject' })] }],
    ['duplicate', { object: 'list', has_more: false, data: [message(1), message(1)] }],
    ['wrong-order', { object: 'list', has_more: false, data: [message(2), message(1)] }],
    ['future', { object: 'list', has_more: false, data: [message(1, { created_at: '2026-09-10T00:00:00Z' })] }],
    ['null-status', { object: 'list', has_more: false, data: [message(1, { last_event: null })] }],
    ['untrusted-status', { object: 'list', has_more: false, data: [message(1, { last_event: 'private-subject' })] }],
    ['sender-header-injection', { object: 'list', has_more: false, data: [message(1, { from: `${sender}\r\nOther: value` })] }],
  ]) {
    await t.test(name, async () => {
      const result = await probe(env, async () => Response.json(value), clock());
      assert.equal(result.scanComplete, false);
      assert.equal(result.scanError, 'resend_response_invalid');
      assert.doesNotMatch(JSON.stringify(result), /private-/);
    });
  }
});

test('request, response, and HTTP errors are sanitized and never cause a recover request', async (t) => {
  for (const [name, fetcher, reason] of [
    ['network', async () => { throw new Error('private-token private-recipient@example.com'); }, 'resend_network_error'],
    ['unauthorized', async () => new Response('private-token', { status: 401 }), 'resend_http_401'],
    ['rate-limit', async () => new Response('private-token', { status: 429 }), 'resend_http_429'],
    ['redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), 'resend_http_302'],
    ['bad-json', async () => new Response('private-subject'), 'resend_response_invalid'],
    ['oversize', async () => new Response('x'.repeat(1024 * 1024 + 1)), 'resend_response_invalid'],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await probe(manual, (...args) => { calls += 1; return fetcher(...args); }, clock());
      assert.equal(calls, 1);
      assert.equal(result.scanComplete, false);
      assert.equal(result.scanError, reason);
      assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(NOW).toISOString() });
      assert.doesNotMatch(JSON.stringify(result), /private-|evil|recipient/);
    });
  }
});

test('invalid configuration is rejected before using credentials', async () => {
  for (const bad of [{ JOJO_EMAIL_SENDER: 'invalid' }, { JOJO_EMAIL_SENDER: `${sender}\nheader` }, { RESEND_MONITOR_API_KEY: '' }]) {
    const result = await probe({ ...manual, ...bad }, async () => { assert.fail('unexpected network'); }, clock());
    assert.equal(result.scanError, 'monitor_config_invalid');
  }
});

test('only the six four-hour slots authorize an automatic recover request', async (t) => {
  for (const hour of [0, 4, 8, 12, 16, 20]) {
    await t.test(String(hour), async () => {
      const slot = `2026-09-09T${String(hour).padStart(2, '0')}:08:00.000Z`;
      const time = clock(Date.parse(slot) + 1000);
      let posts = 0;
      let reads = 0;
      const result = await probe(automatic(slot), async (url, options) => {
        if (options.method === 'POST') { posts += 1; return Response.json({}); }
        return reads++ === 0 ? page() : page([message(10, { created_at: new Date(time.now()).toISOString(), to: [monitorAddress] })]);
      }, time);
      assert.equal(posts, 1);
      assert.equal(result.transportProbe.outcome, 'success');
    });
  }
});

test('ordinary slots, retries, malformed slots and stale/future invocations never send', async (t) => {
  for (const [name, input, time] of [
    ['15-min-slot', automatic('2026-09-09T00:23:00.000Z'), Date.parse('2026-09-09T00:23:01Z')],
    ['hour-not-due', automatic('2026-09-09T01:08:00.000Z'), Date.parse('2026-09-09T01:08:01Z')],
    ['not-automatic', { ...automatic(), JOJO_EMAIL_AUTOMATIC: 'false' }, NOW],
    ['rerun', { ...automatic(), GITHUB_RUN_ATTEMPT: '2' }, NOW],
    ['manual-rerun', { ...manual, GITHUB_RUN_ATTEMPT: '2' }, NOW],
    ['missing-attempt', { ...automatic(), GITHUB_RUN_ATTEMPT: '' }, NOW],
    ['wrong-id', { ...automatic(), JOJO_EMAIL_SCHEDULE_SLOT: 'wrong-slot' }, NOW],
    ['invalid-time', { ...automatic(), JOJO_EMAIL_SCHEDULED_AT: 'not-a-time' }, NOW],
    ['stale', automatic(), Date.parse('2026-09-09T00:23:00Z')],
    ['future', automatic(), Date.parse('2026-09-09T00:07:59Z')],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await probe(input, async (_url, options) => { calls += 1; assert.equal(options.method, 'GET'); return page(); }, clock(time));
      assert.equal(calls, 1);
      assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(time).toISOString() });
    });
  }
});

test('a prior test message in the same slot prevents duplicate automatic sends', async () => {
  let calls = 0;
  const result = await probe(automatic(), async (_url, options) => {
    calls += 1;
    assert.equal(options.method, 'GET');
    return page([message(1, { to: [monitorAddress] })]);
  }, clock());
  assert.equal(calls, 1);
  assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(NOW).toISOString() });
});

test('explicit manual verification performs only recover and confirms a new matching delivery', async () => {
  const calls = [];
  let reads = 0;
  const time = clock();
  const result = await probe(manual, async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      assert.equal(url, 'https://testproject.supabase.co/auth/v1/recover');
      assert.equal(options.headers.apikey, env.VITE_SUPABASE_PUBLISHABLE_KEY);
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), { email: monitorAddress });
      return Response.json({});
    }
    reads += 1;
    if (reads === 1) return page([message(1, { to: [monitorAddress] })]);
    return page([message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress], last_event: reads === 2 ? 'sent' : 'delivered' })]);
  }, time);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
  assert.equal(reads, 3);
  assert.deepEqual(result.transportProbe, { outcome: 'success', at: '2026-09-09T00:08:06.000Z', messageId: uuid(20) });
  assert.deepEqual(result.messages, []);
  assert.doesNotMatch(JSON.stringify(result), /private-|@|subject|body/);
});

test('only delivered, opened, and clicked count as confirmed transport success', async (t) => {
  for (const status of ['delivered', 'opened', 'clicked']) {
    await t.test(status, async () => {
      let reads = 0;
      const result = await probe(manual, async (_url, options) => {
        if (options.method === 'POST') return Response.json({});
        return reads++ === 0 ? page() : page([message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress], last_event: status })]);
      }, clock());
      assert.equal(result.transportProbe.outcome, 'success');
    });
  }
});

test('sent mail, old mail, wrong recipients, wrong senders, and reused IDs cannot prove transport', async (t) => {
  for (const [name, candidate, baseline] of [
    ['pending', message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress], last_event: 'sent' }), []],
    ['old', message(20, { to: [monitorAddress] }), []],
    ['wrong-recipient', message(20, { created_at: new Date(NOW).toISOString() }), []],
    ['multiple-recipients', message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress, 'other@example.net'] }), []],
    ['wrong-sender', message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress], from: 'other@example.com' }), []],
    ['reused-id', message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress] }), [message(20, { to: [monitorAddress] })]],
  ]) {
    await t.test(name, async () => {
      let reads = 0;
      let posts = 0;
      const time = clock();
      const result = await probe(manual, async (_url, options) => {
        if (options.method === 'POST') { posts += 1; return Response.json({}); }
        return page(reads++ === 0 ? baseline : [candidate]);
      }, time);
      assert.equal(posts, 1);
      assert.equal(result.transportProbe.outcome, 'failure');
      assert.equal(result.transportProbe.reason, 'transport_timeout');
      assert.ok(time.now() - NOW <= 60_000);
      assert.ok(reads <= 13);
    });
  }
});

test('terminal failure and ambiguous fresh messages cannot report successful transport', async (t) => {
  for (const [name, messages, expected] of [
    ['bounced', [message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress], last_event: 'bounced' })], 'transport_delivery_failed'],
    ['ambiguous', [message(20, { created_at: new Date(NOW).toISOString(), to: [monitorAddress] }), message(21, { created_at: new Date(NOW).toISOString(), to: [monitorAddress] })], 'transport_message_ambiguous'],
  ]) {
    await t.test(name, async () => {
      let reads = 0;
      const result = await probe(manual, async (_url, options) => options.method === 'POST' ? Response.json({}) : reads++ === 0 ? page() : page(messages), clock());
      assert.equal(result.transportProbe.outcome, 'failure');
      assert.equal(result.transportProbe.reason, expected);
    });
  }
});

test('every scan requires a valid dedicated test recipient before fetching any mail', async (t) => {
  for (const [name, address] of [
    ['missing', undefined], ['empty', ''], ['malformed', 'not-an-email'],
    ['real-person', 'person@example.com'], ['missing-label', 'delivered@resend.dev'],
    ['wrong-domain', 'delivered+label@resend.dev.evil'], ['display-name', 'Name <delivered+label@resend.dev>'],
  ]) {
    await t.test(name, async () => {
      for (const input of [env, manual]) {
        const result = await probe({ ...input, JOJO_EMAIL_MONITOR_ADDRESS: address }, async () => {
          assert.fail('invalid recipient must prevent both metadata reads and sending');
        }, clock());
        assert.equal(result.scanComplete, false);
        assert.equal(result.scanError, 'monitor_config_invalid');
        assert.deepEqual(result.messages, []);
        assert.deepEqual(result.transportProbe, { outcome: 'not_run', at: new Date(NOW).toISOString() });
      }
    });
  }
});

test('rejects non-project Auth endpoints without sending', async (t) => {
  for (const bad of [
    { VITE_SUPABASE_URL: 'https://evil.example' }, { VITE_SUPABASE_URL: 'http://testproject.supabase.co' },
    { VITE_SUPABASE_URL: 'https://testproject.supabase.co:444' }, { VITE_SUPABASE_URL: 'https://testproject.supabase.co/other' },
    { VITE_SUPABASE_URL: 'https://private-token@testproject.supabase.co' }, { VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  ]) {
    await t.test(Object.values(bad)[0], async () => {
      let calls = 0;
      const result = await probe({ ...manual, ...bad }, async (_url, options) => { calls += 1; assert.equal(options.method, 'GET'); return page(); }, clock());
      assert.equal(calls, 1);
      assert.equal(result.transportProbe.reason, 'transport_config_invalid');
    });
  }
});

test('recover errors and follow-up read errors are sanitized without retrying the send', async (t) => {
  for (const [name, fail, expected] of [
    ['recover-http', 'post-http', 'recover_http_500'], ['recover-network', 'post-network', 'recover_network_error'],
    ['poll-http', 'get-http', 'resend_http_403'], ['poll-network', 'get-network', 'resend_network_error'],
  ]) {
    await t.test(name, async () => {
      let reads = 0;
      let posts = 0;
      const result = await probe(manual, async (_url, options) => {
        if (options.method === 'POST') {
          posts += 1;
          if (fail === 'post-http') return new Response('private-token private-address', { status: 500 });
          if (fail === 'post-network') throw new Error('private-token private-address');
          return Response.json({});
        }
        if (reads++ === 0) return page();
        if (fail === 'get-http') return new Response('private-token', { status: 403 });
        throw new Error('private-address');
      }, clock());
      assert.equal(posts, 1);
      assert.equal(result.transportProbe.reason, expected);
      assert.equal(result.scanComplete, !fail.startsWith('get-'));
      assert.equal(result.scanError, fail.startsWith('get-') ? expected : undefined);
      assert.doesNotMatch(JSON.stringify(result), /private-/);
    });
  }
});
