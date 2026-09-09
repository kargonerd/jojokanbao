/** One secret contains the provider list; accept a legacy single URL during migration. */
export function parseProxySubscriptionUrls(value: string): string[] {
  try {
    const input = value.trim();
    const parsed: unknown = /^https?:\/\//i.test(input) ? [input] : JSON.parse(input);
    if (!Array.isArray(parsed) || parsed.length === 0
      || !parsed.every((url) => typeof url === "string" && url.trim())) throw new Error();
    return [...new Set((parsed as string[]).map((url) => url.trim()))];
  } catch { throw new Error("Proxy subscriptions must be a non-empty JSON array of URL strings"); }
}

/** GitHub masks the whole JSON secret; explicitly mask its individual values too. */
export function maskProxySubscriptionUrls(urls: readonly string[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const url of urls) {
    const escaped = url.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    process.stdout.write(`::add-mask::${escaped}\n`);
  }
}

export function selectProxySubscription(options: {
  urls: readonly string[];
  runNumber?: string | undefined;
  rotationOffset?: string | undefined;
}): { url: string; slot: number; count: number; rotationOffset: number } {
  const { urls } = options;
  if (urls.length === 0) throw new Error("Proxy subscriptions are not configured");
  const runNumber = Number(options.runNumber ?? "1");
  const rotationOffset = Number(options.rotationOffset ?? "0");
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error("Invalid proxy rotation run number");
  if (!Number.isSafeInteger(rotationOffset) || rotationOffset < 0 || rotationOffset >= urls.length) {
    throw new Error("Invalid proxy rotation offset");
  }
  // A rerun keeps the same preferred provider; successive workflow runs rotate.
  const slot = ((runNumber - 1) % urls.length + rotationOffset) % urls.length;
  try {
    if (!["https:", "http:"].includes(new URL(urls[slot]!).protocol)) throw new Error();
  } catch { throw new Error("Proxy subscription URL is invalid"); }
  return { url: urls[slot]!, slot, count: urls.length, rotationOffset };
}
