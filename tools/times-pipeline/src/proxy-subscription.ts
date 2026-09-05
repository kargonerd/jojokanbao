const MAXIMUM_SUBSCRIPTION_BYTES = 20_000_000;
const FAILURE_MESSAGE = "Unable to download the configured proxy subscription";

class SubscriptionHttpError extends Error {
  constructor(readonly status: number) { super(FAILURE_MESSAGE); }
}

function retryable(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
    || (error instanceof SubscriptionHttpError &&
      (error.status === 408 || error.status === 429 || error.status >= 500));
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
      if (attempt >= 3 || !retryable(error)) throw new Error(FAILURE_MESSAGE);
      // Never print the URL, response, or original error: subscription URLs
      // commonly contain credentials. Do not retry configuration/size errors.
      process.stderr.write(`[proxy] subscription temporarily unavailable; retry ${attempt + 1}/3\n`);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => undefined);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
  }
}
