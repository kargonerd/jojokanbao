import { pathToFileURL } from 'node:url';
import { probe } from './probe.mjs';

export function executionIdentity(env) {
  if (env.GITHUB_SERVER_URL !== 'https://github.com' || env.GITHUB_REPOSITORY !== 'kargonerd/jojokanbao'
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('monitor_execution_identity_invalid');
  }
  return { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    run: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` };
}

function inboxUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('monitor_inbox_invalid'); }
  if (url.origin !== 'https://hc-ping.com' || url.username || url.password || url.search || url.hash
    || !/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/.test(url.pathname)) throw new Error('monitor_inbox_invalid');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}/log`;
}

export async function runHealthcheck(env, fetcher = fetch, probeFn = probe) {
  const identity = executionIdentity(env);
  const endpoint = inboxUrl(env.JOJO_EMAIL_HEALTHCHECK_PING_URL);
  let result;
  try {
    result = await probeFn(env, fetcher);
  } catch {
    // Unexpected exceptions may contain provider responses, addresses or tokens.
    const at = new Date().toISOString();
    result = { scanStart: new Date(Date.now() - 86400_000).toISOString(), scanComplete: false,
      scanError: 'probe_internal_error', messages: [], transportProbe: { outcome: 'not_run', at } };
  }
  const observation = { mail_observation: 'v1', task: 'jojo-email-delivery', ...identity,
    eventTime: new Date().toISOString(), ...result };
  const body = JSON.stringify(observation);
  if (Buffer.byteLength(body) > 65536) throw new Error('monitor_observation_too_large');
  let response;
  try {
    response = await fetcher(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error('monitor_report_failed'); }
  if (!response.ok) throw new Error('monitor_report_failed');
  return { ok: result.scanComplete && result.transportProbe.outcome !== 'failure',
    scannedMessages: result.messages.length, scanComplete: result.scanComplete,
    transport: result.transportProbe.outcome };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runHealthcheck(process.env);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const reason = /^(?:monitor_execution_identity_invalid|monitor_inbox_invalid|monitor_observation_too_large|monitor_report_failed)$/.test(error?.message ?? '')
      ? error.message : 'monitor_internal_error';
    console.error(JSON.stringify({ ok: false, reason }));
    process.exitCode = 1;
  }
}
