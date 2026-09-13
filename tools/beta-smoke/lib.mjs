import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvironment(directory = '.') {
  const env = {};
  for (const name of ['.env', '.env.local']) {
    const path = resolve(directory, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...env, ...process.env };
}

export const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export async function management(env, path, options = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  // Do not echo Auth payloads, credentials, invitation codes, or SQL in errors.
  if (!response.ok) throw new Error(`Supabase management ${path}: HTTP ${response.status}`);
  return data;
}

export const query = (env, sql, readOnly = true) => management(env, 'database/query', {
  method: 'POST', body: JSON.stringify({ query: sql, read_only: readOnly }),
});

export async function getAdminKey(env) {
  const keys = await management(env, 'api-keys');
  const key = keys.find(key => key.name === 'service_role')?.api_key;
  if (!key) throw new Error('Existing service role key unavailable');
  return key;
}

export async function request(env, path, { token, key = env.VITE_SUPABASE_PUBLISHABLE_KEY, body, method } = {}) {
  const response = await fetch(`${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { apikey: key, ...(token ? { authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}

export async function readerRequest(env, path, body, token) {
  const base = env.VITE_AGENT_GATEWAY_BASE || env.EXPO_PUBLIC_READER_API_BASE || env.READER_BASE_URL;
  if (!base) throw new Error('Set READER_BASE_URL to the deployed Reader API origin');
  const response = await fetch(`${base.replace(/\/$/, '')}/api/v1/${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, ok: response.ok, data: await response.json().catch(() => null) };
}

export async function signupAuthorization(env, email, invitationCode) {
  const result = await readerRequest(env, 'account/signup-authorization', { email, invitationCode });
  if (!result.ok || typeof result.data?.authorization !== 'string') throw new Error(`Signup authorization: HTTP ${result.status}`);
  return result.data.authorization;
}

// One-shot public configuration read for the explicitly invoked hosted smoke.
export async function readPostHogConfig(env, key) {
  const host = env.POSTHOG_API_HOST || env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
  const token = env.POSTHOG_PROJECT_TOKEN || env.VITE_POSTHOG_TOKEN;
  if (!token || new URL(host).protocol !== 'https:') throw new Error('PostHog configuration missing');
  const response = await fetch(`${host.replace(/\/$/, '')}/flags/?v=2`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, distinct_id: 'jojo-public-config', person_properties: { signed_in: false } }),
  });
  if (!response.ok) throw new Error(`PostHog configuration: HTTP ${response.status}`);
  const data = await response.json();
  // /flags/ reports every flag under `flags` with the payload in `metadata.payload`.
  // The `featureFlags` / `featureFlagPayloads` pair is the older response, still
  // served by /decide/, so both shapes are accepted here.
  const current = data.flags?.[key];
  const legacy = data.featureFlags?.[key] === true
    ? { enabled: true, metadata: { payload: data.featureFlagPayloads?.[key] } }
    : null;
  const flag = current ?? legacy;
  if (flag?.enabled !== true) throw new Error(`PostHog configuration unavailable: ${key}`);
  const payload = flag.metadata?.payload;
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}
