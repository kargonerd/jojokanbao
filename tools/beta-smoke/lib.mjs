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
