export const MAXIMUM_SUBSCRIPTION_BYTES = 20_000_000;
const FAILURE_MESSAGE = "Unable to download the configured proxy subscription";

class SubscriptionHttpError extends Error {
  constructor(readonly status: number) { super(FAILURE_MESSAGE); }
}

const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export interface SubscriptionFailure {
  kind: "http" | "network" | "timeout" | "invalid-response" | "unknown";
  httpStatus?: number;
  networkCodes: string[];
  retryable: boolean;
}

/** Only allowlisted codes, never error messages, URLs, headers or response bodies. */
export function subscriptionFailure(error: unknown): SubscriptionFailure {
  if (error instanceof SubscriptionDownloadError) return error.failure;
  if (error instanceof SubscriptionHttpError) {
    return { kind: "http", httpStatus: error.status, networkCodes: [],
      retryable: error.status === 408 || error.status === 429 || error.status >= 500 };
  }
  const codes = new Set<string>();
  const seen = new Set<object>();
  let tlsFailure = false;
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
    seen.add(value);
    const row = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof row.code === "string" && NETWORK_CODES.has(row.code)) codes.add(row.code);
    if (typeof row.code === "string" && (CERTIFICATE_CODES.has(row.code)
      || row.code.startsWith("ERR_TLS_") || row.code.startsWith("ERR_SSL_"))) tlsFailure = true;
    visit(row.cause, depth + 1);
    if (Array.isArray(row.errors)) for (const nested of row.errors.slice(0, 8)) visit(nested, depth + 1);
  };
  visit(error, 0);
  const networkCodes = [...codes].sort();
  const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
  const network = error instanceof TypeError || networkCodes.length > 0 || tlsFailure;
  return {
    kind: timeout ? "timeout" : network ? "network" : error instanceof Error && error.message === FAILURE_MESSAGE
      ? "invalid-response" : "unknown",
    networkCodes,
    retryable: (timeout || network) && !tlsFailure,
  };
}

export class SubscriptionDownloadError extends Error {
  constructor(readonly failure: SubscriptionFailure) {
    super(FAILURE_MESSAGE);
    this.name = "SubscriptionDownloadError";
  }
}

export async function downloadSubscription(url: string, options: {
  fetcher?: typeof fetch;
  delayMs?: number;
} = {}): Promise<string> {
  const delayMs = options.delayMs ?? 2_000;
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("Invalid subscription retry delay");
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let response: Response | undefined;
    try {
      response = await (options.fetcher ?? fetch)(url, {
        headers: { "user-agent": "mihomo" },
        signal: controller.signal,
      });
      if (!response.ok) throw new SubscriptionHttpError(response.status);
      if (!response.body) throw new Error(FAILURE_MESSAGE);
      const reader = response.body.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAXIMUM_SUBSCRIPTION_BYTES) throw new Error(FAILURE_MESSAGE);
          chunks.push(value);
        }
        return new TextDecoder().decode(Buffer.concat(chunks));
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      const failure = subscriptionFailure(error);
      const retrying = attempt < 3 && failure.retryable;
      process.stderr.write(`[proxy] subscription_download_failed ${JSON.stringify({
        attempt, maxAttempts: 3, ...failure, retrying,
      })}\n`);
      if (!retrying) throw new SubscriptionDownloadError(failure);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => undefined);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
  }
}
