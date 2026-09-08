const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 10;
const MAX_MESSAGES = 200;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STATUSES = new Set(['queued', 'scheduled', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'suppressed', 'failed', 'opened', 'clicked', 'canceled']);
const DELIVERED = new Set(['delivered', 'opened', 'clicked']);
const FAILED = new Set(['bounced', 'complained', 'suppressed', 'failed', 'canceled']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAFE_CODE = /^(?:monitor_config_invalid|resend_(?:http_[1-5][0-9]{2}|network_error|response_invalid|scan_limit|message_limit)|recover_(?:http_[1-5][0-9]{2}|network_error)|transport_(?:timeout|config_invalid|identity_invalid|delivery_failed|message_ambiguous|scan_incomplete))$/;

const failure = (code) => new Error(code);
const safeCode = (error, fallback) => SAFE_CODE.test(error?.message ?? '') ? error.message : fallback;
const iso = (time) => new Date(time).toISOString();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mailbox(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\r\n\x00-\x1f]/.test(value)) return null;
  const input = value.trim();
  const wrapped = /^[^<>]*<([^<>]+)>$/.exec(input);
  const address = wrapped ? wrapped[1].trim() : input;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address)
    || address.length > 254 || address.includes('..')) return null;
  return address.toLowerCase();
}

function testMailbox(value) {
  return typeof value === 'string' && /^delivered\+[a-z0-9][a-z0-9_-]{0,62}@resend\.dev$/.test(value) ? value : null;
}

function createdTime(value) {
  // Resend list responses use PostgreSQL timestamps, including microseconds
  // and the short +00 offset. Normalize explicitly instead of local-time parsing.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)) return NaN;
  return Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
}

async function request(url, init, name, { fetcher, now }, deadline = Infinity) {
  const remaining = Math.min(10_000, deadline - now());
  if (remaining <= 0) throw failure('transport_timeout');
  let response;
  try {
    response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(Math.ceil(remaining)) });
  } catch {
    throw failure(now() >= deadline ? 'transport_timeout' : `${name}_network_error`);
  }
  if (!response.ok) throw failure(`${name}_http_${response.status}`);
  return response;
}

async function readPage(apiKey, cursor, dependencies, deadline) {
  const url = new URL('https://api.resend.com/emails');
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('after', cursor);
  const response = await request(url.href, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } }, 'resend', dependencies, deadline);
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw failure('resend_response_invalid');
    const reader = response.body?.getReader();
    if (!reader) throw failure('resend_response_invalid');
    let bytes = 0;
    let text = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw failure('resend_response_invalid');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    const page = JSON.parse(text);
    if (!page || page.object !== 'list' || typeof page.has_more !== 'boolean'
      || !Array.isArray(page.data) || page.data.length > 100 || (page.has_more && page.data.length === 0)) throw failure('resend_response_invalid');
    return page;
  } catch (error) {
    if (dependencies.now() >= deadline) throw failure('transport_timeout');
    throw failure(safeCode(error, 'resend_response_invalid'));
  }
}

function parseMessage(raw, previousTime, now) {
  const time = createdTime(raw?.created_at);
  const from = mailbox(raw?.from);
  if (!raw || !UUID.test(raw.id ?? '') || !Number.isFinite(time) || time > previousTime || time > now + 60_000
    || !from || !STATUSES.has(raw.last_event) || !Array.isArray(raw.to) || raw.to.length < 1
    || raw.to.length > 100 || raw.to.some((address) => !mailbox(address))) throw failure('resend_response_invalid');
  return { id: raw.id.toLowerCase(), createdAt: iso(time), status: raw.last_event, time, from, to: raw.to.map(mailbox) };
}

async function scan(apiKey, sender, since, dependencies, deadline = Infinity) {
  const messages = [];
  const seen = new Set();
  let cursor;
  let previousTime = Infinity;
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      if (pageNumber > 0) {
        if (dependencies.now() + 1000 >= deadline) throw failure('transport_timeout');
        await dependencies.sleep(1000);
      }
      const page = await readPage(apiKey, cursor, dependencies, deadline);
      let reachedBoundary = false;
      for (const raw of page.data) {
        const message = parseMessage(raw, previousTime, dependencies.now());
        previousTime = message.time;
        if (seen.has(message.id)) throw failure('resend_response_invalid');
        seen.add(message.id);
        cursor = message.id;
        if (message.time < since) { reachedBoundary = true; continue; }
        if (message.from !== sender) continue;
        if (messages.length === MAX_MESSAGES) return { messages, scanComplete: false, scanError: 'resend_message_limit' };
        messages.push(message);
      }
      if (reachedBoundary || !page.has_more) return { messages, scanComplete: true };
    }
    return { messages, scanComplete: false, scanError: 'resend_scan_limit' };
  } catch (error) {
    return { messages, scanComplete: false, scanError: safeCode(error, 'resend_network_error') };
  }
}

function transportIntent(env, now) {
  const forced = env.JOJO_EMAIL_VERIFY_TRANSPORT === 'true';
  const automatic = env.JOJO_EMAIL_AUTOMATIC === 'true';
  if (!forced && !automatic) return null;
  // Workflow retries are observational only. A fresh explicit manual run is
  // the escape hatch for initial acceptance, not an automatic retry mechanism.
  if (env.GITHUB_RUN_ATTEMPT !== '1') return null;
  if (forced) return { forced: true };
  const scheduled = Date.parse(env.JOJO_EMAIL_SCHEDULED_AT ?? '');
  if (!Number.isFinite(scheduled) || iso(scheduled) !== env.JOJO_EMAIL_SCHEDULED_AT
    || env.JOJO_EMAIL_SCHEDULE_SLOT !== `jojo-email-delivery:${iso(scheduled)}`) return null;
  const slot = new Date(scheduled);
  if (slot.getUTCHours() % 4 !== 0 || slot.getUTCMinutes() !== 8 || slot.getUTCSeconds() !== 0
    || slot.getUTCMilliseconds() !== 0 || scheduled > now || now - scheduled >= 15 * 60_000) return null;
  return { forced: false, scheduled };
}

function transportConfig(env) {
  const address = testMailbox(env.JOJO_EMAIL_MONITOR_ADDRESS);
  if (!address) throw failure('transport_config_invalid');
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key)) throw failure('transport_config_invalid');
  let auth;
  try { auth = new URL(env.VITE_SUPABASE_URL); } catch { throw failure('transport_config_invalid'); }
  if (auth.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(auth.hostname) || auth.port
    || auth.username || auth.password || auth.search || auth.hash || auth.pathname !== '/') throw failure('transport_config_invalid');
  return { address, key, url: `${auth.origin}/auth/v1/recover` };
}

async function verifyTransport(env, apiKey, sender, baseline, intent, dependencies) {
  let config;
  try { config = transportConfig(env); } catch (error) {
    return { observation: { outcome: 'failure', at: iso(dependencies.now()), reason: safeCode(error, 'transport_config_invalid') }, messages: [] };
  }
  if (!intent.forced && baseline.some((message) => message.time >= intent.scheduled && message.to.length === 1 && message.to[0] === config.address)) {
    return { observation: { outcome: 'not_run', at: iso(dependencies.now()) }, messages: [] };
  }
  const started = dependencies.now();
  const deadline = started + 60_000;
  const baselineIds = new Set(baseline.map((message) => message.id));
  let observed = [];
  let scanError;
  try {
    // Do not verify the OTP, establish a recovery session, or update a password.
    const response = await request(config.url, {
      method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.address }),
    }, 'recover', dependencies, deadline);
    await response.body?.cancel().catch(() => {});
    for (;;) {
      const result = await scan(apiKey, sender, started, dependencies, deadline);
      observed = result.messages;
      if (!result.scanComplete) {
        scanError = result.scanError;
        throw failure(scanError === 'resend_scan_limit' || scanError === 'resend_message_limit' ? 'transport_scan_incomplete' : scanError);
      }
      if (dependencies.now() >= deadline) throw failure('transport_timeout');
      const candidates = observed.filter((message) => !baselineIds.has(message.id) && message.time >= started
        && message.to.length === 1 && message.to[0] === config.address);
      if (candidates.length > 1) throw failure('transport_message_ambiguous');
      const candidate = candidates[0];
      if (candidate && DELIVERED.has(candidate.status)) return { observation: { outcome: 'success', at: iso(dependencies.now()), messageId: candidate.id }, messages: observed };
      if (candidate && FAILED.has(candidate.status)) return { observation: { outcome: 'failure', at: iso(dependencies.now()), reason: 'transport_delivery_failed', messageId: candidate.id }, messages: observed };
      const remaining = deadline - dependencies.now();
      if (remaining <= 5000) throw failure('transport_timeout');
      await dependencies.sleep(5000);
    }
  } catch (error) {
    return { observation: { outcome: 'failure', at: iso(dependencies.now()), reason: safeCode(error, 'recover_network_error') }, messages: observed, ...(scanError ? { scanError } : {}) };
  }
}

export async function probe(env, fetcher = fetch, options = {}) {
  const dependencies = { fetcher, now: options.now ?? Date.now, sleep: options.sleep ?? defaultSleep };
  const started = dependencies.now();
  const scanStart = iso(started - DAY_MS);
  const sender = mailbox(env.JOJO_EMAIL_SENDER);
  const monitorAddress = testMailbox(env.JOJO_EMAIL_MONITOR_ADDRESS);
  const apiKey = env.RESEND_MONITOR_API_KEY;
  // The dedicated recipient is required even for passive scans so an omitted
  // filter cannot turn an old synthetic delivery into business-mail evidence.
  if (!sender || !monitorAddress || typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey)) {
    return { scanStart, scanComplete: false, messages: [], scanError: 'monitor_config_invalid', transportProbe: { outcome: 'not_run', at: iso(dependencies.now()) } };
  }
  const result = await scan(apiKey, sender, started - DAY_MS, dependencies);
  let transportProbe = { outcome: 'not_run', at: iso(dependencies.now()) };
  const intent = transportIntent(env, dependencies.now());
  // Never send a test message when its delivery cannot be observed reliably.
  if (intent && result.scanComplete) {
    const transport = await verifyTransport(env, apiKey, sender, result.messages, intent, dependencies);
    transportProbe = transport.observation;
    if (transport.scanError) {
      result.scanComplete = false;
      result.scanError = transport.scanError;
    }
    const merged = new Map(result.messages.map((message) => [message.id, message]));
    for (const message of transport.messages) merged.set(message.id, message);
    result.messages = [...merged.values()];
    if (result.messages.length > MAX_MESSAGES) {
      result.messages = result.messages.slice(0, MAX_MESSAGES);
      result.scanComplete = false;
      result.scanError = 'resend_message_limit';
    }
  }
  return {
    scanStart, scanComplete: result.scanComplete,
    // Test-recipient delivery proves the SMTP path only. Never let it recover
    // an incident involving real recipients on this or a later passive scan.
    messages: result.messages.filter((message) => !message.to.includes(monitorAddress))
      .map(({ id, createdAt, status }) => ({ id, createdAt, status })),
    ...(result.scanError ? { scanError: result.scanError } : {}), transportProbe,
  };
}
