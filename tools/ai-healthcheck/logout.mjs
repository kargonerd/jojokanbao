import { setTimeout as delay } from 'node:timers/promises';

// Fixed probe resource bounds, independent of model generation's deadline.
const MAX_ATTEMPTS = 3;
const TOTAL_TIMEOUT_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 4_096;
const ERROR_CODES = new Set([
  'conflict', 'session_not_found', 'session_expired', 'bad_jwt', 'no_authorization',
  'unexpected_failure', 'request_timeout', 'user_not_found', 'user_banned',
  'validation_failed', 'over_request_rate_limit',
]);

function errorCode(value) {
  return ERROR_CODES.has(value) ? value : undefined;
}

function responseDetails(response) {
  const details = { httpStatus: response.status };
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  details.contentType = type === 'application/json' ? 'json'
    : type === 'text/html' ? 'html' : type === 'text/plain' ? 'text' : 'other';
  for (const header of ['sb-request-id', 'x-request-id']) {
    const value = response.headers.get(header);
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? '')) {
      details.requestId = value;
      break;
    }
  }
  const cfRay = response.headers.get('cf-ray');
  if (/^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.test(cfRay ?? '')) details.cfRay = cfRay;
  const server = response.headers.get('server')?.toLowerCase();
  if (['cloudflare', 'kong', 'nginx', 'envoy'].includes(server)) details.server = server;
  const code = errorCode(response.headers.get('x-sb-error-code'));
  if (code) details.errorCode = code;
  return details;
}

async function inspectErrorBody(response, details) {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    // Never log raw bodies or messages: a proxy can echo the request credentials.
    if (details.contentType !== 'json') return;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        details.bodyStatus = 'too_large';
        return;
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code = errorCode(body?.error_code) ?? errorCode(body?.code);
    if (code) details.errorCode ??= code;
    details.bodyStatus = 'json';
  } catch {
    details.bodyStatus = 'unreadable';
  } finally {
    // Cancellation must not extend the cleanup budget or replace its result.
    void reader.cancel().catch(() => {});
  }
}

export async function revokeMonitorSession(url, headers, fetcher = fetch) {
  const started = Date.now();
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const attempts = [];
  let reason;
  for (let index = 0; index < MAX_ATTEMPTS; index++) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
    let retryable;
    try {
      // All attempts target this exact session. Never refresh or sign in again.
      const response = await fetcher(url, { method: 'POST', headers, signal, redirect: 'manual' });
      const details = responseDetails(response);
      attempts.push(details);
      if (response.ok) {
        void response.body?.cancel().catch(() => {});
        return { ok: true, attempts, durationMs: Date.now() - started };
      }
      await inspectErrorBody(response, details);
      // A previous attempt may have revoked the session but lost its response.
      // A generic 401/403 alone does not establish successful revocation.
      if (response.status === 403 && details.errorCode === 'session_not_found') {
        details.alreadyRevoked = true;
        return { ok: true, attempts, durationMs: Date.now() - started };
      }
      reason = `monitor_logout_http_${response.status}`;
      retryable = [408, 409, 429, 500, 502, 503, 504].includes(response.status);
    } catch {
      const status = signal.aborted ? 'timeout' : 'network_error';
      attempts.push({ status });
      reason = `monitor_logout_${status}`;
      retryable = true;
    }
    if (!retryable || index === MAX_ATTEMPTS - 1 || deadline.aborted) break;
    try {
      await delay(250 * 2 ** index, undefined, { signal: deadline });
    } catch {
      break;
    }
  }
  return { ok: false, reason, attempts, durationMs: Date.now() - started };
}
