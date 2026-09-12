import { pathToFileURL } from 'node:url';

export const CONFIG_KEYS = {
  'auth.signup': 'auth_signup_config',
  'reader.annotations': 'reader_annotations_config',
  'ai.usage_limits': 'ai_usage_limits_config',
  'ops.email_quota': 'ops_email_quota_config',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function validConfig(key, value) {
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 16384) return false;
  switch (key) {
    case 'auth.signup': return typeof value.invitationRequired === 'boolean';
    case 'reader.annotations': return integer(value.publicMarkThreshold, 1, 100);
    case 'ai.usage_limits': return integer(value.requestsPerMinute, 1, 60)
      && integer(value.requestsPerDay, 1, 10000) && integer(value.maxRunSeconds, 30, 600);
    case 'ops.email_quota': return integer(value.warningPercent, 1, 98)
      && integer(value.criticalPercent, 2, 99) && value.warningPercent < value.criticalPercent
      && ['records', 'usage_api'].includes(value.usageSource)
      && integer(value.dailyLimit, 1, 1000000) && integer(value.monthlyLimit, 1, 100000000);
    default: return false;
  }
}

export function prepareUpdates(response, currentFlags) {
  if (!object(response) || response.errorsWhileComputingFlags !== false || !object(response.flags)) {
    throw new Error('PostHog returned incomplete flag evaluation');
  }
  if (!Array.isArray(currentFlags)) throw new Error('Invalid current configuration snapshot');
  return Object.entries(CONFIG_KEYS).map(([key, remoteKey]) => {
    const current = currentFlags.find(flag => flag.key === key);
    const remote = response.flags[remoteKey];
    if (current?.configProvider !== 'posthog' || !integer(current.revision, 1, Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Configuration migration not enabled: ${key}`);
    }
    // An off/deleted/partial flag is an error, never a request to remove a limit.
    if (remote?.enabled !== true || remote.key !== remoteKey
      || !integer(remote.metadata?.id, 1, Number.MAX_SAFE_INTEGER)
      || !integer(remote.metadata?.version, 1, Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Missing or disabled remote config: ${remoteKey}`);
    }
    let config;
    try { config = typeof remote.metadata.payload === 'string' ? JSON.parse(remote.metadata.payload) : remote.metadata.payload; }
    catch { throw new Error(`Invalid JSON payload: ${remoteKey}`); }
    if (!validConfig(key, config)) throw new Error(`Invalid parameter values: ${remoteKey}`);
    return {key, config, expectedRevision: current.revision, remoteId: remote.metadata.id, remoteVersion: remote.metadata.version};
  });
}

export async function syncRuntimeConfig(env, fetcher = fetch) {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  const operator = env.JOJO_OPERATOR_TOKEN?.trim();
  const publishable = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const host = new URL(env.POSTHOG_API_HOST || 'https://us.i.posthog.com');
  const supabase = new URL(env.VITE_SUPABASE_URL);
  if (!token || !operator || operator.length < 32 || !publishable) throw new Error('Runtime config credentials missing');
  if (!['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host.origin)
    || host.username || host.password || host.pathname !== '/' || host.search || host.hash) throw new Error('Invalid PostHog ingestion host');
  if (supabase.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(supabase.hostname)
    || supabase.username || supabase.password || supabase.port || supabase.pathname !== '/' || supabase.search || supabase.hash) throw new Error('Invalid Supabase endpoint');

  async function post(url, body, headers = {}) {
    const response = await fetcher(url, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
    if (!response.ok) throw new Error(`Configuration request failed: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Configuration response too large');
    return JSON.parse(text);
  }
  const rpc = (name, payload = {}) => post(`${supabase.origin}/rest/v1/rpc/${name}`,
    {p_operator_token: operator, ...payload}, {apikey: publishable});
  const [remote, current] = await Promise.all([
    post(`${host.origin}/flags/?v=2`, {api_key: token, distinct_id: 'jojo-runtime-config', disable_geoip: true}),
    rpc('operator_list_feature_flags'),
  ]);
  const updates = prepareUpdates(remote, current);
  // One transaction validates all values and revisions. No blind retry on a
  // timeout: a later run reads the new revisions and is idempotent by version.
  return rpc('operator_sync_posthog_configs', {p_updates: updates});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await syncRuntimeConfig(process.env);
    console.log(JSON.stringify({event: 'posthog_runtime_config_synced', checked: result.checked, changed: result.changed}));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime config sync failed');
    process.exitCode = 1;
  }
}
