// Resend and Healthchecks are the only outbound services besides public config.
// Healthchecks persists each threshold's up/down state across cold starts.
export const PERIODS = ['daily', 'monthly'];
export const LEVELS = ['warning', 'critical', 'exhausted'];
export const SCHEDULE = '0,30 * * * *';
export const TRIGGER = '0 0,30 * * * * *';
export const SLUG = 'jojo-email-quota';
const MAX_BYTES = 64 * 1024;
const DAY = 86_400_000;
const fail = (code) => new Error(code);
const safe = (error) => /^[a-z][a-z0-9_]{0,79}$/.test(error?.message ?? '') ? error.message : 'quota_monitor_failed';

async function request(url, init, service, fetcher) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw fail(`${service}_http_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw fail(`${service}_invalid_response`);
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw fail(`${service}_response_too_large`);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error?.message?.startsWith(`${service}_`)) throw error;
    throw fail(`${service}_request_failed`);
  }
}

async function json(url, init, service, fetcher) {
  const text = await request(url, init, service, fetcher);
  try { return JSON.parse(text); } catch { throw fail(`${service}_invalid_response`); }
}

export function parseUsage(raw, now) {
  const generated = Date.parse(raw?.generated_at);
  if (raw?.object !== 'usage' || !Number.isFinite(generated) || generated > now + 60_000
    || now - generated > 15 * 60_000) throw fail('resend_usage_stale_or_invalid');
  const result = { generatedAt: new Date(generated).toISOString(), periods: {} };
  for (const period of PERIODS) {
    const row = raw.emails?.[period];
    const resets = Date.parse(row?.resets_at);
    if (!row || !Number.isSafeInteger(row.used) || row.used < 0
      || !(row.limit === null && period === 'daily') && (!Number.isSafeInteger(row.limit) || row.limit < 1)
      || !Number.isFinite(resets) || resets <= now
      || resets > now + (period === 'daily' ? 2 : 32) * 86_400_000) throw fail('resend_usage_invalid');
    result.periods[period] = { used: row.used, limit: row.limit, resetsAt: new Date(resets).toISOString() };
  }
  return result;
}

export function parsePolicy(raw) {
  if (!Number.isInteger(raw?.warningPercent) || !Number.isInteger(raw?.criticalPercent)
    || raw.warningPercent < 1 || raw.warningPercent >= raw.criticalPercent || raw.criticalPercent > 99) throw fail('quota_policy_invalid');
  return { warning: raw.warningPercent, critical: raw.criticalPercent, exhausted: 100 };
}

export function parseSource(raw) {
  if (raw?.usageSource === 'usage_api') return { mode: 'usage_api' };
  if (raw?.usageSource !== 'records' || !Number.isSafeInteger(raw.dailyLimit) || raw.dailyLimit < 1 || raw.dailyLimit > 1000000
    || !Number.isSafeInteger(raw.monthlyLimit) || raw.monthlyLimit < 1 || raw.monthlyLimit > 100000000) throw fail('quota_source_config_invalid');
  return { mode: 'records', dailyLimit: raw.dailyLimit, monthlyLimit: raw.monthlyLimit };
}

export async function recordUsage(env, config, now, fetcher = fetch) {
  const dayStart = Math.floor(now / DAY) * DAY;
  const windowStart = now - 31 * DAY;
  const started = Date.now();
  const headers = { Authorization: `Bearer ${env.RESEND_QUOTA_API_KEY}`, 'User-Agent': 'JOJO-email-quota-monitor' };
  async function count(endpoint, inbound) {
    const seen = new Set(); let cursor; let previous = Infinity; let daily = 0; let window = 0;
    for (let i = 0; i < 40; i++) {
      if (Date.now() - started > 20_000) throw fail('resend_scan_timeout');
      if (i) await new Promise((done) => setTimeout(done, 250));
      const page = await json(`https://api.resend.com${endpoint}?limit=100${cursor ? `&after=${cursor}` : ''}`, { headers }, 'resend', fetcher);
      if (page.object !== 'list' || !Array.isArray(page.data) || page.data.length > 100 || typeof page.has_more !== 'boolean'
        || page.has_more && !page.data.length) throw fail('resend_scan_invalid');
      let boundary = false;
      for (const item of page.data) {
        const at = typeof item.created_at === 'string' ? Date.parse(item.created_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')) : NaN;
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.id ?? '') || seen.has(item.id)
          || !Number.isFinite(at) || at > now + 60000 || at > previous) throw fail('resend_scan_invalid');
        previous = at; seen.add(item.id); cursor = item.id;
        if (at < windowStart) { boundary = true; continue; }
        let recipients = 1;
        if (!inbound) {
          const cc = item.cc === null ? [] : item.cc; const bcc = item.bcc === null ? [] : item.bcc;
          if (!Array.isArray(item.to) || !item.to.length || !Array.isArray(cc) || !Array.isArray(bcc)) throw fail('resend_recipients_invalid');
          recipients = item.to.length + cc.length + bcc.length;
          if (recipients > 100 || [...item.to, ...cc, ...bcc].some((v) => typeof v !== 'string' || !v.includes('@'))) throw fail('resend_recipients_invalid');
        }
        // Include synthetic, failed and pending records conservatively. Never
        // count API rows as billing units when they have multiple recipients.
        window += recipients;
        if (at >= dayStart) daily += recipients;
      }
      if (boundary || !page.has_more) return { daily, window };
    }
    throw fail('resend_scan_incomplete');
  }
  const reads = await Promise.allSettled([count('/emails', false), count('/emails/receiving', true)]);
  for (const result of reads) if (result.status === 'rejected') throw result.reason;
  const daily = reads.reduce((n, result) => n + result.value.daily, 0);
  const observed = reads.reduce((n, result) => n + result.value.window, 0);
  // Free retention is 30 days. The missing part of a 31-day window can cross
  // two UTC quota days. Add two configured daily caps as a conservative margin.
  // This is explicitly an estimate, not Resend's billing counter or reset date.
  const reserve = 2 * config.dailyLimit;
  return { generatedAt: new Date(now).toISOString(), periods: {
    daily: { used: daily, limit: config.dailyLimit, resetsAt: new Date(dayStart + DAY).toISOString(), estimated: true },
    monthly: { used: observed + reserve, observed, reserve, windowDays: 31, limit: config.monthlyLimit, resetsAt: null, estimated: true },
  } };
}

export function signals(usage, policy) {
  return PERIODS.flatMap((period) => LEVELS.map((level) => {
    const value = usage.periods[period];
    const threshold = policy[level];
    return { slug: `${SLUG}-${period}-${level}`, period, level, threshold,
      down: value.limit !== null && value.used / value.limit * 100 >= threshold,
      ...value, remaining: value.limit === null ? null : Math.max(0, value.limit - value.used) };
  }));
}

function checkedEnv(env) {
  if (!/^re_[A-Za-z0-9_-]+$/.test(env.RESEND_QUOTA_API_KEY ?? '') || !env.HEALTHCHECKS_API_KEY?.trim()) throw fail('quota_credentials_missing');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw fail('quota_config_endpoint_invalid'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('quota_config_endpoint_invalid');
  if (!env.SUPABASE_PUBLISHABLE_KEY?.trim()) throw fail('quota_config_key_missing');
  return `${url.origin}/rest/v1/rpc/get_email_quota_monitor_config`;
}

async function checks(env, fetcher) {
  const body = await json('https://healthchecks.io/api/v3/checks/', { headers: { 'X-Api-Key': env.HEALTHCHECKS_API_KEY } }, 'healthchecks', fetcher);
  const slugs = [SLUG, ...PERIODS.flatMap((period) => LEVELS.map((level) => `${SLUG}-${period}-${level}`))];
  const result = new Map();
  for (const slug of slugs) {
    const matching = body.checks?.filter((check) => check.slug === slug);
    if (matching?.length !== 1 || !/^https:\/\/hc-ping\.com\/[a-f0-9-]{36}$/.test(matching[0].ping_url ?? '')) throw fail('healthchecks_check_missing_or_invalid');
    result.set(slug, matching[0]);
  }
  return result;
}

async function ping(check, down, payload, fetcher) {
  const result = await request(`${check.ping_url}${down ? '/fail' : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: JSON.stringify(payload),
  }, 'healthchecks', fetcher);
  // Healthchecks can return HTTP 200 for an ignored or unknown ping.
  if (result.trim() !== 'OK') throw fail('healthchecks_ping_not_accepted');
}

async function reportDecision(check, decision, summary, env, fetcher) {
  if (check.status === 'down' && decision.down && decision.resetsAt !== null) {
    // A new quota period can already exceed a threshold at the first sample.
    // Read the last decision from Healthchecks instead of relying on /tmp state.
    const uuid = check.ping_url.split('/').at(-1);
    const base = `https://healthchecks.io/api/v3/checks/${uuid}/pings/`;
    const headers = { 'X-Api-Key': env.HEALTHCHECKS_API_KEY };
    const history = await json(base, { headers }, 'healthchecks', fetcher);
    if (!Array.isArray(history.pings)) throw fail('quota_history_invalid');
    const last = history.pings.filter((item) => item.type === 'fail' && Number.isSafeInteger(item.n) && item.n > 0).sort((a, b) => b.n - a.n)[0];
    if (!last) throw fail('quota_history_missing');
    const previous = await json(`${base}${last.n}/body`, { headers }, 'healthchecks', fetcher);
    if (previous.slug !== decision.slug || !Number.isFinite(Date.parse(previous.resetsAt))) throw fail('quota_history_invalid');
    if (Date.parse(previous.generatedAt) > Date.parse(summary.generatedAt)) throw fail('resend_usage_out_of_order');
    if (Date.parse(previous.resetsAt) < Date.parse(decision.resetsAt)) {
      await ping(check, false, { message: '上一额度周期已结束', previousReset: previous.resetsAt, resetsAt: decision.resetsAt }, fetcher);
    }
  }
  await ping(check, decision.down, {
    ...summary, ...decision, message: `${decision.period === 'daily' ? '日' : '月'}邮件用量${decision.estimated ? '（估算）' : ''} ${decision.used}/${decision.limit ?? '不限'}，${decision.estimated ? '估算余量' : '剩余'} ${decision.remaining ?? '不限'}；阈值 ${decision.threshold}%；重置 ${decision.resetsAt ?? '未知，以 Resend 后台为准'}${decision.reserve ? `；最近31天记录 ${decision.observed} + 保守余量 ${decision.reserve}` : ''}`,
  }, fetcher);
}

export async function run(env, { fetcher = fetch, now = Date.now(), probe = false } = {}) {
  let registered;
  try {
    const configUrl = checkedEnv(env);
    const responses = await Promise.allSettled([
      json(configUrl, { method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: '{}' }, 'quota_config', fetcher),
      checks(env, fetcher),
    ]);
    if (responses[1].status === 'fulfilled') registered = responses[1].value;
    for (const response of responses) if (response.status === 'rejected') throw response.reason;
    const policy = parsePolicy(responses[0].value);
    const source = parseSource(responses[0].value);
    const usage = source.mode === 'records' ? await recordUsage(env, source, now, fetcher)
      : parseUsage(await json('https://api.resend.com/usage', { headers: { Authorization: `Bearer ${env.RESEND_QUOTA_API_KEY}`, 'User-Agent': 'JOJO-email-quota-monitor' } }, 'resend', fetcher), now);
    const decisions = signals(usage, policy);
    const summary = { source: source.mode === 'records' ? 'resend_records_estimate' : 'resend_usage_api', generatedAt: usage.generatedAt, observedAt: new Date(now).toISOString(), periods: usage.periods };
    if (!probe) {
      const writes = await Promise.allSettled(decisions.map((decision) => reportDecision(registered.get(decision.slug), decision, summary, env, fetcher)));
      if (writes.some((result) => result.status === 'rejected')) throw fail('quota_alert_delivery_failed');
      await ping(registered.get(SLUG), false, summary, fetcher);
    }
    return { ok: true, probe, ...summary, alerts: decisions.filter((decision) => decision.down).map(({ period, level }) => ({ period, level })) };
  } catch (error) {
    const reason = safe(error);
    // Never clear existing quota incidents when the collector cannot read usage.
    if (!probe && registered) await ping(registered.get(SLUG), true, { error: reason, observedAt: new Date(now).toISOString() }, fetcher).catch(() => {});
    return { ok: false, probe, error: reason };
  }
}

export async function handle(event, env = process.env, options = {}) {
  const now = options.now ?? Date.now();
  if (event?.mode === 'probe') return run(env, { ...options, now, probe: true });
  if (event?.mode !== 'check') {
    const at = Date.parse(event?.Time);
    if (event?.Type !== 'Timer' || event.TriggerName !== 'email-quota-half-hour' || !Number.isFinite(at)
      || at > now + 30_000 || now - at > 5 * 60_000) return { skipped: 'invalid_or_stale_timer' };
  }
  const result = await run(env, { ...options, now });
  console.log(JSON.stringify({ event: 'email_quota_check', ...result }));
  if (!result.ok) throw fail(result.error);
  return result;
}
